/**
 * Tests for the Exa adapter (specs/adapter-exa.md) against a fake transport: the balance and
 * spend mappings from hand-written fixtures, the key list and key usage requests, and every
 * failure the spec lists. No test touches the network; the values are fake.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { exa } from "../../lib/adapters/exa.ts";
import type {
  AdapterDependencies,
  CheckedCredentials,
  TransportOutcome,
  TransportRequest,
} from "../../lib/adapter.ts";
import type {
  AdapterFailure,
  AdapterResult,
  AdapterSuccess,
  BalanceItemCapture,
  Facet,
  LimitWindowCapture,
} from "../../lib/state.ts";

const SIGNAL = new AbortController().signal;
const TOKEN = "unit-test-service-key";
/** The clock at the start of `run`. */
const NOW = 1_760_000_000_000;
const CREDITS_URL = "https://admin-api.exa.ai/team-management/credits";
const KEYS_URL = "https://admin-api.exa.ai/team-management/api-keys";
/** The 30-day window of `NOW`, in the RFC 3339 form of Section 3. */
const START = "2025-09-09T08:53:20Z";
const END = "2025-10-09T08:53:20Z";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The single spend window of Section 3 with `used`. */
function spendWindow(used: number): LimitWindowCapture {
  return {
    id: "spend-30d",
    label: "30d spend",
    unit: "currency",
    currency: "USD",
    used,
    limit: null,
    percent: null,
    resetsAt: null,
    windowSeconds: 2_592_000,
    models: null,
    source: "endpoint",
  };
}

function ok(body: string, status = 200): TransportOutcome {
  return { status, headers: { "content-type": "application/json" }, body };
}

function creditsBody(credits: number): string {
  return JSON.stringify({ credits_usd: credits });
}

function keysBody(publicIds: readonly string[]): string {
  return JSON.stringify({ apiKeys: publicIds.map((publicId) => ({ publicId })) });
}

function usageBody(total: number): string {
  return JSON.stringify({ total_cost_usd: total });
}

function usageUrl(publicId: string, start = START, end = END): string {
  return `${KEYS_URL}/${publicId}/usage?start_date=${start}&end_date=${end}`;
}

/** The recorded outcomes of a run over two keys (Sections 2–3). */
function recorded(): Map<string, TransportOutcome> {
  return new Map<string, TransportOutcome>([
    [CREDITS_URL, ok(creditsBody(42.5))],
    [KEYS_URL, ok(keysBody(["key_01", "key_02"]))],
    [usageUrl("key_01"), ok(usageBody(1.25))],
    [usageUrl("key_02"), ok(usageBody(2.5))],
  ]);
}

interface HarnessOptions {
  /** Outcomes by URL; a URL not listed fails with `network`. */
  responses?: ReadonlyMap<string, TransportOutcome>;
  /** Explicit credentials; absent means a service key. */
  credentials?: CheckedCredentials | undefined;
  clock?: () => number;
  /** A transport that settles when the test says so; requests are recorded either way. */
  transport?: (request: TransportRequest) => Promise<TransportOutcome>;
}

interface Harness {
  deps: AdapterDependencies;
  requests: TransportRequest[];
}

/** Dependencies over a fake transport; every other dependency is inert. */
function harness(options: HarnessOptions = {}): Harness {
  const requests: TransportRequest[] = [];
  const responses = options.responses ?? recorded();
  const credentials = "credentials" in options ? options.credentials : defaultCredentials();
  return {
    requests,
    deps: {
      transport: (request) => {
        requests.push(request);
        if (options.transport !== undefined) return options.transport(request);
        return Promise.resolve(responses.get(request.url) ?? { reason: "network" });
      },
      commandRunner: async () => {
        throw new Error("the exa adapter runs no command");
      },
      credentials: async () => credentials,
      inventory: [],
      clock: options.clock ?? (() => NOW),
      configuration: {},
      store: { get: () => undefined, set: () => {} },
      observations: { latest: () => undefined },
    },
  };
}

function defaultCredentials(): CheckedCredentials {
  return { apiKey: TOKEN, oauth: false };
}

function success(result: AdapterResult): AdapterSuccess {
  if ("reason" in result) assert.fail(`expected a success, got ${result.reason}`);
  return result;
}

