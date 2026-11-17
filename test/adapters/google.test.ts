import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type {
  AdapterDependencies,
  CommandOutcome,
  CommandRequest,
  InventoryModel,
  CheckedCredentials,
  Store,
  TransportOutcome,
  TransportRequest,
} from "../../lib/adapter.ts";
import { google } from "../../lib/adapters/google.ts";
import type {
  AdapterFailure,
  AdapterResult,
  AdapterSuccess,
  LimitWindowCapture,
} from "../../lib/state.ts";

/** 2026-11-11T05:32:52Z; 2026-11-10T21:32:52 in America/Los_Angeles (PST, UTC−8). */
const NOW = Date.UTC(2026, 10, 11, 5, 32, 52);
/** The next midnight in America/Los_Angeles. */
const DAY_END = Date.UTC(2026, 10, 11, 8, 0, 0);
/** The distance from the latest midnight in whole seconds. */
const USAGE_ALIGNMENT = "77572s";
/** The latest and the next month start in America/Los_Angeles (PDT, then PST). */
const MONTH_START = "2026-11-01T07:00:00.000Z";
const MONTH_END = Date.UTC(2026, 11, 1, 8, 0, 0);
/** The distance from the month start in whole seconds. */
const MONTH_ALIGNMENT = "858772s";
const OUTPUT_TYPE = "generativelanguage.googleapis.com/generate_content_usage_output_token_count";
const PAID_INPUT = "generate_content_paid_tier_input_token_count";

const API_KEY = "fixture-api-key-0000";
const TOKEN = fixture("access-token.txt").trim();
const PROJECT = "123456789012";

const QUOTA_PREFIX = "generativelanguage.googleapis.com/quota/";
const DESCRIPTOR_FILTER = `metric.type = starts_with("${QUOTA_PREFIX}")`;

function limitType(family: string): string {
  return `${QUOTA_PREFIX}${family}/limit`;
}

function limitFilter(family: string): string {
  return `metric.type = "${limitType(family)}"`;
}

function usageFilter(family: string): string {
  return `metric.type = "${QUOTA_PREFIX}${family}/usage"`;
}

const FREE_REQUESTS = "generate_content_free_tier_requests";
const FREE_TOKENS = "generate_content_free_tier_input_token_count";

