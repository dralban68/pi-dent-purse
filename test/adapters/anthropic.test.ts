import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  anthropic,
  observeHeaders,
  type HeaderObservation,
  type ObservedWindow,
} from "../../lib/adapters/anthropic.ts";
import type {
  AdapterDependencies,
  CommandRequest,
  InventoryModel,
  CheckedCredentials,
  TransportOutcome,
  TransportRequest,
} from "../../lib/adapter.ts";
import type { AdapterResult, LimitWindowCapture, ReasonCode } from "../../lib/state.ts";

/** Fixed clock: epoch milliseconds every test starts from. */
const NOW = 1_800_000_000_000;

const PROVIDER_ORIGIN = "https://api.anthropic.com";

const OPUS_ID = "claude-opus-4-5";
const FABLE_ID = "claude-fable-5-2";
const SONNET_ID = "claude-sonnet-4-5";
const HAIKU_ID = "claude-haiku-4-1";

/** The largest observation age the fallback may use, in milliseconds. */
const OBSERVATION_MAX_AGE = 3600 * 1000;

const FIVE_HOUR_RESET = Date.parse("2026-11-11T08:00:00.096186+00:00");
const WEEKLY_RESET = Date.parse("2026-11-15T04:00:00.512341+00:00");

const OAUTH: CheckedCredentials = { apiKey: "token-1", oauth: true };