function failure(result: AdapterResult): AdapterFailure {
  if (!("reason" in result)) assert.fail("expected a whole failure");
  return result;
}

/** The value of a known facet; fails on `not-exposed` or `unavailable`. */
function known<T>(facet: Facet<T> | undefined): T {
  if (facet === undefined) assert.fail("missing facet");
  if (facet.state === "unavailable") assert.fail(`facet unavailable: ${facet.reason}`);
  if (facet.state === "not-exposed") assert.fail("facet not exposed");
  return facet.value;
}

/** The balance items of a result, which must be a known facet. */
function balanceItems(result: AdapterResult): BalanceItemCapture[] {
  return known(success(result).facets.balance);
}

/** The spend window of a result, which must be a known facet. */
function spend(result: AdapterResult): LimitWindowCapture[] {
  return known(success(result).facets.limits);
}

/** A run over `publicIds` whose usage bodies are `costs`, in key list order. */
function runOver(publicIds: readonly string[], costs: readonly number[]): Promise<AdapterResult> {
  const responses = new Map<string, TransportOutcome>([
    [CREDITS_URL, ok(creditsBody(1))],
    [KEYS_URL, ok(keysBody(publicIds))],
  ]);
  for (const [index, publicId] of publicIds.entries()) {
    responses.set(usageUrl(publicId), ok(usageBody(costs[index] ?? 0)));
  }
  return exa.run(harness({ responses }).deps, SIGNAL);
}

test("profile constants (Section 1)", () => {
  assert.equal(exa.id, "exa");
  assert.equal(exa.providerOrigin, undefined);
  assert.equal(exa.credentialVariable, "PURSE_EXA_SERVICE_KEY");
  assert.deepEqual(exa.hostAllowlist, ["https://admin-api.exa.ai"]);
  assert.deepEqual(exa.exposedFacets, ["balance", "limits"]);
  assert.equal(exa.freshnessSeconds, 900);
});

test("the recorded outcomes yield the balance and the spend window (Sections 2-3)", async () => {
  const h = harness();
  const result = success(await exa.run(h.deps, SIGNAL));

  assert.deepEqual(result.facets.balance, {
    state: "known",
    value: [{ amount: 42.5, currency: "USD", currencyAssumed: false, gatesUsage: true }],
  });
  assert.deepEqual(result.facets.limits, { state: "known", value: [spendWindow(3.75)] });
  assert.equal(result.firstFailure, undefined);
  assert.equal(result.capturedAt, undefined);
  assert.equal(result.captureReason, undefined);
});

test("the balance item and the window carry no severity override", async () => {
  const result = success(await exa.run(harness().deps, SIGNAL));
  const item = balanceItems(result)[0];
  const window = spend(result)[0];
  assert.ok(item !== undefined && window !== undefined);
  assert.equal("severity" in item, false);
  assert.equal("severity" in window, false);
});

test("every request is one GET with only the credential header and its body cap", async () => {
  const h = harness();
  await exa.run(h.deps, SIGNAL);

  assert.deepEqual(
    h.requests.map((request) => request.url),
    [CREDITS_URL, KEYS_URL, usageUrl("key_01"), usageUrl("key_02")],
  );
  for (const request of h.requests) {
    assert.deepEqual(request.headers, { "x-api-key": TOKEN });
    assert.equal(request.signal, SIGNAL);
  }
  assert.deepEqual(
    h.requests.map((request) => request.bodyCap),
    [16 * 1024, 256 * 1024, 64 * 1024, 64 * 1024],
  );
});

test("any credential is accepted: no check of the adapter's own", async () => {
  const h = harness({ credentials: { apiKey: TOKEN, oauth: true } });
  const result = success(await exa.run(h.deps, SIGNAL));
  assert.equal(h.requests[0]?.headers?.["x-api-key"], TOKEN);
  assert.deepEqual(result.facets.limits, { state: "known", value: [spendWindow(3.75)] });
});

