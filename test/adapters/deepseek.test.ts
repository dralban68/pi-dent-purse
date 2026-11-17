/**
 * Tests for the DeepSeek adapter (specs/adapter-deepseek.md) against a fake transport: the
 * success mapping from recorded, redacted fixtures, and every failure the spec lists. No test
 * touches the network; the fixtures under test/fixtures/deepseek/ are read from disk.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deepseek } from "../../lib/adapters/deepseek.ts";
import type {
  AdapterDependencies,
  InventoryModel,
  CheckedCredentials,
  TransportFailure,
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
  ReasonCode,
  Severity,
} from "../../lib/state.ts";

const SIGNAL = new AbortController().signal;

/** The documented concurrency limits (adapter-deepseek.md Section 3). */
const EXPECTED_LIMITS: LimitWindowCapture[] = [
  {
    id: "concurrency-deepseek-flash",
    label: "concurrency flash",
    unit: "concurrent-requests",
    used: null,
    limit: 2500,
    percent: null,
    resetsAt: null,
    windowSeconds: null,
    models: ["deepseek-flash"],
    source: "documented",
  },
  {
    id: "concurrency-deepseek-v4-pro",
    label: "concurrency pro",
    unit: "concurrent-requests",
    used: null,
    limit: 500,
    percent: null,
    resetsAt: null,
    windowSeconds: null,
    models: ["deepseek-v4-pro"],
    source: "documented",
  },
];

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/deepseek/${name}`, import.meta.url), "utf8");
}

function ok(body: string, status = 200): TransportOutcome {
  return { status, headers: { "content-type": "application/json" }, body };
}

function model(id: string, baseUrl = "https://api.deepseek.com"): InventoryModel {
  return {
    id,
    baseUrl,
    cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  };
}

function inventory(): InventoryModel[] {
  return [model("deepseek-flash"), model("deepseek-v4-pro")];
}

function defaultCredentials(): CheckedCredentials {
  return { apiKey: "test-api-key", oauth: false };
}

interface HarnessOptions {
  /** Transport outcomes in issue order; one recorded balance body when absent. */
  outcomes?: TransportOutcome[];
  /** Explicit credentials; absent means a key for the provider. */
  credentials?: CheckedCredentials | undefined;
  inventory?: InventoryModel[];
}

interface Harness {
  deps: AdapterDependencies;
  requests: TransportRequest[];
  commands: number;
}

/** Dependencies over a fake transport; every other dependency is inert. */
function harness(options: HarnessOptions = {}): Harness {
  const requests: TransportRequest[] = [];
  const outcomes = options.outcomes ?? [ok(fixture("balance-usd.json"))];
  const queue = [...outcomes];
  const credentials = "credentials" in options ? options.credentials : defaultCredentials();
  const collected: Harness = {
    requests,
    commands: 0,
    deps: {
      transport: async (request) => {
        requests.push(request);
        const next = queue.shift();
        return next ?? ok(fixture("balance-usd.json"));
      },
      commandRunner: async () => {
        collected.commands += 1;
        throw new Error("the deepseek adapter runs no command");
      },
      credentials: async () => credentials,
      inventory: options.inventory ?? inventory(),
      clock: () => 1_760_000_000_000,
      configuration: {},
      store: {
        get: () => undefined,
        set: () => {},
      },
      observations: { latest: () => undefined },
    },
  };
  return collected;
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

/** The reason an `unavailable` balance facet carries. */
function balanceReason(result: AdapterResult): ReasonCode {
  const facet = success(result).facets.balance;
  if (facet === undefined) assert.fail("missing balance facet");
  if (facet.state !== "unavailable") assert.fail(`expected unavailable, got ${facet.state}`);
  return facet.reason;
}

function item(amount: number, currency: string, severity?: Severity): BalanceItemCapture {
  const captured: BalanceItemCapture = {
    amount,
    currency,
    currencyAssumed: false,
    gatesUsage: true,
  };
  return severity === undefined ? captured : { ...captured, severity };
}

test("the adapter declares its spec constants", () => {
  assert.equal(deepseek.id, "deepseek");
  assert.equal(deepseek.providerOrigin, "https://api.deepseek.com");
  assert.deepEqual(deepseek.hostAllowlist, ["https://api.deepseek.com"]);
  assert.deepEqual(deepseek.exposedFacets, ["balance", "limits"]);
  assert.equal(deepseek.freshnessSeconds, 300);
});

test("success: one USD balance item and the documented limits", async () => {
  const { deps, requests, commands } = harness();
  const result = await deepseek.run(deps, SIGNAL);

  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request !== undefined);
  assert.equal(request.url, "https://api.deepseek.com/user/balance");
  assert.deepEqual(request.headers, { authorization: "Bearer test-api-key" });
  assert.equal(request.bodyCap, 16 * 1024);
  assert.equal(request.signal, SIGNAL);
  assert.equal(commands, 0);

  const run = success(result);
  assert.deepEqual(run.facets.balance, { state: "known", value: [item(42.5, "USD")] });
  assert.deepEqual(run.facets.limits, { state: "known", value: EXPECTED_LIMITS });
  assert.equal(run.firstFailure, undefined);
  assert.equal(run.capturedAt, undefined);
  assert.equal(run.captureReason, undefined);
});

test("the documented limits carry no severity override", async () => {
  const [flash, pro] = known(success(await deepseek.run(harness().deps, SIGNAL)).facets.limits);
  assert.ok(flash !== undefined && pro !== undefined);
  assert.equal("severity" in flash, false);
  assert.equal("severity" in pro, false);
  assert.deepEqual(pro.models, ["deepseek-v4-pro"]);
});

test("multiple currencies yield one item each, never summed", async () => {
  const result = await deepseek.run(
    harness({ outcomes: [ok(fixture("balance-multi-currency.json"))] }).deps,
    SIGNAL,
  );
  assert.deepEqual(balanceItems(result), [item(310, "CNY"), item(18.75, "USD")]);
});

test("is_available false makes every item exhausted", async () => {
  const result = await deepseek.run(
    harness({ outcomes: [ok(fixture("balance-exhausted.json"))] }).deps,
    SIGNAL,
  );
  assert.deepEqual(balanceItems(result), [
    item(0, "USD", "exhausted"),
    item(12, "CNY", "exhausted"),
  ]);
});

test("is_available true leaves severity to entry derivation", async () => {
  const items = balanceItems(await deepseek.run(harness().deps, SIGNAL));
  const first = items[0];
  assert.ok(first !== undefined);
  assert.equal("severity" in first, false);
});

test("a repeated currency keeps the first valid item", async () => {
  const body = JSON.stringify({
    is_available: true,
    balance_infos: [
      { currency: "USD", total_balance: 7.5 },
      { currency: "USD", total_balance: "10.00" },
      { currency: "USD", total_balance: "99.00" },
    ],
  });
  const result = await deepseek.run(harness({ outcomes: [ok(body)] }).deps, SIGNAL);
  assert.deepEqual(balanceItems(result), [item(10, "USD")]);
});

test("a negative total_balance is an item", async () => {
  const body = JSON.stringify({
    is_available: true,
    balance_infos: [{ currency: "CNY", total_balance: "-12.34" }],
  });
  const result = await deepseek.run(harness({ outcomes: [ok(body)] }).deps, SIGNAL);
  assert.deepEqual(balanceItems(result), [item(-12.34, "CNY")]);
});

test("an amount beyond a finite number is skipped", async () => {
  const body = JSON.stringify({
    is_available: true,
    balance_infos: [
      { currency: "CNY", total_balance: "9".repeat(400) },
      { currency: "USD", total_balance: "1.25" },
    ],
  });
  const result = await deepseek.run(harness({ outcomes: [ok(body)] }).deps, SIGNAL);
  assert.deepEqual(balanceItems(result), [item(1.25, "USD")]);
});

test("empty balance_infos: balance is unavailable with empty-response", async () => {
  const result = await deepseek.run(
    harness({ outcomes: [ok(fixture("balance-empty.json"))] }).deps,
    SIGNAL,
  );
  assert.equal(balanceReason(result), "empty-response");
  const run = success(result);
  assert.deepEqual(run.facets.limits, { state: "known", value: EXPECTED_LIMITS });
});

test("no usable balance entry: balance is unavailable with empty-response", async () => {
  const result = await deepseek.run(
    harness({ outcomes: [ok(fixture("balance-invalid-entries.json"))] }).deps,
    SIGNAL,
  );
  assert.equal(balanceReason(result), "empty-response");
  assert.deepEqual(success(result).facets.limits, { state: "known", value: EXPECTED_LIMITS });
});

for (const body of ['{"is_available":true}', '{"balance_infos":"USD"}', "[]", "null", '"text"']) {
  test(`a body without a balance_infos array is bad-response: ${body}`, async () => {
    const result = await deepseek.run(harness({ outcomes: [ok(body)] }).deps, SIGNAL);
    assert.equal(balanceReason(result), "bad-response");
    assert.deepEqual(success(result).firstFailure, { reason: "bad-response" });
    assert.deepEqual(success(result).facets.limits, { state: "known", value: EXPECTED_LIMITS });
  });
}

for (const [name, body] of [
  ["an HTML error page", fixture("error-page.html")],
  ["an empty body", ""],
  ["a truncated object", '{"is_available":'],
] as const) {
  test(`a non-JSON body is bad-response: ${name}`, async () => {
    const result = await deepseek.run(harness({ outcomes: [ok(body)] }).deps, SIGNAL);
    assert.equal(balanceReason(result), "bad-response");
  });
}

const TRANSPORT_FAILURES: TransportFailure[] = [
  { reason: "http-401", status: 401 },
  { reason: "http-403", status: 403 },
  { reason: "http-429", status: 429, retryAfter: 30 },
  { reason: "http-429", status: 429 },
  { reason: "http-error", status: 402 },
  { reason: "http-error", status: 500 },
  { reason: "redirect", status: 302 },
  { reason: "network" },
  { reason: "timeout" },
  { reason: "deadline" },
  { reason: "response-too-large", status: 200 },
];

for (const transportFailure of TRANSPORT_FAILURES) {
  test(`a failed request carries ${transportFailure.reason} ${transportFailure.status ?? ""}`, async () => {
    const result = await deepseek.run(harness({ outcomes: [transportFailure] }).deps, SIGNAL);
    const run = success(result);
    assert.equal(balanceReason(result), transportFailure.reason);
    const expected: AdapterFailure =
      transportFailure.retryAfter === undefined
        ? { reason: transportFailure.reason }
        : { reason: transportFailure.reason, retryAfter: transportFailure.retryAfter };
    assert.deepEqual(run.firstFailure, expected);
    assert.deepEqual(run.facets.limits, { state: "known", value: EXPECTED_LIMITS });
  });
}

test("a balance request failing with http-429 is not a whole failure (Section 3)", async () => {
  const result = await deepseek.run(
    harness({ outcomes: [{ reason: "http-429", status: 429, retryAfter: 30 }] }).deps,
    SIGNAL,
  );
  const run = success(result);
  assert.deepEqual(run.facets.limits, { state: "known", value: EXPECTED_LIMITS });
  assert.deepEqual(run.facets.balance, { state: "unavailable", reason: "http-429" });
  assert.deepEqual(run.firstFailure, { reason: "http-429", retryAfter: 30 });
});

test("missing credentials is a whole failure", async () => {
  const { deps, requests } = harness({ credentials: undefined });
  const result = await deepseek.run(deps, SIGNAL);
  assert.equal(failure(result).reason, "no-credentials");
  assert.equal("facets" in result, false);
  assert.equal(requests.length, 0);
});

test("an OAuth credential is accepted like an API key", async () => {
  const { deps, requests } = harness({ credentials: { apiKey: "test-api-key", oauth: true } });
  assert.equal(success(await deepseek.run(deps, SIGNAL)).facets.balance?.state, "known");
  assert.equal(requests[0]?.headers?.authorization, "Bearer test-api-key");
});

test("a failing credential lookup is internal, not a throw", async () => {
  const { deps } = harness();
  const result = await deepseek.run(
    { ...deps, credentials: async () => Promise.reject(new Error("registry failure")) },
    SIGNAL,
  );
  assert.equal(failure(result).reason, "internal");
});

test("a rejecting transport is internal, not a throw", async () => {
  const { deps, requests } = harness();
  const result = await deepseek.run(
    {
      ...deps,
      transport: async (request) => {
        requests.push(request);
        throw new Error("transport broke");
      },
    },
    SIGNAL,
  );
  assert.equal(failure(result).reason, "internal");
});
