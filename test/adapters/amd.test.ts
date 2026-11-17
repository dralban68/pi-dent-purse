import assert from "node:assert/strict";
import { test } from "node:test";

import { amd, observeAmdHeaders, type AmdObservation } from "../../lib/adapters/amd.ts";
import type {
  AdapterDependencies,
  CommandRequest,
  TransportOutcome,
  TransportRequest,
} from "../../lib/adapter.ts";
import type { AdapterResult, AdapterSuccess, LimitWindowCapture } from "../../lib/state.ts";

/** Fixed clock: epoch milliseconds every test starts from. */
const NOW = 1_800_000_000_000;

/** The distance from an observation to the rpm window's reset, in milliseconds (Section 3). */
const RPM_WINDOW_MS = 60_000;

/** A 200 response, recorded so a request would show up; the adapter must issue none. */
function ok(): TransportOutcome {
  return { status: 200, headers: {}, body: "{}" };
}

/** One recorded harness run. */
interface Harness {
  deps: AdapterDependencies;
  signal: AbortSignal;
  requests: TransportRequest[];
  commands: CommandRequest[];
  /** Resolves the adapter's result. */
  run: () => Promise<AdapterResult>;
}

/** The dependencies of one run, with every interaction recorded; `observation` is what is stored. */
function harness(observation?: unknown): Harness {
  const requests: TransportRequest[] = [];
  const commands: CommandRequest[] = [];
  const deps: AdapterDependencies = {
    transport: async (request) => {
      requests.push(request);
      return ok();
    },
    commandRunner: async (request) => {
      commands.push(request);
      return { code: 0, stdout: "", stderr: "" };
    },
    credentials: async () => ({ apiKey: "test-key", oauth: false }),
    inventory: [],
    clock: () => NOW,
    configuration: {},
    store: { get: () => undefined, set: () => {} },
    observations: { latest: () => observation },
  };
  const controller = new AbortController();
  return {
    deps,
    signal: controller.signal,
    requests,
    commands,
    run: () => amd.run(deps, controller.signal),
  };
}

function success(result: AdapterResult): AdapterSuccess {
  if ("reason" in result) assert.fail(`expected a success, got ${result.reason}`);
  return result;
}

/** The budget window as the adapter must report it (Section 3). */
function budgetWindow(
  used: number | null,
  limit: number,
  resetsAt: number | null,
): LimitWindowCapture {
  return {
    id: "budget",
    label: "budget",
    unit: "currency",
    currency: "USD",
    used,
    limit,
    percent: null,
    resetsAt,
    windowSeconds: null,
    models: null,
    source: "headers",
  };
}

/** The rpm window as the adapter must report it (Section 3). */
function rpmWindow(used: number | null, limit: number, observedAt: number): LimitWindowCapture {
  return {
    id: "rpm",
    label: "rpm",
    unit: "requests",
    used,
    limit,
    percent: null,
    resetsAt: observedAt + RPM_WINDOW_MS,
    windowSeconds: 60,
    models: null,
    source: "headers",
  };
}

test("profile constants (Section 1)", () => {
  assert.equal(amd.id, "amd");
  assert.equal(amd.providerOrigin, "https://api.tokenlab.amd.com");
  assert.deepEqual(amd.hostAllowlist, []);
  assert.deepEqual(amd.exposedFacets, ["limits"]);
  assert.equal(amd.freshnessSeconds, 60);
});

test("observeAmdHeaders reads the six headers case-insensitively and trimmed (Section 2)", () => {
  assert.deepEqual(
    observeAmdHeaders(
      {
        "X-RateLimit-Limit-User-Budget-USD": " 20.5 ",
        "x-ratelimit-used-user-budget-usd": "5",
        "x-ratelimit-remaining-user-budget-usd": "15.5",
        "x-ratelimit-reset-user-budget-usd": "1794357600",
        "X-RateLimit-Limit-User-RPM": "60",
        "x-ratelimit-remaining-user-rpm": " 45 ",
        "content-type": "text/event-stream",
      },
      NOW,
    ),
    {
      observedAt: NOW,
      budget: { limit: 20.5, used: 5, remaining: 15.5, resetsAt: 1794357600 * 1000 },
      rpm: { limit: 60, remaining: 45 },
    },
  );
});