test("the usage URL carries the run start's window, seconds rounded down (Section 3)", async () => {
  const h = harness({ clock: () => NOW + 750 });
  await exa.run(h.deps, SIGNAL);

  const usage = h.requests[2];
  assert.ok(usage !== undefined);
  assert.equal(
    usage.url,
    "https://admin-api.exa.ai/team-management/api-keys/key_01/usage?start_date=2025-09-09T08:53:20Z&end_date=2025-10-09T08:53:20Z",
  );
  const url = new URL(usage.url);
  const start = Date.parse(url.searchParams.get("start_date") ?? "");
  const end = Date.parse(url.searchParams.get("end_date") ?? "");
  assert.equal(url.searchParams.get("start_date"), START);
  assert.equal(url.searchParams.get("end_date"), END);
  assert.equal((end - start) / 1000, 2_592_000);
});

test("the key list is issued concurrently with the credits request (Section 3)", async () => {
  const settle: (() => void)[] = [];
  const h = harness({
    transport: (request) => {
      if (request.url === CREDITS_URL) {
        return new Promise((resolve) => settle.push(() => resolve(ok(creditsBody(1)))));
      }
      if (request.url === KEYS_URL) {
        return new Promise((resolve) => settle.push(() => resolve(ok(keysBody([])))));
      }
      return new Promise((resolve) => settle.push(() => resolve(ok(usageBody(0)))));
    },
  });

  const done = exa.run(h.deps, SIGNAL);
  await flush();
  assert.equal(h.requests.length, 2, "both requests are in flight before either settles");
  for (const resolve of settle.splice(0)) resolve();
  assert.deepEqual(spend(await done), [spendWindow(0)]);
});

test("at most 4 key usage requests are in flight (Section 3)", async () => {
  const publicIds = ["key_01", "key_02", "key_03", "key_04", "key_05", "key_06"];
  const pending: ((outcome: TransportOutcome) => void)[] = [];
  let inFlight = 0;
  let peak = 0;
  const h = harness({
    transport: (request) => {
      if (request.url === CREDITS_URL) return Promise.resolve(ok(creditsBody(1)));
      if (request.url === KEYS_URL) return Promise.resolve(ok(keysBody(publicIds)));
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) => {
        pending.push((outcome) => {
          inFlight -= 1;
          resolve(outcome);
        });
      });
    },
  });

  const done = exa.run(h.deps, SIGNAL);
  await flush();
  assert.equal(pending.length, 4);
  assert.equal(peak, 4);

  pending.shift()?.(ok(usageBody(1)));
  await flush();
  assert.equal(pending.length, 4, "a settled request makes room for one more");
  assert.equal(peak, 4);

  while (pending.length > 0) {
    pending.shift()?.(ok(usageBody(1)));
    await flush();
  }
  assert.equal(peak, 4);
  assert.deepEqual(spend(await done), [spendWindow(6)]);
});

test("a failed key usage stops further requests and makes limits unavailable", async () => {
  const publicIds = ["key_01", "key_02", "key_03", "key_04", "key_05", "key_06"];
  const pending = new Map<string, (outcome: TransportOutcome) => void>();
  const h = harness({
    transport: (request) => {
      if (request.url === CREDITS_URL) return Promise.resolve(ok(creditsBody(1)));
      if (request.url === KEYS_URL) return Promise.resolve(ok(keysBody(publicIds)));
      return new Promise((resolve) => pending.set(request.url, resolve));
    },
  });

  const done = exa.run(h.deps, SIGNAL);
  await flush();
  assert.equal(pending.size, 4);
  pending.get(usageUrl("key_02"))?.({ reason: "http-429", status: 429, retryAfter: 30 });
  await flush();
  for (const [url, resolve] of pending) {
    if (url !== usageUrl("key_02")) resolve(ok(usageBody(1)));
  }

  const result = success(await done);
  const usageUrls = h.requests.map((request) => request.url).slice(2);
  assert.equal(usageUrls.length, 4, "no request after the failure");
  assert.equal(
    usageUrls.some((url) => url.includes("key_05") || url.includes("key_06")),
    false,
  );
  assert.deepEqual(result.facets.limits, { state: "unavailable", reason: "http-429" });
  assert.deepEqual(result.firstFailure, { reason: "http-429", retryAfter: 30 });
  assert.deepEqual(result.facets.balance, {
    state: "known",
    value: [{ amount: 1, currency: "USD", currencyAssumed: false, gatesUsage: true }],
  });
});