/** An inventory model of the provider. */
function model(id: string, baseUrl: string = PROVIDER_ORIGIN): InventoryModel {
  return { id, baseUrl, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

const INVENTORY: readonly InventoryModel[] = [
  model(FABLE_ID),
  model(OPUS_ID),
  model(SONNET_ID),
  model(HAIKU_ID),
];

/** A 200 response whose body is `body`. */
function ok(body: string): TransportOutcome {
  return { status: 200, headers: {}, body };
}

/** A 200 response whose body is `value` as JSON. */
function json(value: unknown): TransportOutcome {
  return ok(JSON.stringify(value));
}

/** A transport failure with `reason`, and `retryAfter` when given. */
function failed(reason: ReasonCode, retryAfter?: number): TransportOutcome {
  return retryAfter === undefined ? { reason } : { reason, retryAfter };
}

/** One recorded harness run. */
interface Harness {
  deps: AdapterDependencies;
  /** The refresh's abort signal, also the one the adapter must pass to the transport. */
  signal: AbortSignal;
  requests: TransportRequest[];
  commands: CommandRequest[];
  /** Resolves the adapter's result. */
  run: () => Promise<AdapterResult>;
}

/** What the harness's fakes answer with. */
interface Options {
  /** Answers of `credentials`, one per call; the last one repeats. */
  credentials?: readonly (CheckedCredentials | undefined)[];
  /** Transport outcomes, one per request; an `Error` is thrown instead. */
  outcomes?: readonly (TransportOutcome | Error)[];
  inventory?: readonly InventoryModel[];
  observation?: HeaderObservation;
  now?: number;
}

/** The dependencies of one run, with every interaction recorded. */
function harness(options: Options = {}): Harness {
  const requests: TransportRequest[] = [];
  const commands: CommandRequest[] = [];
  const outcomes = options.outcomes ?? [ok("{}")];
  const credentialAnswers = options.credentials ?? [OAUTH];
  let outcomeIndex = 0;
  let credentialIndex = 0;

  const deps: AdapterDependencies = {
    transport: async (request) => {
      requests.push(request);
      const outcome = outcomes[outcomeIndex] ?? failed("network");
      outcomeIndex += 1;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    commandRunner: async (request) => {
      commands.push(request);
      return { code: 0, stdout: "", stderr: "" };
    },
    credentials: async () => {
      const answer = credentialAnswers[Math.min(credentialIndex, credentialAnswers.length - 1)];
      credentialIndex += 1;
      return answer;
    },
    inventory: options.inventory ?? INVENTORY,
    clock: () => options.now ?? NOW,
    configuration: {},
    store: { get: () => undefined, set: () => {} },
    observations: { latest: () => options.observation },
  };
  const controller = new AbortController();

  return {
    deps,
    signal: controller.signal,
    requests,
    commands,
    run: () => anthropic.run(deps, controller.signal),
  };
}

/** The body of a fixture under `test/fixtures/anthropic/`. */
function fixture(name: string): Promise<string> {
  return readFile(new URL(`../fixtures/anthropic/${name}`, import.meta.url), "utf8");
}

/** One endpoint window, as the adapter must report it. */
function window(
  id: string,
  label: string,
  percent: number | null,
  resetsAt: number | null,
  windowSeconds: number,
  models: string[] | null,
  source: LimitWindowCapture["source"] = "endpoint",
): LimitWindowCapture {
  return {
    id,
    label,
    unit: "percent",
    used: null,
    limit: null,
    percent,
    resetsAt,
    windowSeconds,
    models,
    source,
  };
}

test("exposes the spec's constants (adapter-anthropic.md Section 1)", () => {
  assert.equal(anthropic.id, "anthropic");
  assert.equal(anthropic.providerOrigin, "https://api.anthropic.com");
  assert.deepEqual(anthropic.hostAllowlist, ["https://api.anthropic.com"]);
  assert.deepEqual(anthropic.exposedFacets, ["limits"]);
  assert.equal(anthropic.freshnessSeconds, 120);
});

test("requests the usage endpoint once with the OAuth headers (Section 3)", async () => {
  const harnessed = harness({ outcomes: [ok("{}")] });

  await harnessed.run();

  assert.equal(harnessed.requests.length, 1);
  assert.deepEqual(harnessed.requests[0], {
    url: "https://api.anthropic.com/api/oauth/usage",
    headers: {
      authorization: "Bearer token-1",
      "anthropic-beta": "oauth-2025-04-20",
    },
    bodyCap: 64 * 1024,
    signal: harnessed.signal,
  });
  assert.equal(harnessed.commands.length, 0);
});

test("maps the provider-wide windows and each separately measured model group (Section 3)", async () => {
  const harnessed = harness({ outcomes: [ok(await fixture("usage-subscription.json"))] });

  const result = await harnessed.run();

  assert.deepEqual(result, {
    facets: {
      limits: {
        state: "known",
        value: [
          window("five-hour", "5h", 42.5, FIVE_HOUR_RESET, 18000, null),
          window("weekly", "7d", 68, WEEKLY_RESET, 604800, null),
          window("weekly-opus", "7d opus", 91.5, WEEKLY_RESET, 604800, [OPUS_ID]),
        ],
      },
    },
  });
});

test("maps a separately measured weekly window from limits (Section 3.1)", async () => {
  const harnessed = harness({ outcomes: [ok(await fixture("usage-scoped-limits.json"))] });

  const result = await harnessed.run();

  const fableReset = Date.parse("2026-11-15T12:59:59.778419+00:00");
  assert.deepEqual(result, {
    facets: {
      limits: {
        state: "known",
        value: [
          window(
            "five-hour",
            "5h",
            46,
            Date.parse("2026-11-13T09:49:59.778270+00:00"),
            18000,
            null,
          ),
          window("weekly", "7d", 62, Date.parse("2026-11-15T12:59:59.778291+00:00"), 604800, null),
          window("weekly-fable", "7d fable", 100, fableReset, 604800, [FABLE_ID]),
        ],
      },
    },
  });
});

test("a limits element yields no window without a scope model display name (Section 3.1)", async () => {
  const harnessed = harness({
    outcomes: [
      json({
        five_hour: { utilization: 5 },
        limits: [
          { kind: "weekly_scoped", percent: 50, scope: { model: { display_name: " \u0000 " } } },
          { kind: "weekly_scoped", percent: 50 },
          { kind: "weekly_scoped", percent: 50, scope: { model: null } },
        ],
      }),
    ],
  });

  const result = await harnessed.run();

  assert.deepEqual(result, {
    facets: {
      limits: { state: "known", value: [window("five-hour", "5h", 5, null, 18000, null)] },
    },
  });
});

test("only the first limits element of a model group counts, and names compare lowercased (Section 3.1)", async () => {
  const harnessed = harness({
    outcomes: [
      json({
        five_hour: { utilization: 5 },
        limits: [
          {
            kind: "weekly_scoped",
            percent: 40,
            resets_at: "2026-11-15T04:00:00.512341+00:00",
            scope: { model: { display_name: "FABLE" } },
          },
          { kind: "weekly_scoped", percent: 90, scope: { model: { display_name: "fable" } } },
        ],
      }),
    ],
  });

  const result = await harnessed.run();

  assert.deepEqual(result, {
    facets: {
      limits: {
        state: "known",
        value: [
          window("five-hour", "5h", 5, null, 18000, null),
          window("weekly-fable", "7d fable", 40, WEEKLY_RESET, 604800, [FABLE_ID]),
        ],
      },
    },
  });
});

test("a null or absent scoped window yields no window (Section 3)", async () => {
  const harnessed = harness({ outcomes: [ok(await fixture("usage-scoped-null.json"))] });

  const result = await harnessed.run();

  assert.deepEqual(result, {
    facets: {
      limits: {
        state: "known",
        value: [
          window(
            "five-hour",
            "5h",
            10,
            Date.parse("2026-11-11T10:30:00.000000+00:00"),
            18000,
            null,
          ),
        ],
      },
    },
  });
});

test("a scoped window with an empty model list yields no window (Section 3.1)", async () => {
  const harnessed = harness({
    inventory: [model(HAIKU_ID)],
    outcomes: [ok(await fixture("usage-subscription.json"))],
  });

  const result = await harnessed.run();

  assert.deepEqual(result, {
    facets: {
      limits: {
        state: "known",
        value: [
          window("five-hour", "5h", 42.5, FIVE_HOUR_RESET, 18000, null),
          window("weekly", "7d", 68, WEEKLY_RESET, 604800, null),
        ],
      },
    },
  });
});

test("a first element of a model group with no inventory model blocks later ones (Section 3.1)", async () => {
  const harnessed = harness({
    inventory: [model(HAIKU_ID)],
    outcomes: [
      json({
        five_hour: { utilization: 5 },
        limits: [
          { kind: "weekly_scoped", percent: 40, scope: { model: { display_name: "Fable" } } },
          { kind: "weekly_scoped", percent: 90, scope: { model: { display_name: "fable" } } },
        ],
      }),
    ],
  });

  const result = await harnessed.run();

  assert.deepEqual(result, {
    facets: {
      limits: { state: "known", value: [window("five-hour", "5h", 5, null, 18000, null)] },
    },
  });
});

test("no five_hour or seven_day window is an unavailable limits facet, not a failure", async () => {
  const harnessed = harness({ outcomes: [ok(await fixture("usage-no-windows.json"))] });

  const result = await harnessed.run();

  assert.deepEqual(result, {
    facets: { limits: { state: "unavailable", reason: "empty-response" } },
  });
});

test("non-numeric utilization and unparsable resets_at are null (Section 3)", async () => {
  const harnessed = harness({
    outcomes: [
      json({
        five_hour: { utilization: "42.5", resets_at: 1762800000000 },
        seven_day: { utilization: 10, resets_at: "not a timestamp" },
      }),
    ],
  });

  const result = await harnessed.run();

  assert.deepEqual(result, {
    facets: {
      limits: {
        state: "known",
        value: [
          window("five-hour", "5h", null, null, 18000, null),
          window("weekly", "7d", 10, null, 604800, null),
        ],
      },
    },
  });
});

test("no credentials is a whole failure and sends nothing (Section 2)", async () => {
  const harnessed = harness({ credentials: [undefined] });

  assert.deepEqual(await harnessed.run(), { reason: "no-credentials" });
  assert.equal(harnessed.requests.length, 0);
});

test("a non-OAuth credential is unsupported-auth, and sends nothing (Section 2)", async () => {
  const harnessed = harness({ credentials: [{ apiKey: "token-1", oauth: false }] });

  assert.deepEqual(await harnessed.run(), { reason: "unsupported-auth" });
  assert.equal(harnessed.requests.length, 0);
});

test("http-401 resolves credentials once and repeats with a differing token (Section 3)", async () => {
  const harnessed = harness({
    credentials: [
      { apiKey: "token-1", oauth: true },
      { apiKey: "token-2", oauth: true },
    ],
    outcomes: [failed("http-401", undefined), json({ seven_day: { utilization: 20 } })],
  });

  const result = await harnessed.run();

  assert.equal(harnessed.requests.length, 2);
  assert.equal(harnessed.requests[1]?.headers?.["authorization"], "Bearer token-2");
  assert.deepEqual(result, {
    facets: {
      limits: { state: "known", value: [window("weekly", "7d", 20, null, 604800, null)] },
    },
    firstFailure: { reason: "http-401" },
  });
});

test("a repeated identical token is not retried and the failure stands (Section 3)", async () => {
  const harnessed = harness({ outcomes: [failed("http-401")] });

  assert.deepEqual(await harnessed.run(), { reason: "http-401" });
  assert.equal(harnessed.requests.length, 1);
});

test("absent renewed credentials leave the http-401 standing (Section 3)", async () => {
  const harnessed = harness({
    credentials: [OAUTH, undefined],
    outcomes: [failed("http-401")],
  });

  assert.deepEqual(await harnessed.run(), { reason: "http-401" });
  assert.equal(harnessed.requests.length, 1);
});

test("a failing repeat leaves the http-401 standing (Section 3)", async () => {
  for (const outcome of [failed("http-403"), failed("http-429", 12), failed("network")]) {
    const harnessed = harness({
      credentials: [
        { apiKey: "token-1", oauth: true },
        { apiKey: "token-2", oauth: true },
      ],
      outcomes: [failed("http-401"), outcome],
    });

    assert.deepEqual(await harnessed.run(), { reason: "http-401" });
    assert.equal(harnessed.requests.length, 2);
  }
});

test("a repeat with an unparsable body leaves the http-401 standing (Section 3)", async () => {
  const harnessed = harness({
    credentials: [
      { apiKey: "token-1", oauth: true },
      { apiKey: "token-2", oauth: true },
    ],
    outcomes: [failed("http-401"), ok(await fixture("usage-html-error.html"))],
  });

  assert.deepEqual(await harnessed.run(), { reason: "http-401" });
  assert.equal(harnessed.requests.length, 2);
});

test("a 401 is retried at most once (Section 3)", async () => {
  const harnessed = harness({
    credentials: [
      { apiKey: "token-1", oauth: true },
      { apiKey: "token-2", oauth: true },
      { apiKey: "token-3", oauth: true },
    ],
    outcomes: [failed("http-401"), failed("http-401"), json({})],
  });

  assert.deepEqual(await harnessed.run(), { reason: "http-401" });
  assert.equal(harnessed.requests.length, 2);
});

test("other request failures are whole failures without a retry (Section 3)", async () => {
  const cases: readonly (readonly [TransportOutcome, AdapterResult])[] = [
    [failed("http-403"), { reason: "http-403" }],
    [failed("http-429", 42), { reason: "http-429", retryAfter: 42 }],
    [failed("http-error"), { reason: "http-error" }],
    [{ status: 302, reason: "redirect" }, { reason: "redirect" }],
    [{ status: 200, reason: "response-too-large" }, { reason: "response-too-large" }],
    [{ reason: "timeout" }, { reason: "timeout" }],
    [{ reason: "network" }, { reason: "network" }],
    [{ reason: "deadline" }, { reason: "deadline" }],
  ];

  for (const [outcome, expected] of cases) {
    const harnessed = harness({ outcomes: [outcome] });

    assert.deepEqual(await harnessed.run(), expected);
    assert.equal(harnessed.requests.length, 1);
  }
});

test("a body that is not a JSON object is bad-response (Section 4)", async () => {
  const bodies = [
    await fixture("usage-html-error.html"),
    await fixture("usage-empty.txt"),
    "[]",
    "null",
    "42",
    '"a string"',
    '{"five_hour": ',
  ];

  for (const body of bodies) {
    const harnessed = harness({ outcomes: [ok(body)] });

    assert.deepEqual(await harnessed.run(), { reason: "bad-response" });
    assert.equal(harnessed.requests.length, 1);
  }
});

test("a throwing transport is an internal failure (Section 2)", async () => {
  const harnessed = harness({ outcomes: [new Error("transport bug")] });

  assert.deepEqual(await harnessed.run(), { reason: "internal" });
});

/** One header observation as the host records it. */
function observation(
  observedAt: number,
  fiveHour: ObservedWindow,
  weekly: ObservedWindow,
): HeaderObservation {
  return { observedAt, fiveHour, weekly };
}

test("a failed request falls back to a header observation younger than 3600 s (Section 4)", async () => {
  const observed = observation(
    NOW - 1000,
    { percent: 42.5, resetsAt: FIVE_HOUR_RESET },
    { percent: null, resetsAt: null },
  );
  const harnessed = harness({ outcomes: [failed("http-error")], observation: observed });

  const result = await harnessed.run();

  assert.equal(harnessed.commands.length, 0);
  assert.deepEqual(result, {
    facets: {
      limits: {
        state: "known",
        value: [
          window("five-hour", "5h", 42.5, FIVE_HOUR_RESET, 18000, null, "headers"),
          window("weekly", "7d", null, null, 604800, null, "headers"),
        ],
      },
    },
    firstFailure: { reason: "http-error" },
    capturedAt: NOW - 1000,
    captureReason: "http-error",
  });
});

test("the fallback accepts an observation 3599999 ms old (Section 4)", async () => {
  const harnessed = harness({
    outcomes: [failed("network")],
    observation: observation(
      NOW - 3_599_999,
      { percent: 1, resetsAt: null },
      { percent: 2, resetsAt: null },
    ),
  });

  const result = await harnessed.run();

  assert.deepEqual(result, {
    facets: {
      limits: {
        state: "known",
        value: [
          window("five-hour", "5h", 1, null, 18000, null, "headers"),
          window("weekly", "7d", 2, null, 604800, null, "headers"),
        ],
      },
    },
    firstFailure: { reason: "network" },
    capturedAt: NOW - 3_599_999,
    captureReason: "network",
  });
});

test("the fallback rejects an observation exactly 3600 s old (Section 4)", async () => {
  const harnessed = harness({
    outcomes: [failed("network")],
    observation: observation(
      NOW - OBSERVATION_MAX_AGE,
      { percent: 1, resetsAt: null },
      { percent: 2, resetsAt: null },
    ),
  });

  assert.deepEqual(await harnessed.run(), { reason: "network" });
});

test("the fallback covers a bad-response failure too (Section 4)", async () => {
  const harnessed = harness({
    outcomes: [ok(await fixture("usage-html-error.html"))],
    observation: observation(
      NOW - 500,
      { percent: 5, resetsAt: null },
      { percent: 6, resetsAt: null },
    ),
  });

  const result = await harnessed.run();

  assert.deepEqual(result, {
    facets: {
      limits: {
        state: "known",
        value: [
          window("five-hour", "5h", 5, null, 18000, null, "headers"),
          window("weekly", "7d", 6, null, 604800, null, "headers"),
        ],
      },
    },
    firstFailure: { reason: "bad-response" },
    capturedAt: NOW - 500,
    captureReason: "bad-response",
  });
});

test("the fallback reports the standing http-401 failure (Section 4)", async () => {
  const harnessed = harness({
    outcomes: [failed("http-401")],
    observation: observation(
      NOW - 500,
      { percent: 5, resetsAt: null },
      { percent: 6, resetsAt: null },
    ),
  });

  const result = await harnessed.run();

  assert.deepEqual(result, {
    facets: {
      limits: {
        state: "known",
        value: [
          window("five-hour", "5h", 5, null, 18000, null, "headers"),
          window("weekly", "7d", 6, null, 604800, null, "headers"),
        ],
      },
    },
    firstFailure: { reason: "http-401" },
    capturedAt: NOW - 500,
    captureReason: "http-401",
  });
});

test("an internal failure stands even with a fresh observation (Section 4)", async () => {
  const harnessed = harness({
    outcomes: [failed("internal")],
    observation: observation(
      NOW - 500,
      { percent: 5, resetsAt: null },
      { percent: 6, resetsAt: null },
    ),
  });

  assert.deepEqual(await harnessed.run(), { reason: "internal" });
});

test("without an observation the failure stands as the whole result (Section 4)", async () => {
  const harnessed = harness({ outcomes: [failed("http-error")] });

  assert.deepEqual(await harnessed.run(), { reason: "http-error" });
});

test("credential failures do not use the fallback (Sections 2–3)", async () => {
  const observed = observation(
    NOW - 500,
    { percent: 5, resetsAt: null },
    { percent: 6, resetsAt: null },
  );

  const cases: readonly (readonly [readonly (CheckedCredentials | undefined)[], ReasonCode])[] = [
    [[{ apiKey: "token-1", oauth: false }], "unsupported-auth"],
    [[undefined], "no-credentials"],
  ];

  for (const [credentials, reason] of cases) {
    const harnessed = harness({ credentials, observation: observed });

    assert.deepEqual(await harnessed.run(), { reason });
    assert.equal(harnessed.requests.length, 0);
  }
});

test("the fallback after a failed repeat counts both requests (Sections 3–4)", async () => {
  const harnessed = harness({
    credentials: [
      { apiKey: "token-1", oauth: true },
      { apiKey: "token-2", oauth: true },
    ],
    outcomes: [failed("http-401"), failed("http-error")],
    observation: observation(
      NOW - 500,
      { percent: 5, resetsAt: null },
      { percent: 6, resetsAt: null },
    ),
  });

  const result = await harnessed.run();

  assert.equal(harnessed.requests.length, 2);
  assert.deepEqual(result, {
    facets: {
      limits: {
        state: "known",
        value: [
          window("five-hour", "5h", 5, null, 18000, null, "headers"),
          window("weekly", "7d", 6, null, 604800, null, "headers"),
        ],
      },
    },
    firstFailure: { reason: "http-401" },
    capturedAt: NOW - 500,
    captureReason: "http-401",
  });
});

test("a successful endpoint response never carries capturedAt or captureReason (Section 3)", async () => {
  const harnessed = harness({
    outcomes: [json({ five_hour: { utilization: 3 } })],
    observation: observation(
      NOW - 500,
      { percent: 5, resetsAt: null },
      { percent: 6, resetsAt: null },
    ),
  });

  const result = await harnessed.run();

  assert.deepEqual(result, {
    facets: {
      limits: { state: "known", value: [window("five-hour", "5h", 3, null, 18000, null)] },
    },
  });
  assert.equal("capturedAt" in result, false);
  assert.equal("captureReason" in result, false);
});

test("observeHeaders reads the four unified headers (Section 4)", () => {
  assert.deepEqual(
    observeHeaders(
      {
        "anthropic-ratelimit-unified-5h-utilization": "0.42",
        "anthropic-ratelimit-unified-5h-reset": "1794357600",
        "Anthropic-RateLimit-Unified-7d-Utilization": " 0.1 ",
        "anthropic-ratelimit-unified-7d-reset": "later",
        "content-type": "text/event-stream",
      },
      NOW,
    ),
    {
      observedAt: NOW,
      fiveHour: { percent: 42, resetsAt: 1794357600 * 1000 },
      weekly: { percent: 10, resetsAt: null },
    },
  );
});

test("observeHeaders needs a utilization header (Section 4)", () => {
  assert.equal(
    observeHeaders({ "anthropic-ratelimit-unified-5h-reset": "1794357600" }, NOW),
    undefined,
  );
  assert.deepEqual(observeHeaders({ "anthropic-ratelimit-unified-7d-utilization": "" }, NOW), {
    observedAt: NOW,
    fiveHour: { percent: null, resetsAt: null },
    weekly: { percent: null, resetsAt: null },
  });
});