const MODELS: readonly InventoryModel[] = [
  {
    id: "gemini-2.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    cost: { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0 },
  },
];

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/google/${name}`, import.meta.url), "utf8");
}

/** Mirrors the transport's status map (adapter-contract.md Section 4). */
function response(status: number, body: string): TransportOutcome {
  if (status >= 200 && status <= 299) return { status, headers: {}, body };
  const reason =
    status === 401
      ? "http-401"
      : status === 403
        ? "http-403"
        : status === 429
          ? "http-429"
          : "http-error";
  return { reason, status };
}

function jsonResponse(body: unknown): TransportOutcome {
  return response(200, JSON.stringify(body));
}

/** The digest Section 3 keys the store item by. */
function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

class FakeStore implements Store {
  readonly values = new Map<string, { value: unknown; ttlSeconds: number | undefined }>();

  get(key: string): unknown {
    return this.values.get(key)?.value;
  }

  set(key: string, value: unknown, ttlSeconds?: number): void {
    this.values.set(key, { value, ttlSeconds });
  }

  keys(): string[] {
    return [...this.values.keys()];
  }
}

interface Routes {
  lookup?: (url: URL) => TransportOutcome;
  metadata?: (url: URL) => TransportOutcome;
  /** The metric types the descriptors list; by default those of the fixtures. */
  types?: readonly string[];
  descriptors?: (url: URL) => TransportOutcome;
  /** Called per limit type request. */
  limits?: (url: URL) => TransportOutcome;
  /** Called per usage request. */
  usage?: (url: URL) => TransportOutcome;
  /** Called per month-to-date request (Section 7); by default no series. */
  spend?: (url: URL, type: string) => TransportOutcome;
}

function typesOf(body: unknown): string[] {
  const types: string[] = [];
  for (const series of (body as { timeSeries?: unknown[] }).timeSeries ?? []) {
    const type = (series as { metric?: { type?: unknown } } | null)?.metric?.type;
    if (typeof type === "string" && !types.includes(type)) types.push(type);
  }
  return types;
}

/** Limit routes serving the series of `body` by the requested metric type, and their types. */
function seriesRoutes(body: { timeSeries: unknown[] }): Pick<Routes, "limits" | "types"> {
  return {
    types: typesOf(body),
    limits: (url) => {
      const requested = /^metric\.type = "(.*)"$/.exec(url.searchParams.get("filter") ?? "")?.[1];
      const timeSeries = body.timeSeries.filter(
        (series) => (series as { metric?: { type?: unknown } } | null)?.metric?.type === requested,
      );
      return jsonResponse({ timeSeries });
    },
  };
}

/** The recorded fixture responses of a healthy account, with per-endpoint overrides. */
function recordingTransport(routes: Routes, limitsFixture = "time-series-paid.json") {
  return async (request: TransportRequest): Promise<TransportOutcome> => {
    const url = new URL(request.url);
    if (url.origin === "https://apikeys.googleapis.com") {
      return routes.lookup?.(url) ?? response(200, fixture("key-lookup.json"));
    }
    if (url.origin === "https://cloudquotas.googleapis.com") {
      if (routes.metadata !== undefined) return routes.metadata(url);
      return response(
        200,
        fixture(
          url.searchParams.get("pageToken") === "fixture-page-2"
            ? "quota-infos-page2.json"
            : "quota-infos-page1.json",
        ),
      );
    }
    if (url.pathname.endsWith("/metricDescriptors")) {
      if (routes.descriptors !== undefined) return routes.descriptors(url);
      const types = routes.types ?? [
        ...typesOf(JSON.parse(fixture(limitsFixture))),
        ...typesOf(JSON.parse(fixture("time-series-free-usage.json"))),
      ];
      return jsonResponse({ metricDescriptors: types.map((type) => ({ type })) });
    }
    const requested = /^metric\.type = "(.*)"$/.exec(url.searchParams.get("filter") ?? "")?.[1];
    if (url.searchParams.get("interval.startTime") === MONTH_START) {
      return routes.spend?.(url, requested ?? "") ?? jsonResponse({ timeSeries: [] });
    }
    if (requested?.endsWith("/usage") === true) {
      return routes.usage?.(url) ?? servedFrom("time-series-free-usage.json", requested);
    }
    return routes.limits?.(url) ?? servedFrom(limitsFixture, requested);
  };
}

/** The fixture's series of one metric type. */
function servedFrom(name: string, type: string | undefined): TransportOutcome {
  const body = JSON.parse(fixture(name)) as { timeSeries: unknown[] };
  return jsonResponse({
    timeSeries: body.timeSeries.filter(
      (series) => (series as { metric: { type: string } }).metric.type === type,
    ),
  });
}

interface Harness {
  deps: AdapterDependencies;
  requests: TransportRequest[];
  commands: CommandRequest[];
  store: FakeStore;
}

interface HarnessOptions {
  credentials?: () => Promise<CheckedCredentials | undefined>;
  command?: (request: CommandRequest) => Promise<CommandOutcome>;
  routes?: Routes;
  store?: FakeStore;
  project?: string;
  prices?: AdapterDependencies["configuration"]["prices"];
  inventory?: readonly InventoryModel[];
  limitsFixture?: string;
}

function harness(options: HarnessOptions = {}): Harness {
  const requests: TransportRequest[] = [];
  const commands: CommandRequest[] = [];
  const store = options.store ?? new FakeStore();
  const transport = recordingTransport(options.routes ?? {}, options.limitsFixture);
  const deps: AdapterDependencies = {
    transport: async (request) => {
      requests.push(request);
      return transport(request);
    },
    commandRunner: async (request) => {
      commands.push(request);
      return (
        options.command ??
        (async () => ({
          code: 0,
          stdout: fixture("access-token.txt"),
          stderr: "",
        }))
      )(request);
    },
    credentials: options.credentials ?? (async () => ({ apiKey: API_KEY, oauth: false })),
    inventory: options.inventory ?? MODELS,
    clock: () => NOW,
    configuration: {
      ...(options.project === undefined ? {} : { project: options.project }),
      ...(options.prices === undefined ? {} : { prices: options.prices }),
    },
    store,
    observations: { latest: () => undefined },
  };
  return { deps, requests, commands, store };
}

async function run(harnessed: Harness): Promise<AdapterResult> {
  return google.run(harnessed.deps, new AbortController().signal);
}

/** A successful result; fails the test for a whole failure. */
function success(result: AdapterResult): AdapterSuccess {
  if ("reason" in result) assert.fail(`expected a success, got ${result.reason}`);
  return result;
}

/** A whole failure; fails the test for a success. */
function failure(result: AdapterResult): AdapterFailure {
  if (!("reason" in result)) assert.fail("expected a whole failure");
  return result;
}

function allWindowsOf(result: AdapterResult): LimitWindowCapture[] {
  const limits = success(result).facets.limits;
  if (limits === undefined || limits.state !== "known") {
    assert.fail(`expected known limits, got ${JSON.stringify(limits)}`);
  }
  return limits.value;
}

/** The Section 5 windows: all but the estimated spend window. */
function windowsOf(result: AdapterResult): LimitWindowCapture[] {
  return allWindowsOf(result).filter((window) => window.id !== "spend:month");
}

/** The estimated spend window (Section 7), which is the last one. */
function spendOf(result: AdapterResult): LimitWindowCapture {
  const window = allWindowsOf(result).at(-1);
  if (window?.id !== "spend:month") assert.fail("expected an estimated spend window");
  return window;
}

/** One month-to-date series. */
function monthSeries(model: string | null, value: number, limitName?: string): unknown {
  return {
    metric: {
      labels: {
        ...(model === null ? {} : { model }),
        ...(limitName === undefined ? {} : { limit_name: limitName }),
      },
    },
    points: [{ value: { int64Value: String(value) } }],
  };
}

/** The month-to-date requests, without the daily usage and limit requests. */
function monthly(requests: readonly TransportRequest[]): TransportRequest[] {
  return requests.filter(
    (request) => new URL(request.url).searchParams.get("interval.startTime") === MONTH_START,
  );
}

function planOf(result: AdapterResult): string {
  const plan = success(result).facets.plan;
  if (plan === undefined || plan.state !== "known") {
    assert.fail(`expected a known plan, got ${JSON.stringify(plan)}`);
  }
  return plan.value;
}

/** Asserts a secret appears in no part of the result (adapter-contract.md Section 2). */
function assertNoSecret(result: AdapterResult, secret: string): void {
  assert.equal(
    JSON.stringify(result).includes(secret),
    false,
    `the result must not carry ${secret}`,
  );
}

/** Asserts the request carried the bearer token and nothing else. */
function assertAuthenticated(requests: readonly TransportRequest[]): void {
  for (const request of requests) {
    assert.deepEqual(request.headers, { authorization: `Bearer ${TOKEN}` });
    assert.equal("allowedOrigins" in request, false);
  }
}

/** The one request whose filter is `filter`, or a failed lookup. */
function requestWith(requests: readonly TransportRequest[], filter: string): TransportRequest {
  const request = requests.find(
    (entry) => new URL(entry.url).searchParams.get("filter") === filter,
  );
  if (request === undefined) assert.fail(`no request with filter ${filter}`);
  return request;
}

/** The Monitoring requests of Sections 5 and 6: those of Section 7 are left out. */
function monitoring(requests: readonly TransportRequest[], suffix: string): TransportRequest[] {
  return requests.filter((request) => {
    const url = new URL(request.url);
    if (url.searchParams.get("interval.startTime") === MONTH_START) return false;
    return url.origin === "https://monitoring.googleapis.com" && url.pathname.endsWith(suffix);
  });
}

// --- Constants (Section 1) -------------------------------------------------

test("the adapter declares the spec's constants", () => {
  assert.equal(google.id, "google");
  assert.equal(google.providerOrigin, "https://generativelanguage.googleapis.com");
  assert.deepEqual(google.hostAllowlist, [
    "https://apikeys.googleapis.com",
    "https://cloudquotas.googleapis.com",
    "https://monitoring.googleapis.com",
  ]);
  assert.deepEqual(google.exposedFacets, ["plan", "limits"]);
  assert.equal(google.freshnessSeconds, 300);
});

// --- Sections 2–6, in order ------------------------------------------------

test("the paid fixtures yield the plan and the minute windows", async () => {
  const harnessed = harness();
  const result = await run(harnessed);

  assert.equal(planOf(result), "Paid tier 1");
  assert.deepEqual(windowsOf(result), [
    {
      id: "GenerateContentInputTokensPerModelPerMinute-PaidTier1:gemini-3.1-pro",
      label: "gemini-3.1-pro tok/min",
      unit: "tokens",
      used: null,
      limit: 2000000,
      percent: null,
      resetsAt: null,
      windowSeconds: 60,
      models: ["gemini-3.1-pro"],
      source: "endpoint",
    },
    {
      id: "GenerateRequestsPerMinutePerProjectPerModel-PaidTier1:gemini-3.1-pro",
      label: "gemini-3.1-pro req/min",
      unit: "requests",
      used: null,
      limit: 25,
      percent: null,
      resetsAt: null,
      windowSeconds: 60,
      models: ["gemini-3.1-pro"],
      source: "endpoint",
    },
    {
      id: "GenerateRequestsPerMinutePerProjectPerModel-PaidTier1:gemini-2.5-flash-lite",
      label: "gemini-2.5-flash-lite req/min",
      unit: "requests",
      used: null,
      limit: 4000,
      percent: null,
      resetsAt: null,
      windowSeconds: 60,
      models: ["gemini-2.5-flash-lite"],
      source: "endpoint",
    },
  ]);

  const counted = success(result);
  // The command, the lookup, two quota-metadata pages, the descriptors, three limit types and
  // the output token request; no usage request.
  assert.equal(counted.firstFailure, undefined);
  assertAuthenticated(harnessed.requests);
});

test("the free fixtures yield day windows whose used comes from the usage request", async () => {
  const harnessed = harness({ limitsFixture: "time-series-free-limits.json" });
  const result = await run(harnessed);

  assert.equal(planOf(result), "Free tier");
  assert.deepEqual(windowsOf(result), [
    {
      id: "GenerateContentInputTokensPerModelPerDay-FreeTier:gemini-2.5-flash",
      label: "gemini-2.5-flash tok/day",
      unit: "tokens",
      used: 12000,
      limit: 250000,
      percent: null,
      resetsAt: DAY_END,
      windowSeconds: 86400,
      models: ["gemini-2.5-flash"],
      source: "endpoint",
    },
    {
      id: "GenerateRequestsPerDayPerProjectPerModel-FreeTier:gemini-2.5-flash",
      label: "gemini-2.5-flash req/day",
      unit: "requests",
      used: 8,
      limit: 250,
      percent: null,
      resetsAt: DAY_END,
      windowSeconds: 86400,
      models: ["gemini-2.5-flash"],
      source: "endpoint",
    },
    {
      id: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier:gemini-2.5-flash",
      label: "gemini-2.5-flash req/min",
      unit: "requests",
      used: null,
      limit: 10,
      percent: null,
      resetsAt: null,
      windowSeconds: 60,
      models: ["gemini-2.5-flash"],
      source: "endpoint",
    },
  ]);

  // The command, the lookup, two metadata pages, the descriptors, two limit types and two
  // usage families.
  assertAuthenticated(harnessed.requests);
});

test("the requests carry the spec's query parameters", async () => {
  const harnessed = harness({ limitsFixture: "time-series-free-limits.json" });
  await run(harnessed);

  const descriptors = monitoring(harnessed.requests, "/metricDescriptors");
  assert.equal(descriptors.length, 1);
  const descriptorUrl = new URL(descriptors[0]?.url ?? "");
  assert.equal(descriptorUrl.pathname, `/v3/projects/${PROJECT}/metricDescriptors`);
  assert.equal(descriptorUrl.searchParams.get("filter"), DESCRIPTOR_FILTER);
  assert.equal(descriptorUrl.searchParams.get("pageSize"), "500");

  for (const family of [FREE_REQUESTS, FREE_TOKENS]) {
    const limits = new URL(requestWith(harnessed.requests, limitFilter(family)).url);
    assert.equal(limits.origin, "https://monitoring.googleapis.com");
    assert.equal(limits.pathname, `/v3/projects/${PROJECT}/timeSeries`);
    assert.equal(limits.searchParams.get("interval.startTime"), "2026-11-10T04:32:52.000Z");
    assert.equal(limits.searchParams.get("interval.endTime"), "2026-11-11T05:32:52.000Z");
    assert.equal(limits.searchParams.get("aggregation.alignmentPeriod"), "90000s");
    assert.equal(limits.searchParams.get("aggregation.perSeriesAligner"), "ALIGN_NEXT_OLDER");

    const usage = new URL(requestWith(harnessed.requests, usageFilter(family)).url);
    assert.equal(usage.pathname, `/v3/projects/${PROJECT}/timeSeries`);
    assert.equal(usage.searchParams.get("interval.startTime"), "2026-11-10T08:00:00.000Z");
    assert.equal(usage.searchParams.get("interval.endTime"), "2026-11-11T05:32:52.000Z");
    assert.equal(usage.searchParams.get("aggregation.alignmentPeriod"), USAGE_ALIGNMENT);
    assert.equal(usage.searchParams.get("aggregation.perSeriesAligner"), "ALIGN_SUM");
  }

  const metadata = harnessed.requests.filter(
    (request) => new URL(request.url).origin === "https://cloudquotas.googleapis.com",
  );
  assert.equal(metadata.length, 2);
  for (const request of metadata) {
    const url = new URL(request.url);
    assert.equal(
      url.pathname,
      `/v1/projects/${PROJECT}/locations/global/services/generativelanguage.googleapis.com/quotaInfos`,
    );
    assert.equal(url.searchParams.get("pageSize"), "200");
  }
  assert.equal(new URL(metadata[1]?.url ?? "").searchParams.get("pageToken"), "fixture-page-2");

  for (const request of harnessed.requests) {
    const url = new URL(request.url);
    assert.equal(
      request.bodyCap,
      url.origin === "https://apikeys.googleapis.com" ? 16 * 1024 : 1024 * 1024,
    );
  }
});

// --- Section 2: the access token -------------------------------------------

test("the gcloud command matches the spec exactly", async () => {
  const harnessed = harness();
  await run(harnessed);

  assert.equal(harnessed.commands.length, 1);
  const command = harnessed.commands[0];
  assert.equal(command?.command, "gcloud");
  assert.deepEqual(command?.args, ["auth", "print-access-token", "--quiet", "--verbosity=error"]);
  assert.equal(command?.deadlineMs, 10_000);
  assert.equal(command?.outputCap, 8 * 1024);
});

test("a missing gcloud is gcloud-missing", async () => {
  const harnessed = harness({
    command: async () => ({
      code: 1,
      stdout: "",
      stderr: "exec: gcloud: executable file not found in $PATH: ENOENT",
    }),
  });
  assert.deepEqual(failure(await run(harnessed)), { reason: "gcloud-missing" });
  assert.equal(harnessed.requests.length, 0);
});

test("a logged-out gcloud is gcloud-unauthenticated", async () => {
  const harnessed = harness({
    command: async () => ({
      code: 1,
      stdout: "",
      stderr:
        "ERROR: (gcloud.auth.print-access-token) You do not currently have an active account selected.\nPlease run:\n\n  $ gcloud auth login\n",
    }),
  });
  assert.deepEqual(failure(await run(harnessed)), { reason: "gcloud-unauthenticated" });
  assert.equal(harnessed.requests.length, 0);
});

test("any other gcloud exit is gcloud-failed", async () => {
  const harnessed = harness({
    command: async () => ({ code: 1, stdout: "", stderr: "ERROR: network is unreachable" }),
  });
  assert.deepEqual(failure(await run(harnessed)), { reason: "gcloud-failed" });
});

test("stdout that is not a token is gcloud-failed", async () => {
  for (const stdout of [
    "",
    "   \n",
    "two words\n",
    `${"a".repeat(4097)}\n`,
    "token\u0000with-null\n",
  ]) {
    const harnessed = harness({ command: async () => ({ code: 0, stdout, stderr: "" }) });
    assert.deepEqual(failure(await run(harnessed)), { reason: "gcloud-failed" });
    assert.equal(harnessed.requests.length, 0);
  }
});

test("a 4096-character token is accepted and its trimmed form is sent", async () => {
  const long = "A".repeat(4096);
  const harnessed = harness({
    command: async () => ({ code: 0, stdout: `  ${long}\n`, stderr: "" }),
  });
  const result = await run(harnessed);
  success(result);
  assert.equal(harnessed.requests[0]?.headers?.["authorization"], `Bearer ${long}`);
});

test("a command failure is the run's whole failure", async () => {
  for (const reason of ["timeout", "deadline", "response-too-large"] as const) {
    const harnessed = harness({ command: async () => ({ reason }) });
    assert.deepEqual(failure(await run(harnessed)), { reason });
    assert.equal(harnessed.requests.length, 0);
  }
});

// --- Credentials and endpoint checks (adapter-contract.md Section 3) -------

test("no credentials is no-credentials before any request or command", async () => {
  const harnessed = harness({ credentials: async () => undefined });
  assert.deepEqual(failure(await run(harnessed)), { reason: "no-credentials" });
  assert.equal(harnessed.requests.length, 0);
  assert.equal(harnessed.commands.length, 0);
});

test("the lookup stores the project under the API key's digest", async () => {
  const harnessed = harness();
  await run(harnessed);

  const lookup = harnessed.requests.find(
    (request) => new URL(request.url).origin === "https://apikeys.googleapis.com",
  );
  if (lookup === undefined) assert.fail("no lookup request");
  const url = new URL(lookup.url);
  assert.equal(url.pathname, "/v2/keys:lookupKey");
  assert.equal(url.searchParams.get("keyString"), API_KEY);

  const key = digest(API_KEY);
  assert.equal(harnessed.store.get(key), PROJECT);
  assert.equal(harnessed.store.values.get(key)?.ttlSeconds, undefined);
  assert.equal(harnessed.store.values.has(API_KEY), false);
  assert.equal(harnessed.store.keys().includes(PROJECT), false);
});

test("the project configuration skips the lookup", async () => {
  const harnessed = harness({ project: "purse-demo-project" });
  const result = await run(harnessed);

  success(result);
  assert.equal(
    harnessed.requests.some(
      (request) => new URL(request.url).origin === "https://apikeys.googleapis.com",
    ),
    false,
  );
  assert.equal(
    new URL(monitoring(harnessed.requests, "/timeSeries")[0]?.url ?? "").pathname,
    "/v3/projects/purse-demo-project/timeSeries",
  );
});

test("the stored project skips the lookup", async () => {
  const store = new FakeStore();
  store.set(digest(API_KEY), PROJECT);
  const harnessed = harness({ store });
  await run(harnessed);

  assert.equal(
    harnessed.requests.some(
      (request) => new URL(request.url).origin === "https://apikeys.googleapis.com",
    ),
    false,
  );
});

test("a forbidden lookup is project-unresolved", async () => {
  const harnessed = harness({
    routes: { lookup: () => response(403, fixture("error-page.html")) },
  });
  assert.deepEqual(failure(await run(harnessed)), { reason: "project-unresolved" });
  assert.equal(harnessed.requests.length, 1);
  assert.equal(harnessed.commands.length, 1);
});

test("a lookup with status 404 is project-unresolved", async () => {
  for (const outcome of [
    response(404, '{"error":{"code":404,"message":"Not found."}}'),
    { reason: "http-error", status: 404 },
  ] satisfies TransportOutcome[]) {
    const harnessed = harness({ routes: { lookup: () => outcome } });
    assert.deepEqual(failure(await run(harnessed)), { reason: "project-unresolved" });
  }
});

test("a lookup body without a project parent is project-unresolved", async () => {
  for (const body of [
    {},
    { parent: "organizations/123456789012/locations/global" },
    { parent: "projects//locations/global" },
    { parent: "projects/My_Project/locations/global" },
    { parent: "projects/a?b=c/locations/global" },
    { parent: "projects/%2e%2e/locations/global" },
    { parent: 42 },
  ]) {
    const harnessed = harness({ routes: { lookup: () => jsonResponse(body) } });
    assert.deepEqual(failure(await run(harnessed)), { reason: "project-unresolved" });
  }
});

test("another lookup failure keeps its own reason", async () => {
  const harnessed = harness({ routes: { lookup: () => response(401, "{}") } });
  assert.deepEqual(failure(await run(harnessed)), { reason: "http-401" });
});

test("a lookup 429 keeps its retryAfter", async () => {
  const harnessed = harness({
    routes: { lookup: () => ({ reason: "http-429", status: 429, retryAfter: 42 }) },
  });
  assert.deepEqual(failure(await run(harnessed)), {
    reason: "http-429",
    retryAfter: 42,
  });
});

test("an unparseable lookup body is bad-response", async () => {
  for (const body of ["", fixture("error-page.html"), "not json"]) {
    const harnessed = harness({ routes: { lookup: () => response(200, body) } });
    assert.deepEqual(failure(await run(harnessed)), { reason: "bad-response" });
  }
});

// --- Section 4: quota metadata --------------------------------------------

test("the quota metadata is cached for a day and reused", async () => {
  const harnessed = harness({ limitsFixture: "time-series-free-limits.json" });
  await run(harnessed);

  const metadataKeys = harnessed.store.keys().filter((key) => key.startsWith("google-quota"));
  assert.equal(metadataKeys.length, 1);
  const stored = harnessed.store.values.get(metadataKeys[0] ?? "");
  assert.equal(stored?.ttlSeconds, 86_400);
  assert.equal(typeof stored?.value, "object");

  const before = harnessed.requests.length;
  await run(harnessed);
  const fresh = harnessed.requests.slice(before);
  assert.equal(
    fresh.some((request) => new URL(request.url).origin === "https://cloudquotas.googleapis.com"),
    false,
  );
  assert.equal(fresh.length, 4); // two limit types and two usage families
});

test("failed metadata is not a whole failure and nothing is stored", async () => {
  const harnessed = harness({
    limitsFixture: "time-series-free-limits.json",
    routes: { metadata: () => response(500, "{}") },
  });
  const result = await run(harnessed);

  // Without the metadata, the intervals come from the quota ids' `PerDay` and `PerMinute`.
  assert.equal(planOf(result), "Free tier");
  assert.deepEqual(
    windowsOf(result).map((window) => [window.windowSeconds, window.resetsAt !== null]),
    [
      [86_400, true],
      [86_400, true],
      [60, false],
    ],
  );
  const counted = success(result);
  // The command, the lookup, the failed metadata request, the descriptors, two limit types and
  // two usage families.
  assert.deepEqual(counted.firstFailure, { reason: "http-error" });
  assert.equal(
    harnessed.store.keys().some((key) => key.startsWith("google-quota")),
    false,
  );
});

test("the metadata's refreshInterval decides the interval", async () => {
  const metadata = () =>
    jsonResponse({
      quotaInfos: [
        { quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", refreshInterval: "day" },
        { quotaId: "SomeQuotaWithoutAKeyword", refreshInterval: "minute" },
      ],
      nextPageToken: null,
    });
  const limits = seriesRoutes({
    timeSeries: [
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/generate_content_free_tier_requests/limit",
          labels: {
            limit_name: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
            model: "gemini-2.5-flash",
          },
        },
        points: [{ value: { int64Value: "250" } }],
      },
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/some_other_free_tier_requests/limit",
          labels: { limit_name: "SomeQuotaWithoutAKeyword", model: "gemini-2.5-flash" },
        },
        points: [{ value: { int64Value: "7" } }],
      },
    ],
  });
  const harnessed = harness({ routes: { metadata, ...limits } });
  const windows = windowsOf(await run(harnessed));

  assert.deepEqual(
    windows.map((window) => window.label),
    ["gemini-2.5-flash req/day", "gemini-2.5-flash req/min"],
  );
  assert.equal(windows[1]?.windowSeconds, 60);
});

test("a refreshInterval that is neither day nor minute is an unknown interval", async () => {
  const metadata = () =>
    jsonResponse({
      quotaInfos: [{ quotaId: "FileStorageBytesPerProject", refreshInterval: "hour" }],
    });
  const limits = seriesRoutes({
    timeSeries: [
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/file_storage_bytes/limit",
          labels: { limit_name: "FileStorageBytesPerProject" },
        },
        points: [{ value: { int64Value: "5368709120" } }],
      },
    ],
  });
  const harnessed = harness({ routes: { metadata, ...limits } });
  const windows = windowsOf(await run(harnessed));

  assert.deepEqual(windows, [
    {
      id: "FileStorageBytesPerProject",
      label: "all req/?",
      unit: "requests",
      used: null,
      limit: 5368709120,
      percent: null,
      resetsAt: null,
      windowSeconds: null,
      models: null,
      source: "endpoint",
    },
  ]);
});

// --- Section 5: paging -----------------------------------------------------

test("paging follows nextPageToken for at most five pages", async () => {
  const pages: string[] = [];
  const limits = (url: URL) => {
    pages.push(url.searchParams.get("pageToken") ?? "first");
    return jsonResponse({
      timeSeries: [
        {
          metric: {
            type: "generativelanguage.googleapis.com/quota/generate_requests_per_model/limit",
            labels: {
              limit_name: `Quota-${String(pages.length)}`,
              model: "gemini-2.5-flash",
            },
          },
          points: [{ value: { int64Value: String(pages.length) } }],
        },
      ],
      nextPageToken: `page-${String(pages.length + 1)}`,
    });
  };
  const harnessed = harness({
    routes: { types: [limitType("generate_requests_per_model")], limits },
  });
  const windows = windowsOf(await run(harnessed));

  assert.deepEqual(pages, ["first", "page-2", "page-3", "page-4", "page-5"]);
  assert.deepEqual(
    windows.map((window) => window.limit),
    [1, 2, 3, 4, 5],
  );
});

test("a failed page fails the whole request", async () => {
  let page = 0;
  const limits = () => {
    page += 1;
    const outcome: TransportOutcome =
      page === 1
        ? jsonResponse({ timeSeries: [], nextPageToken: "page-2" })
        : { reason: "timeout" };
    return outcome;
  };
  const harnessed = harness({ routes: { types: [limitType("some_family")], limits } });
  assert.deepEqual(failure(await run(harnessed)), { reason: "timeout" });
});

test("a non-string nextPageToken ends the paging", async () => {
  const harnessed = harness({
    routes: {
      types: [limitType("some_family")],
      limits: () => jsonResponse({ timeSeries: [], nextPageToken: 42 }),
    },
  });
  success(await run(harnessed));
  assert.equal(monitoring(harnessed.requests, "/timeSeries").length, 1);
});

// --- Section 5: the usage tier --------------------------------------------

test("the usage tier follows the spec's order of families", async () => {
  const cases: [string, string][] = [
    ["generate_content_paid_tier_3_requests", "Paid tier 3"],
    ["generate_content_paid_tier_2_requests", "Paid tier 2"],
    ["generate_requests_per_model", "Paid tier 1"],
    ["generate_content_free_tier_requests", "Free tier"],
    ["generate_content_paid_tier_2_free_tier_requests", "Paid tier 2"],
  ];
  for (const [family, tier] of cases) {
    const limits = seriesRoutes({
      timeSeries: [
        {
          metric: {
            type: `generativelanguage.googleapis.com/quota/${family}/limit`,
            labels: { limit_name: "SomeQuota", model: "gemini-2.5-flash" },
          },
          points: [{ value: { int64Value: "1" } }],
        },
      ],
    });
    const harnessed = harness({ routes: { ...limits } });
    assert.equal(planOf(await run(harnessed)), tier, family);
  }
});

test("a non-free tier drops the free-tier series", async () => {
  const limits = seriesRoutes({
    timeSeries: [
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/generate_content_free_tier_requests/limit",
          labels: { limit_name: "FreeQuota", model: "gemini-2.5-flash" },
        },
        points: [{ value: { int64Value: "250" } }],
      },
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/generate_requests_per_model/limit",
          labels: { limit_name: "PaidQuota", model: "gemini-2.5-flash" },
        },
        points: [{ value: { int64Value: "2000" } }],
      },
    ],
  });

  const paid = harness({ routes: { ...limits } });
  const paidResult = await run(paid);
  assert.equal(planOf(paidResult), "Paid tier 1");
  assert.deepEqual(
    windowsOf(paidResult).map((window) => window.id),
    ["PaidQuota:gemini-2.5-flash"],
  );
});

// --- Section 5: the windows ------------------------------------------------

test("an unlimited value yields no window", async () => {
  const limits = seriesRoutes({
    timeSeries: [
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/generate_requests_per_model/limit",
          labels: { limit_name: "UnlimitedQuota", model: "gemini-2.5-flash" },
        },
        points: [{ value: { int64Value: "-1" } }],
      },
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/generate_requests_per_model/limit",
          labels: { limit_name: "FiniteQuota", model: "gemini-2.5-flash" },
        },
        points: [{ value: { int64Value: "1000" } }],
      },
    ],
  });
  const windows = windowsOf(await run(harness({ routes: { ...limits } })));
  assert.deepEqual(
    windows.map((window) => window.id),
    ["FiniteQuota:gemini-2.5-flash"],
  );
});

test("series but no window makes the limits unavailable and keeps the plan", async () => {
  const limits = seriesRoutes({
    timeSeries: [
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/generate_requests_per_model/limit",
          labels: { limit_name: "UnlimitedQuota", model: "gemini-2.5-flash" },
        },
        points: [{ value: { int64Value: "-1" } }],
      },
    ],
  });
  const result = await run(harness({ routes: { ...limits } }));

  assert.equal(planOf(result), "Paid tier 1");
  assert.deepEqual(success(result).facets.limits, {
    state: "unavailable",
    reason: "empty-response",
  });
});

test("a repeated id keeps the first, by limit type then response order", async () => {
  const series = (family: string, value: string) => ({
    metric: {
      type: limitType(family),
      labels: { limit_name: "Quota", model: "gemini-2.5-flash" },
    },
    points: [{ value: { int64Value: value } }],
  });
  const limits = seriesRoutes({
    timeSeries: [
      series("generate_requests_per_model", "10"),
      series("generate_input_token_count", "20"),
      series("generate_input_token_count", "30"),
    ],
  });
  const windows = windowsOf(await run(harness({ routes: { ...limits } })));
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.limit, 20);
});

test("series without a quota id or without a finite value are skipped", async () => {
  const limits = seriesRoutes({
    timeSeries: [
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/generate_requests_per_model/limit",
          labels: { model: "gemini-2.5-flash" },
        },
        points: [{ value: { int64Value: "10" } }],
      },
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/generate_requests_per_model/limit",
          labels: { limit_name: "NoPoints", model: "gemini-2.5-flash" },
        },
      },
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/generate_requests_per_model/limit",
          labels: { limit_name: "NotANumber", model: "gemini-2.5-flash" },
        },
        points: [{ value: { int64Value: "lots" } }],
      },
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/generate_requests_per_model/limit",
          labels: { limit_name: "NullDouble", model: "gemini-2.5-flash" },
        },
        points: [{ value: { doubleValue: null } }],
      },
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/generate_requests_per_model/limit",
          labels: { limit_name: "WrongKind", model: "gemini-2.5-flash" },
        },
        points: [{ value: "1000" }],
      },
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/generate_requests_per_model/limit",
          labels: { limit_name: "Good", model: "gemini-2.5-flash" },
        },
        points: [{ value: { int64Value: "1000" } }],
      },
    ],
  });
  const windows = windowsOf(await run(harness({ routes: { ...limits } })));
  assert.deepEqual(
    windows.map((window) => window.id),
    ["Good:gemini-2.5-flash"],
  );
});

test("a double value is read when int64Value is absent", async () => {
  const limits = seriesRoutes({
    timeSeries: [
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/generate_content_input_token_count/limit",
          labels: { limit_name: "TokenQuota", model: "gemini-3.1-pro" },
        },
        points: [{ value: { doubleValue: 2000000.5 } }],
      },
    ],
  });
  const windows = windowsOf(await run(harness({ routes: { ...limits } })));
  assert.equal(windows[0]?.limit, 2000000.5);
  assert.equal(windows[0]?.unit, "tokens");
});

test("labels come only from metric.labels", async () => {
  const limits = seriesRoutes({
    timeSeries: [
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/generate_requests_per_model/limit",
          labels: { limit_name: "GenerateRequestsPerMinutePerProjectPerModel" },
        },
        resource: { labels: { model: "gemini-3.1-pro" } },
        points: [{ value: { int64Value: "25" } }],
      },
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/generate_requests_per_model/limit",
          labels: { limit_name: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" },
        },
        points: [{ value: { int64Value: "25" } }],
      },
    ],
  });
  const windows = windowsOf(await run(harness({ routes: { ...limits } })));
  assert.equal(windows[0]?.id, "GenerateRequestsPerMinutePerProjectPerModel");
  assert.equal(windows[0]?.models, null);
  assert.deepEqual(windows[1], {
    id: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
    label: "all req/min",
    unit: "requests",
    used: null,
    limit: 25,
    percent: null,
    resetsAt: null,
    windowSeconds: 60,
    models: null,
    source: "endpoint",
  });
});

test("a hostile model label is cleaned and cut to 64 code points", async () => {
  const limits = seriesRoutes({
    timeSeries: [
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/generate_requests_per_model/limit",
          labels: {
            limit_name: "GenerateRequestsPerMinutePerProjectPerModel",
            model: "\u0007gemini\n-\u0000flash ",
          },
        },
        points: [{ value: { int64Value: "10" } }],
      },
      {
        metric: {
          type: "generativelanguage.googleapis.com/quota/generate_requests_per_model/limit",
          labels: { limit_name: "LongQuota", model: "m".repeat(200) },
        },
        points: [{ value: { int64Value: "10" } }],
      },
    ],
  });
  const windows = windowsOf(await run(harness({ routes: { ...limits } })));
  assert.equal(windows[0]?.id, "GenerateRequestsPerMinutePerProjectPerModel:gemini-flash");
  assert.equal(windows[0]?.label, "gemini-flash req/min");
  assert.equal(windows[1]?.id, `LongQuota:${"m".repeat(64)}`);
  assert.equal(windows[1]?.models?.[0], "m".repeat(64));
  assert.equal(/[\p{Cc}]/u.test(JSON.stringify(windows)), false);
});

// --- Section 6: daily usage ------------------------------------------------

test("a failed usage request leaves used null", async () => {
  const harnessed = harness({
    limitsFixture: "time-series-free-limits.json",
    routes: { usage: () => response(500, "{}") },
  });
  const result = await run(harnessed);

  assert.deepEqual(
    windowsOf(result).map((window) => window.used),
    [null, null, null],
  );
  const counted = success(result);
  assert.deepEqual(counted.firstFailure, { reason: "http-error" });
});

test("a day window without a usage series has used 0", async () => {
  const harnessed = harness({
    limitsFixture: "time-series-free-limits.json",
    routes: { usage: () => jsonResponse({ timeSeries: [] }) },
  });
  assert.deepEqual(
    windowsOf(await run(harnessed)).map((window) => window.used),
    [0, 0, null],
  );
});

test("usage series of another model are not summed", async () => {
  const harnessed = harness({
    limitsFixture: "time-series-free-limits.json",
    routes: {
      usage: () =>
        jsonResponse({
          timeSeries: [
            {
              metric: {
                type: "generativelanguage.googleapis.com/quota/generate_content_free_tier_requests/usage",
                labels: { model: "gemini-2.5-pro" },
              },
              points: [{ value: { int64Value: "999" } }, { value: { int64Value: "1" } }],
            },
          ],
        }),
    },
  });
  assert.deepEqual(
    windowsOf(await run(harnessed)).map((window) => window.used),
    [0, 0, null],
  );
});

test("no day window means no usage request", async () => {
  const harnessed = harness();
  await run(harnessed);
  assert.equal(
    harnessed.requests.some((request) =>
      (new URL(request.url).searchParams.get("filter") ?? "").endsWith('/usage"'),
    ),
    false,
  );
});

test("usage is summed per quota id and model across series and points", async () => {
  const usageSeries = (quotaId: string, model: string, values: string[]) => ({
    metric: {
      type: `${QUOTA_PREFIX}${FREE_REQUESTS}/usage`,
      labels: { limit_name: quotaId, model },
    },
    points: values.map((value) => ({ value: { int64Value: value } })),
  });
  const harnessed = harness({
    limitsFixture: "time-series-free-limits.json",
    routes: {
      usage: (url) =>
        url.searchParams.get("filter") === usageFilter(FREE_REQUESTS)
          ? jsonResponse({
              timeSeries: [
                usageSeries(
                  "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
                  "gemini-2.5-flash",
                  ["3", "4"],
                ),
                usageSeries(
                  "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
                  "gemini-2.5-flash",
                  ["5"],
                ),
                usageSeries("OtherQuota", "gemini-2.5-flash", ["100"]),
                usageSeries("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "other", ["200"]),
              ],
            })
          : jsonResponse({ timeSeries: [] }),
    },
  });
  const windows = windowsOf(await run(harnessed));
  assert.deepEqual(
    windows.map((window) => window.used),
    [0, 12, null],
  );
});

test("usage is requested per family with a day window whose usage type exists", async () => {
  // The tokens family has a day window but no usage type.
  const harnessed = harness({
    limitsFixture: "time-series-free-limits.json",
    routes: {
      types: [
        limitType(FREE_REQUESTS),
        limitType(FREE_TOKENS),
        `${QUOTA_PREFIX}${FREE_REQUESTS}/usage`,
      ],
    },
  });
  const windows = windowsOf(await run(harnessed));

  assert.deepEqual(
    windows.map((window) => window.used),
    [null, 8, null],
  );
  const usage = harnessed.requests.filter((request) =>
    (new URL(request.url).searchParams.get("filter") ?? "").endsWith('/usage"'),
  );
  assert.deepEqual(
    usage.map((request) => new URL(request.url).searchParams.get("filter")),
    [usageFilter(FREE_REQUESTS)],
  );
});

test("a family without a day window gets no usage request", async () => {
  const harnessed = harness({
    routes: {
      types: [
        limitType("generate_requests_per_model"),
        `${QUOTA_PREFIX}generate_requests_per_model/usage`,
      ],
    },
  });
  await run(harnessed);
  assert.equal(monitoring(harnessed.requests, "/timeSeries").length, 1);
});

test("a failed usage request leaves only its family's windows null", async () => {
  const harnessed = harness({
    limitsFixture: "time-series-free-limits.json",
    routes: {
      usage: (url) =>
        url.searchParams.get("filter") === usageFilter(FREE_TOKENS)
          ? response(500, "{}")
          : jsonResponse({ timeSeries: [] }),
    },
  });
  assert.deepEqual(
    windowsOf(await run(harnessed)).map((window) => window.used),
    [null, 0, null],
  );
});

// --- Section 5: metric types and limit requests ----------------------------

test("the metric types are stored for a day under a key of their own", async () => {
  const harnessed = harness({ limitsFixture: "time-series-free-limits.json" });
  await run(harnessed);

  const key = `google-metric-types:${digest(PROJECT)}`;
  const stored = harnessed.store.values.get(key);
  assert.equal(stored?.ttlSeconds, 86_400);
  assert.deepEqual(
    [...(Array.isArray(stored?.value) ? (stored.value as string[]) : [])].toSorted(),
    [
      limitType(FREE_REQUESTS),
      limitType(FREE_TOKENS),
      `${QUOTA_PREFIX}${FREE_REQUESTS}/usage`,
      `${QUOTA_PREFIX}${FREE_TOKENS}/usage`,
    ].toSorted(),
  );
  assert.equal(new Set(harnessed.store.keys()).size, 3);
  assert.equal(
    harnessed.store.keys().some((entry) => entry.includes(PROJECT)),
    false,
  );
});

test("stored metric types skip the descriptor listing", async () => {
  const store = new FakeStore();
  store.set(`google-metric-types:${digest(PROJECT)}`, [limitType("generate_requests_per_model")]);
  const harnessed = harness({ store });
  const result = await run(harnessed);

  assert.equal(monitoring(harnessed.requests, "/metricDescriptors").length, 0);
  assert.deepEqual(
    monitoring(harnessed.requests, "/timeSeries").map((request) =>
      new URL(request.url).searchParams.get("filter"),
    ),
    [limitFilter("generate_requests_per_model")],
  );
  assert.equal(planOf(result), "Paid tier 1");
  assert.equal(windowsOf(result).length, 2);
});

test("the descriptors are paged and their types are collected", async () => {
  const tokens: (string | null)[] = [];
  const descriptors = (url: URL) => {
    const token = url.searchParams.get("pageToken");
    tokens.push(token);
    return token === null
      ? jsonResponse({
          metricDescriptors: [{ type: limitType(FREE_TOKENS) }, { name: "no type" }, 7],
          nextPageToken: "fixture-page-2",
        })
      : jsonResponse({ metricDescriptors: [{ type: limitType(FREE_REQUESTS) }] });
  };
  const harnessed = harness({
    limitsFixture: "time-series-free-limits.json",
    routes: { descriptors },
  });
  const result = await run(harnessed);

  assert.deepEqual(tokens, [null, "fixture-page-2"]);
  assert.equal(windowsOf(result).length, 3);
  assert.deepEqual(harnessed.store.get(`google-metric-types:${digest(PROJECT)}`), [
    limitType(FREE_TOKENS),
    limitType(FREE_REQUESTS),
  ]);
});

test("a failed descriptor listing is a whole failure and nothing is stored", async () => {
  const harnessed = harness({ routes: { descriptors: () => response(403, "{}") } });
  assert.deepEqual(failure(await run(harnessed)), { reason: "http-403" });
  assert.equal(monitoring(harnessed.requests, "/timeSeries").length, 0);
  assert.equal(
    harnessed.store.keys().some((key) => key.startsWith("google-metric-types")),
    false,
  );
});

test("one limit request per limit type, in ascending order, concurrently", async () => {
  const harnessed = harness({ limitsFixture: "time-series-paid.json" });
  const inner = harnessed.deps.transport;
  let inFlight = 0;
  let peak = 0;
  harnessed.deps.transport = async (request) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    try {
      return await inner(request);
    } finally {
      inFlight -= 1;
    }
  };
  await run(harnessed);

  assert.deepEqual(
    monitoring(harnessed.requests, "/timeSeries").map((request) =>
      new URL(request.url).searchParams.get("filter"),
    ),
    [
      limitFilter(FREE_REQUESTS),
      limitFilter("generate_content_input_token_count"),
      limitFilter("generate_requests_per_model"),
    ],
  );
  assert.equal(peak >= 3, true);
});

test("types that are not limit types of a family get no limit request", async () => {
  const harnessed = harness({
    routes: {
      types: [
        `${QUOTA_PREFIX}a/usage`,
        `${QUOTA_PREFIX}a/limit/extra`,
        `${QUOTA_PREFIX}/limit`,
        limitType("generate_requests_per_model"),
        limitType("generate_requests_per_model"),
      ],
    },
  });
  await run(harnessed);
  assert.deepEqual(
    monitoring(harnessed.requests, "/timeSeries").map((request) =>
      new URL(request.url).searchParams.get("filter"),
    ),
    [limitFilter("generate_requests_per_model")],
  );
});

test("a failed limit request fails Section 5 with the first reason by limit type", async () => {
  const reasons: Record<string, TransportOutcome> = {
    [limitFilter("b_family")]: { reason: "timeout" },
    [limitFilter("a_family")]: response(401, "{}"),
    [limitFilter("c_family")]: response(500, "{}"),
  };
  const harnessed = harness({
    routes: {
      types: [limitType("c_family"), limitType("b_family"), limitType("a_family")],
      limits: (url) =>
        reasons[url.searchParams.get("filter") ?? ""] ?? jsonResponse({ timeSeries: [] }),
    },
  });
  assert.deepEqual(failure(await run(harnessed)), { reason: "http-401" });
});

test("one rejected limit request fails the run although the others succeed", async () => {
  const harnessed = harness({
    routes: {
      limits: (url) =>
        url.searchParams.get("filter") === limitFilter("generate_requests_per_model")
          ? response(400, "{}")
          : servedFrom(
              "time-series-paid.json",
              /"(.*)"/.exec(url.searchParams.get("filter") ?? "")?.[1],
            ),
    },
  });
  assert.deepEqual(failure(await run(harnessed)), { reason: "http-error" });
});

test("no limit types make the plan and the limits unavailable", async () => {
  for (const types of [[], [`${QUOTA_PREFIX}generate_requests_per_model/usage`]]) {
    const harnessed = harness({ routes: { types } });
    assert.deepEqual(success(await run(harnessed)).facets, {
      plan: { state: "unavailable", reason: "empty-response" },
      limits: { state: "unavailable", reason: "empty-response" },
    });
    assert.equal(monitoring(harnessed.requests, "/timeSeries").length, 0);
  }
});

// --- Empty and untrusted responses -----------------------------------------

test("no series makes the plan and the limits unavailable", async () => {
  for (const body of [{}, { timeSeries: [] }, { timeSeries: {} }, { timeSeries: "none" }]) {
    const harnessed = harness({ routes: { limits: () => jsonResponse(body) } });
    const result = await run(harnessed);
    const counted = success(result);
    assert.deepEqual(counted.facets, {
      plan: { state: "unavailable", reason: "empty-response" },
      limits: { state: "unavailable", reason: "empty-response" },
    });
  }
});

test("a body that is not a JSON object yields no series", async () => {
  for (const body of ["null", "[]", '"text"', "0"]) {
    const harnessed = harness({ routes: { limits: () => response(200, body) } });
    const result = await run(harnessed);
    assert.equal(success(result).facets.limits?.state, "unavailable");
  }
});

test("hostile series entries are skipped without a throw", async () => {
  const limits = seriesRoutes({
    timeSeries: [
      null,
      3,
      "series",
      { metric: 5 },
      { metric: { type: 7 } },
      { metric: { type: "generativelanguage.googleapis.com/quota/x/limit" }, points: "no" },
      { metric: { type: "generativelanguage.googleapis.com/quota/x/limit" }, points: [null] },
    ],
  });
  const result = await run(harness({ routes: { ...limits } }));
  assert.equal(success(result).facets.limits?.state, "unavailable");
});

test("an empty limits body is bad-response and a whole failure", async () => {
  const harnessed = harness({ routes: { limits: () => response(200, "") } });
  assert.deepEqual(failure(await run(harnessed)), { reason: "bad-response" });
});

test("a rejecting transport is internal", async () => {
  const harnessed = harness();
  harnessed.deps.transport = async () => {
    throw new Error("transport exploded");
  };
  assert.deepEqual(failure(await run(harnessed)), { reason: "internal" });
});

test("a throwing store is internal", async () => {
  const store = new FakeStore();
  store.get = () => {
    throw new Error("store exploded");
  };
  assert.deepEqual(failure(await run(harness({ store }))), { reason: "internal" });
});

// --- Estimated spend (Section 7) -------------------------------------------

const SPEND_MODELS: readonly InventoryModel[] = [
  {
    id: "gemini-a",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "gemini-b",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];

/** Paid limit types plus the input-token usage types of two paid families and a free one. */
const SPEND_TYPES: readonly string[] = [
  limitType("generate_requests_per_model"),
  `${QUOTA_PREFIX}${PAID_INPUT}/usage`,
  `${QUOTA_PREFIX}generate_content_paid_tier_2_input_token_count/usage`,
  `${QUOTA_PREFIX}${FREE_TOKENS}/usage`,
  `${QUOTA_PREFIX}generate_requests_per_model/usage`,
];

function spendRoutes(series: Record<string, unknown[]>): Routes {
  return {
    types: SPEND_TYPES,
    spend: (_url, type) => jsonResponse({ timeSeries: series[type] ?? [] }),
  };
}

test("a paid tier gets the estimated spend window after the others", async () => {
  const harnessed = harness({
    inventory: SPEND_MODELS,
    routes: spendRoutes({
      [`${QUOTA_PREFIX}${PAID_INPUT}/usage`]: [
        // Two quota ids repeat one total: the greatest counts once.
        monthSeries("gemini-a", 3_000_000, "PerMinute"),
        monthSeries("gemini-a", 3_000_000, "PerMinutePerUser"),
        monthSeries(null, 9_000_000, "PerMinute"),
      ],
      // Families are summed.
      [`${QUOTA_PREFIX}generate_content_paid_tier_2_input_token_count/usage`]: [
        monthSeries("gemini-a", 1_000_000, "PerMinute"),
      ],
      // Output series of one model are summed.
      [OUTPUT_TYPE]: [monthSeries("gemini-a", 200_000), monthSeries("gemini-a", 50_500)],
    }),
  });
  const result = await run(harnessed);

  // (4 M × 2 + 250500 × 10) ÷ 1 M = 10.505.
  assert.deepEqual(allWindowsOf(result).at(-1), {
    id: "spend:month",
    label: "spend est/month",
    unit: "currency",
    currency: "USD",
    used: 10.51,
    limit: 250,
    percent: null,
    resetsAt: MONTH_END,
    windowSeconds: null,
    models: null,
    source: "endpoint",
    severity: "unknown",
  });
  assert.equal(allWindowsOf(result).length, windowsOf(result).length + 1);

  const filters = monthly(harnessed.requests).map((request) =>
    new URL(request.url).searchParams.get("filter"),
  );
  assert.deepEqual(filters.toSorted(), [
    `metric.type = "${OUTPUT_TYPE}"`,
    usageFilter("generate_content_paid_tier_2_input_token_count"),
    usageFilter(PAID_INPUT),
  ]);
  for (const request of monthly(harnessed.requests)) {
    const params = new URL(request.url).searchParams;
    assert.equal(params.get("interval.endTime"), new Date(NOW).toISOString());
    assert.equal(params.get("aggregation.alignmentPeriod"), MONTH_ALIGNMENT);
    assert.equal(params.get("aggregation.perSeriesAligner"), "ALIGN_SUM");
  }
});

test("a rate override prices the estimated spend", async () => {
  const harnessed = harness({
    inventory: SPEND_MODELS,
    prices: { "gemini-a": { output: 5 } },
    routes: spendRoutes({
      [`${QUOTA_PREFIX}${PAID_INPUT}/usage`]: [monthSeries("gemini-a", 1_000_000, "PerMinute")],
      [OUTPUT_TYPE]: [monthSeries("gemini-a", 1_000_000)],
    }),
  });
  assert.equal(spendOf(await run(harnessed)).used, 7);
});

test("a token-bearing model outside the inventory makes the spend unknown", async () => {
  const harnessed = harness({
    inventory: SPEND_MODELS,
    routes: spendRoutes({
      [`${QUOTA_PREFIX}${PAID_INPUT}/usage`]: [
        monthSeries("gemini-unlisted", 9_000_000, "PerMinute"),
      ],
    }),
  });
  assert.equal(spendOf(await run(harnessed)).used, null);
});

test("a token-bearing model with an unknown rate makes the spend unknown", async () => {
  // gemini-b has an all-zero inventory cost: its input rate is null.
  const nullInput = harness({
    inventory: SPEND_MODELS,
    routes: spendRoutes({
      [`${QUOTA_PREFIX}${PAID_INPUT}/usage`]: [monthSeries("gemini-b", 5_000_000, "PerMinute")],
    }),
  });
  assert.equal(spendOf(await run(nullInput)).used, null);

  // gemini-a with an explicit null output rate and output tokens.
  const nullOutput = harness({
    inventory: SPEND_MODELS,
    prices: { "gemini-a": { output: null } },
    routes: spendRoutes({
      [OUTPUT_TYPE]: [monthSeries("gemini-a", 1_000_000)],
    }),
  });
  assert.equal(spendOf(await run(nullOutput)).used, null);
});

test("no token series is an estimated spend of 0", async () => {
  assert.equal(spendOf(await run(harness())).used, 0);
});

test("a failed month request leaves used null and is not a whole failure", async () => {
  for (const failing of [OUTPUT_TYPE, `${QUOTA_PREFIX}${PAID_INPUT}/usage`]) {
    const harnessed = harness({
      inventory: SPEND_MODELS,
      routes: {
        types: SPEND_TYPES,
        spend: (_url, type) =>
          type === failing ? response(500, "{}") : jsonResponse({ timeSeries: [] }),
      },
    });
    const result = await run(harnessed);
    const window = spendOf(result);
    assert.equal(window.used, null);
    assert.equal(window.limit, 250);
    assert.deepEqual(success(result).firstFailure, { reason: "http-error" });
  }
});

test("the spend cap follows the usage tier", async () => {
  for (const [family, limit] of [
    ["generate_content_paid_tier_2_requests", 2000],
    ["generate_content_paid_tier_3_requests", null],
  ] as const) {
    const body = {
      timeSeries: [
        {
          metric: { type: limitType(family), labels: { limit_name: "PerMinute", model: "m" } },
          points: [{ value: { int64Value: "10" } }],
        },
      ],
    };
    const result = await run(harness({ routes: seriesRoutes(body) }));
    assert.equal(spendOf(result).limit, limit);
  }
});

test("the free tier gets no estimated spend window and no month request", async () => {
  const harnessed = harness({ limitsFixture: "time-series-free-limits.json" });
  const result = await run(harnessed);
  assert.equal(planOf(result), "Free tier");
  assert.equal(allWindowsOf(result).length, windowsOf(result).length);
  assert.equal(monthly(harnessed.requests).length, 0);
});

// --- Credentials never leak ------------------------------------------------

test("a whole failure carries nothing but the reason", async () => {
  for (const routes of [
    { lookup: () => response(403, fixture("error-page.html")) },
    { lookup: () => response(200, fixture("error-page.html")) },
    { limits: () => response(500, "{}") },
  ]) {
    const result = await run(harness({ routes }));
    const reported = failure(result);
    assertNoSecret(result, API_KEY);
    assertNoSecret(result, TOKEN);
    assertNoSecret(result, PROJECT);
    assert.deepEqual(Object.keys(reported).toSorted(), ["reason"]);
  }
});

test("no returned value carries the API key, the access token or the project", async () => {
  const harnessed = harness({ limitsFixture: "time-series-free-limits.json" });
  const result = await run(harnessed);
  success(result);

  assertNoSecret(result, API_KEY);
  assertNoSecret(result, TOKEN);
  assertNoSecret(result, PROJECT);
  assert.equal(JSON.stringify(result).includes("purse-demo-project"), false);
  assert.equal(JSON.stringify(result).includes("http"), false);
  assert.equal(JSON.stringify(result).includes("Bearer"), false);
});