test("the first failure in issue order wins over the arrival order", async () => {
  const pending = new Map<string, (outcome: TransportOutcome) => void>();
  const h = harness({
    transport: (request) => {
      if (request.url === CREDITS_URL) return Promise.resolve(ok(creditsBody(1)));
      if (request.url === KEYS_URL) {
        return Promise.resolve(ok(keysBody(["key_01", "key_02", "key_03"])));
      }
      return new Promise((resolve) => pending.set(request.url, resolve));
    },
  });

  const done = exa.run(h.deps, SIGNAL);
  await flush();
  pending.get(usageUrl("key_02"))?.({ reason: "http-401", status: 401 });
  await flush();
  pending.get(usageUrl("key_01"))?.({ reason: "network" });
  pending.get(usageUrl("key_03"))?.(ok(usageBody(1)));

  const result = success(await done);
  assert.deepEqual(result.facets.limits, { state: "unavailable", reason: "network" });
  assert.deepEqual(result.firstFailure, { reason: "network" });
});

test("no keys yields a zero spend window and no usage request", async () => {
  const h = harness({
    responses: new Map<string, TransportOutcome>([
      [CREDITS_URL, ok(creditsBody(0))],
      [KEYS_URL, ok(keysBody([]))],
    ]),
  });
  const result = success(await exa.run(h.deps, SIGNAL));
  assert.equal(h.requests.length, 2);
  assert.deepEqual(result.facets.limits, { state: "known", value: [spendWindow(0)] });
});

test("a repeated publicId is requested once", async () => {
  const h = harness({
    responses: new Map<string, TransportOutcome>([
      [CREDITS_URL, ok(creditsBody(1))],
      [KEYS_URL, ok(keysBody(["key_01", "key_01"]))],
      [usageUrl("key_01"), ok(usageBody(2))],
    ]),
  });
  const result = success(await exa.run(h.deps, SIGNAL));
  assert.deepEqual(h.requests.map((request) => request.url).slice(2), [usageUrl("key_01")]);
  assert.deepEqual(result.facets.limits, { state: "known", value: [spendWindow(2)] });
});

test("the spend is the sum of the usage costs, rounded to two decimals", async () => {
  const rounded = await runOver(["key_01", "key_02"], [0.1, 0.2]);
  assert.deepEqual(spend(rounded), [spendWindow(0.3)]);

  const more = await runOver(["key_01", "key_02", "key_03"], [0.1, 0.2, 1.234]);
  assert.deepEqual(spend(more), [spendWindow(1.53)]);
});

for (const body of [
  "{}",
  '{"total_cost_usd":-0.01}',
  '{"total_cost_usd":"1.25"}',
  '{"total_cost_usd":null}',
  "[]",
  "not json",
] as const) {
  test(`a usage body without a cost is bad-response: ${body}`, async () => {
    const responses = new Map(recorded());
    responses.set(usageUrl("key_01"), ok(body));
    const h = harness({ responses });
    const result = success(await exa.run(h.deps, SIGNAL));
    assert.deepEqual(result.facets.limits, { state: "unavailable", reason: "bad-response" });
    assert.deepEqual(result.firstFailure, { reason: "bad-response" });
    assert.deepEqual(result.facets.balance, {
      state: "known",
      value: [{ amount: 42.5, currency: "USD", currencyAssumed: false, gatesUsage: true }],
    });
  });
}

for (const body of [
  '{"apiKeys":{}}',
  '{"apiKeys":"key_01"}',
  '{"apiKeys":[{"publicId":"bad id"}]}',
  '{"apiKeys":[{"publicId":""}]}',
  `{"apiKeys":[{"publicId":"${"k".repeat(129)}"}]}`,
  '{"apiKeys":[{"publicId":"key_01"},5]}',
  '{"apiKeys":[{"publicId":"key_01"},{"publicId":5}]}',
  "[]",
  "not json",
] as const) {
  test(`a key list body without valid publicIds is bad-response: ${body}`, async () => {
    const responses = new Map(recorded());
    responses.set(KEYS_URL, ok(body));
    const h = harness({ responses });
    const result = success(await exa.run(h.deps, SIGNAL));
    assert.deepEqual(result.facets.limits, { state: "unavailable", reason: "bad-response" });
    assert.deepEqual(result.firstFailure, { reason: "bad-response" });
    assert.equal(h.requests.length, 2, "no usage request");
  });
}