test("an absent, empty, or non-numeric header value is null (Section 2)", () => {
  assert.deepEqual(
    observeAmdHeaders(
      {
        "x-ratelimit-limit-user-budget-usd": "later",
        "x-ratelimit-used-user-budget-usd": "  ",
        "x-ratelimit-reset-user-budget-usd": "",
        "x-ratelimit-limit-user-rpm": "0x40",
        "x-ratelimit-remaining-user-rpm": "Infinity",
      },
      NOW,
    ),
    {
      observedAt: NOW,
      budget: { limit: null, used: null, remaining: null, resetsAt: null },
      rpm: { limit: 64, remaining: null },
    },
  );
});

test("observeAmdHeaders needs a limit header (Section 2)", () => {
  assert.equal(
    observeAmdHeaders(
      {
        "x-ratelimit-used-user-budget-usd": "5",
        "x-ratelimit-remaining-user-budget-usd": "15",
        "x-ratelimit-reset-user-budget-usd": "1794357600",
        "x-ratelimit-remaining-user-rpm": "45",
      },
      NOW,
    ),
    undefined,
  );
  assert.deepEqual(observeAmdHeaders({ "X-RateLimit-Limit-User-RPM": "" }, NOW), {
    observedAt: NOW,
    budget: { limit: null, used: null, remaining: null, resetsAt: null },
    rpm: { limit: null, remaining: null },
  });
});

const OBSERVED: AmdObservation = {
  observedAt: NOW,
  budget: { limit: 20, used: 5, remaining: 15, resetsAt: NOW + 86_400_000 },
  rpm: { limit: 60, remaining: 45 },
};

test("the observation yields the budget and rpm windows, captured when it was observed (Section 3)", async () => {
  const harnessed = harness(OBSERVED);

  const result = success(await harnessed.run());

  assert.deepEqual(result, {
    facets: {
      limits: {
        state: "known",
        value: [budgetWindow(5, 20, NOW + 86_400_000), rpmWindow(15, 60, NOW)],
      },
    },
    capturedAt: NOW,
  });
  assert.equal(harnessed.requests.length, 0);
  assert.equal(harnessed.commands.length, 0);
});

test("a missing used falls back to limit − remaining (Section 3)", async () => {
  const harnessed = harness({
    observedAt: NOW - 5000,
    budget: { limit: 20, used: null, remaining: 12.5, resetsAt: null },
    rpm: { limit: 60, remaining: 60 },
  });

  const result = success(await harnessed.run());

  assert.deepEqual(result.facets.limits, {
    state: "known",
    value: [budgetWindow(7.5, 20, null), rpmWindow(0, 60, NOW - 5000)],
  });
  assert.equal(result.capturedAt, NOW - 5000);
});

test("used stays null without the captured usage or both limit and remaining (Section 3)", async () => {
  const harnessed = harness({
    observedAt: NOW,
    budget: { limit: 20, used: null, remaining: null, resetsAt: null },
    rpm: { limit: null, remaining: 30 },
  });

  const result = success(await harnessed.run());

  assert.deepEqual(result.facets.limits, {
    state: "known",
    value: [budgetWindow(null, 20, null)],
  });
});

test("a window whose limit is null is omitted (Section 3)", async () => {
  const cases: readonly (readonly [AmdObservation, readonly LimitWindowCapture[]])[] = [
    [
      {
        observedAt: NOW,
        budget: { limit: null, used: 5, remaining: 15, resetsAt: null },
        rpm: { limit: 60, remaining: 45 },
      },
      [rpmWindow(15, 60, NOW)],
    ],
    [
      {
        observedAt: NOW,
        budget: { limit: 20, used: 5, remaining: 15, resetsAt: null },
        rpm: { limit: null, remaining: 45 },
      },
      [budgetWindow(5, 20, null)],
    ],
  ];

  for (const [observation, expected] of cases) {
    const result = success(await harness(observation).run());
    assert.deepEqual(result.facets.limits, { state: "known", value: expected });
  }
});

test("an observation with neither limit is not-observed (Section 3)", async () => {
  const harnessed = harness({
    observedAt: NOW,
    budget: { limit: null, used: 5, remaining: 15, resetsAt: null },
    rpm: { limit: null, remaining: 45 },
  });

  assert.deepEqual(await harnessed.run(), {
    facets: { limits: { state: "unavailable", reason: "not-observed" } },
    capturedAt: NOW,
  });
});

test("without an observation limits is not-observed (Section 3)", async () => {
  const harnessed = harness();

  assert.deepEqual(await harnessed.run(), {
    facets: { limits: { state: "unavailable", reason: "not-observed" } },
  });
  assert.equal(harnessed.requests.length, 0);
  assert.equal(harnessed.commands.length, 0);
});