test("more than 32 keys is response-too-large without usage requests", async () => {
  const publicIds = Array.from({ length: 33 }, (_, index) => `key_${String(index)}`);
  const h = harness({
    responses: new Map<string, TransportOutcome>([
      [CREDITS_URL, ok(creditsBody(1))],
      [KEYS_URL, ok(keysBody(publicIds))],
    ]),
  });
  const result = success(await exa.run(h.deps, SIGNAL));
  assert.equal(h.requests.length, 2);
  assert.deepEqual(result.facets.limits, { state: "unavailable", reason: "response-too-large" });
  assert.deepEqual(result.firstFailure, { reason: "response-too-large" });
});

test("32 keys are allowed", async () => {
  const publicIds = Array.from({ length: 32 }, (_, index) => `key_${String(index)}`);
  const h = harness({
    responses: new Map<string, TransportOutcome>([
      [CREDITS_URL, ok(creditsBody(1))],
      [KEYS_URL, ok(keysBody(publicIds))],
      ...publicIds.map((publicId) => [usageUrl(publicId), ok(usageBody(1))] as const),
    ]),
  });
  const result = success(await exa.run(h.deps, SIGNAL));
  assert.equal(h.requests.length, 34);
  assert.deepEqual(result.facets.limits, { state: "known", value: [spendWindow(32)] });
});

for (const body of [
  "{}",
  '{"credits_usd":"1.5"}',
  '{"credits_usd":null}',
  "[]",
  "not json",
] as const) {
  test(`a credits body without a finite credits_usd is bad-response: ${body}`, async () => {
    const responses = new Map(recorded());
    responses.set(CREDITS_URL, ok(body));
    const h = harness({ responses });
    const result = success(await exa.run(h.deps, SIGNAL));
    assert.deepEqual(result.facets.balance, { state: "unavailable", reason: "bad-response" });
    assert.deepEqual(result.firstFailure, { reason: "bad-response" });
    assert.deepEqual(result.facets.limits, { state: "known", value: [spendWindow(3.75)] });
  });
}

test("a failed credits request makes only balance unavailable", async () => {
  const responses = new Map(recorded());
  responses.set(CREDITS_URL, { reason: "http-403", status: 403 });
  const result = success(await exa.run(harness({ responses }).deps, SIGNAL));
  assert.deepEqual(result.facets.balance, { state: "unavailable", reason: "http-403" });
  assert.deepEqual(result.facets.limits, { state: "known", value: [spendWindow(3.75)] });
  assert.deepEqual(result.firstFailure, { reason: "http-403" });
});

test("when both requests fail the credits failure comes first in issue order", async () => {
  const responses = new Map<string, TransportOutcome>([
    [CREDITS_URL, { reason: "http-error", status: 500 }],
    [KEYS_URL, { reason: "http-401", status: 401 }],
  ]);
  const result = success(await exa.run(harness({ responses }).deps, SIGNAL));
  assert.deepEqual(result.facets.balance, { state: "unavailable", reason: "http-error" });
  assert.deepEqual(result.facets.limits, { state: "unavailable", reason: "http-401" });
  assert.deepEqual(result.firstFailure, { reason: "http-error" });
});

test("a missing credential is a whole failure without a request", async () => {
  const h = harness({ credentials: undefined });
  const result = await exa.run(h.deps, SIGNAL);
  assert.equal(failure(result).reason, "no-credentials");
  assert.equal("facets" in result, false);
  assert.equal(h.requests.length, 0);
});

test("a failing credential lookup is internal, not a throw", async () => {
  const { deps } = harness();
  const result = await exa.run(
    { ...deps, credentials: async () => Promise.reject(new Error("registry failure")) },
    SIGNAL,
  );
  assert.equal(failure(result).reason, "internal");
});

test("a rejecting transport is internal, not a throw", async () => {
  const h = harness({
    transport: async () => {
      throw new Error("transport broke");
    },
  });
  assert.equal(failure(await exa.run(h.deps, SIGNAL)).reason, "internal");
});
