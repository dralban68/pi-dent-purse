import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { AdapterDependencies, TransportOutcome, TransportRequest } from "../../lib/adapter.ts";
import { zai } from "../../lib/adapters/zai.ts";
import type {
  AdapterResult,
  AdapterSuccess,
  BalanceItemCapture,
  LimitWindowCapture,
} from "../../lib/state.ts";

const NOW = 1794375000000; // 2026-11-11T05:30:00.000Z
const KEY = "unit-test-key";

const QUOTA = "/api/monitor/usage/quota/limit";
const PLAN = "/api/biz/subscription/list";
const BALANCE = "/api/biz/account/query-customer-account-report";

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/zai/${name}`, import.meta.url), "utf8");
}

function ok(body: string): TransportOutcome {
  return { status: 200, headers: {}, body };
}

type Responder = (request: TransportRequest) => TransportOutcome | Promise<TransportOutcome>;

interface Harness {
  deps: AdapterDependencies;
  requests: TransportRequest[];
  signal: AbortSignal;
}

const MODEL = {
  id: "glm-5.3",
  baseUrl: "https://api.z.ai/api/coding/paas/v4",
  cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
};

function harness(responder: Responder, overrides: Partial<AdapterDependencies> = {}): Harness {
  const requests: TransportRequest[] = [];
  const values = new Map<string, unknown>();
  const deps: AdapterDependencies = {
    transport: async (request) => {
      requests.push(request);
      return responder(request);
    },
    commandRunner: async () => {
      throw new Error("the zai adapter runs no commands");
    },
    credentials: async () => ({ apiKey: KEY, oauth: false }),
    inventory: [MODEL],
    clock: () => NOW,
    configuration: {},
    store: {
      get: (key) => values.get(key),
      set: (key, value) => {
        values.set(key, value);
      },
    },
    observations: { latest: () => undefined },
    ...overrides,
  };
  const signal = new AbortController().signal;
  return { deps, requests, signal };
}

/** Routes a request by the suffix of its URL; anything else is a network failure. */
function routed(routes: Record<string, TransportOutcome>): Responder {
  return (request) => {
    for (const [suffix, outcome] of Object.entries(routes)) {
      if (request.url.endsWith(suffix)) return outcome;
    }
    return { reason: "network" };
  };
}

function recorded(): Record<string, TransportOutcome> {
  return {
    [QUOTA]: ok(fixture("quota-limit.json")),
    [PLAN]: ok(fixture("subscription-list.json")),
    [BALANCE]: ok(fixture("account-report.json")),
  };
}

function success(result: AdapterResult): AdapterSuccess {
  if ("reason" in result) assert.fail(`expected an adapter success, got ${result.reason}`);
  return result;
}

function limitWindows(result: AdapterSuccess): LimitWindowCapture[] {
  const facet = result.facets.limits;
  if (facet === undefined || facet.state !== "known") assert.fail("limits is not known");
  return facet.value;
}

function limitsReason(result: AdapterSuccess): string {
  const facet = result.facets.limits;
  if (facet === undefined || facet.state !== "unavailable")
    assert.fail("limits is not unavailable");
  return facet.reason;
}

function planValue(result: AdapterSuccess): string {
  const facet = result.facets.plan;
  if (facet === undefined || facet.state !== "known") assert.fail("plan is not known");
  return facet.value;
}

function planReason(result: AdapterSuccess): string {
  const facet = result.facets.plan;
  if (facet === undefined || facet.state !== "unavailable") assert.fail("plan is not unavailable");
  return facet.reason;
}

function balanceItems(result: AdapterSuccess): BalanceItemCapture[] {
  const facet = result.facets.balance;
  if (facet === undefined || facet.state !== "known") assert.fail("balance is not known");
  return facet.value;
}

function balanceReason(result: AdapterSuccess): string {
  const facet = result.facets.balance;
  if (facet === undefined || facet.state !== "unavailable") {
    assert.fail("balance is not unavailable");
  }
  return facet.reason;
}

/** Runs the adapter against one quota body, with the plan and balance fixtures. */
async function quotaRun(body: string, clock = NOW): Promise<AdapterSuccess> {
  const h = harness(routed({ ...recorded(), [QUOTA]: ok(body) }), { clock: () => clock });
  return success(await zai.run(h.deps, h.signal));
}

test("profile constants (Section 1)", () => {
  assert.equal(zai.id, "zai");
  assert.equal(zai.providerOrigin, "https://api.z.ai");
  assert.deepEqual(zai.hostAllowlist, ["https://api.z.ai"]);
  assert.deepEqual(zai.exposedFacets, ["plan", "balance", "limits"]);
  assert.equal(zai.freshnessSeconds, 300);
});

test("the recorded success fixtures yield all three facets (Sections 2-5)", async () => {
  const h = harness(routed(recorded()));
  const result = success(await zai.run(h.deps, h.signal));

  assert.deepEqual(result.facets.plan, { state: "known", value: "GLM Coding Pro" });
  assert.deepEqual(limitWindows(result), [
    {
      id: "five-hour",
      label: "5h",
      unit: "credits",
      used: 4200,
      limit: 10000,
      percent: 42,
      resetsAt: 1794381169036,
      windowSeconds: 18000,
      models: null,
      source: "endpoint",
    },
    {
      id: "weekly",
      label: "7d",
      unit: "credits",
      used: 47500,
      limit: 50000,
      percent: 95,
      resetsAt: 1794960000000,
      windowSeconds: 604800,
      models: null,
      source: "endpoint",
    },
  ]);
  assert.deepEqual(balanceItems(result), [
    { amount: 12.5, currency: "USD", currencyAssumed: true, gatesUsage: false },
  ]);
  assert.equal("firstFailure" in result, false);
  assert.equal("capturedAt" in result, false);
  assert.equal("captureReason" in result, false);
});

test("each request is one GET of Section 2 with only the listed header", async () => {
  const h = harness(routed(recorded()));
  await zai.run(h.deps, h.signal);

  assert.deepEqual(
    h.requests.map((request) => request.url),
    [`https://api.z.ai${QUOTA}`, `https://api.z.ai${PLAN}`, `https://api.z.ai${BALANCE}`],
  );
  for (const request of h.requests) {
    assert.deepEqual(request.headers, { authorization: `Bearer ${KEY}` });
    assert.equal(request.bodyCap, 64 * 1024);
    assert.equal(request.signal, h.signal);
  }
});

test("a missing credential is a whole failure without a request (contract Section 2)", async () => {
  const h = harness(routed(recorded()), { credentials: async () => undefined });
  assert.deepEqual(await zai.run(h.deps, h.signal), { reason: "no-credentials" });
  assert.equal(h.requests.length, 0);
});

test("each transport failure makes the facets it feeds unavailable (Section 2)", async () => {
  const cases: Array<{ name: string; failure: TransportOutcome; retryAfter?: number }> = [
    { name: "network", failure: { reason: "network" } },
    { name: "timeout", failure: { reason: "timeout" } },
    { name: "deadline", failure: { reason: "deadline" } },
    { name: "redirect", failure: { reason: "redirect", status: 302 } },
    { name: "response-too-large", failure: { reason: "response-too-large" } },
    { name: "http-401", failure: { reason: "http-401", status: 401 } },
    { name: "http-403", failure: { reason: "http-403", status: 403 } },
    {
      name: "http-429",
      failure: { reason: "http-429", status: 429, retryAfter: 42 },
      retryAfter: 42,
    },
    { name: "http-error", failure: { reason: "http-error", status: 500 } },
  ];

  for (const { name, failure, retryAfter } of cases) {
    const h = harness(routed({ ...recorded(), [QUOTA]: failure }));
    const result = success(await zai.run(h.deps, h.signal));
    assert.equal(limitsReason(result), name);
    assert.equal(planValue(result), "GLM Coding Pro");
    assert.equal(balanceItems(result)[0]?.amount, 12.5);
    assert.deepEqual(
      result.firstFailure,
      retryAfter === undefined ? { reason: name } : { reason: name, retryAfter },
    );
  }
});

test("a failed quota request leaves the plan to the plan request (Section 4)", async () => {
  const h = harness(routed({ ...recorded(), [QUOTA]: { reason: "http-403", status: 403 } }));
  const result = success(await zai.run(h.deps, h.signal));
  assert.deepEqual(result.facets.plan, { state: "known", value: "GLM Coding Pro" });
  assert.equal(limitsReason(result), "http-403");
});

test("a failed plan request falls back to the quota level (Section 4)", async () => {
  const h = harness(routed({ ...recorded(), [PLAN]: { reason: "http-403", status: 403 } }));
  const result = success(await zai.run(h.deps, h.signal));
  assert.deepEqual(result.facets.plan, { state: "known", value: "pro" });
  assert.equal(limitWindows(result).length, 2);
});

test("both plan sources failing leaves the plan with the plan request's reason (Section 4)", async () => {
  const h = harness(
    routed({
      ...recorded(),
      [PLAN]: { reason: "http-401", status: 401 },
      [QUOTA]: { reason: "http-error", status: 500 },
    }),
  );
  const result = success(await zai.run(h.deps, h.signal));
  assert.equal(planReason(result), "http-401");
  assert.deepEqual(result.firstFailure, { reason: "http-error" });
});

test("a plan request that returns no VALID plan is empty-response (Section 4)", async () => {
  const bodies = [
    '{"code":200,"success":true,"data":[]}',
    '{"code":200,"success":true,"data":[{"productName":"GLM Coding Pro","status":"EXPIRED"}]}',
    '{"code":200,"success":true,"data":[{"productName":42,"status":"VALID"}]}',
    '{"code":200,"success":true}',
    '{"code":200,"success":true,"data":{"productName":"GLM Coding Pro","status":"VALID"}}',
  ];
  for (const body of bodies) {
    const h = harness(
      routed({
        ...recorded(),
        [QUOTA]: ok('{"code":200,"success":true,"data":{}}'),
        [PLAN]: ok(body),
      }),
    );
    const result = success(await zai.run(h.deps, h.signal));
    assert.equal(planReason(result), "empty-response", body);
  }
});

test("a plan VALID entry falls back to the quota level when it has no productName", async () => {
  const h = harness(
    routed({
      ...recorded(),
      [PLAN]: ok('{"code":200,"success":true,"data":[{"productName":42,"status":"VALID"}]}'),
    }),
  );
  assert.deepEqual(success(await zai.run(h.deps, h.signal)).facets.plan, {
    state: "known",
    value: "pro",
  });
});

test("a plan productName is cleaned and cut to 64 code points (billing-state.md Section 7)", async () => {
  const name = "\u0007  GLM Coding Pro  " + "y".repeat(80);
  const h = harness(
    routed({
      ...recorded(),
      [PLAN]: ok(
        JSON.stringify({
          code: 200,
          success: true,
          data: [{ productName: name, status: "VALID" }],
        }),
      ),
    }),
  );
  const value = planValue(success(await zai.run(h.deps, h.signal)));
  assert.equal(value, "GLM Coding Pro  " + "y".repeat(48));
  assert.equal(Array.from(value).length, 64);
});

test("the balance request's failure makes balance unavailable with its reason (Section 5)", async () => {
  const h = harness(
    routed({ ...recorded(), [BALANCE]: { reason: "http-429", status: 429, retryAfter: 9 } }),
  );
  const result = success(await zai.run(h.deps, h.signal));
  assert.equal(balanceReason(result), "http-429");
  assert.deepEqual(result.firstFailure, { reason: "http-429", retryAfter: 9 });
});

test("the balance item is availableBalance in an assumed USD (Section 5)", async () => {
  for (const [numbers, amount] of [
    ['"availableBalance":0E-9', 0],
    ['"availableBalance":-3.25', -3.25],
  ] as const) {
    const body = `{"code":200,"success":true,"data":{${numbers}}}`;
    const h = harness(routed({ ...recorded(), [BALANCE]: ok(body) }));
    const result = success(await zai.run(h.deps, h.signal));
    assert.deepEqual(balanceItems(result), [
      { amount, currency: "USD", currencyAssumed: true, gatesUsage: false },
    ]);
  }
});

test("a non-numeric availableBalance is bad-response (Section 5)", async () => {
  for (const data of [
    '{"availableBalance":"12.5"}',
    '{"availableBalance":1e400}',
    '{"availableBalance":null}',
    "{}",
    "[]",
    "null",
  ]) {
    const h = harness(
      routed({ ...recorded(), [BALANCE]: ok(`{"code":200,"success":true,"data":${data}}`) }),
    );
    const result = success(await zai.run(h.deps, h.signal));
    assert.equal(balanceReason(result), "bad-response", data);
  }
});

test("a body that is not an object is bad-response (Section 2)", async () => {
  for (const body of [
    "<html>error</html>",
    "",
    "[]",
    "null",
    "true",
    "42",
    '"text"',
    "{",
    "\u0007",
  ]) {
    const h = harness(routed({ ...recorded(), [QUOTA]: ok(body) }));
    const result = success(await zai.run(h.deps, h.signal));
    assert.equal(limitsReason(result), "bad-response", JSON.stringify(body));
    assert.deepEqual(result.firstFailure, { reason: "bad-response" });
  }
});

test("an envelope that reports failure is vendor-error, even with HTTP 200 (Section 2)", async () => {
  for (const body of [
    fixture("envelope-error.json"),
    '{"code":200,"success":false}',
    '{"code":500,"success":true}',
    '{"code":"200","success":true}',
    '{"success":true}',
    '{"code":200,"success":"true"}',
  ]) {
    const h = harness(routed({ ...recorded(), [QUOTA]: ok(body) }));
    const result = success(await zai.run(h.deps, h.signal));
    assert.equal(limitsReason(result), "vendor-error", body);
    assert.deepEqual(planValue(result), "GLM Coding Pro");
    assert.deepEqual(result.firstFailure, { reason: "vendor-error" });
  }
});

test("a successful quota request without windows is empty-response (Section 3)", async () => {
  for (const body of [
    '{"code":200,"success":true}',
    '{"code":200,"success":true,"data":{}}',
    '{"code":200,"success":true,"data":{"limits":[]}}',
    '{"code":200,"success":true,"data":{"limits":"nope"}}',
    '{"code":200,"success":true,"data":{"limits":null}}',
    '{"code":200,"success":true,"data":{"limits":[null,"x",{"type":"OTHER","unit":3}]}}',
  ]) {
    const result = await quotaRun(body);
    assert.equal(limitsReason(result), "empty-response", body);
    assert.equal("firstFailure" in result, false);
  }
});

test("quota elements map to the Section 3 windows", async () => {
  const result = await quotaRun(
    JSON.stringify({
      code: 200,
      success: true,
      data: {
        limits: [
          { type: "CREDIT_LIMIT", unit: 2, usage: 1, currentValue: 1 },
          { type: "OTHER", unit: 3, usage: 1, currentValue: 1 },
          {
            type: "TOKENS_LIMIT",
            unit: 3,
            number: 2,
            usage: 100,
            total: 200,
            currentValue: "9",
            percentage: -1,
            nextResetTime: 123,
          },
          { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 900, currentValue: 90 },
          {
            type: "CREDIT_LIMIT",
            unit: 6,
            number: 7,
            total: 500,
            currentValue: 5,
            percentage: 1,
            nextResetTime: 111,
          },
          { type: "TIME_LIMIT", unit: 5, number: 1, usage: 2000, currentValue: 20 },
        ],
      },
    }),
  );

  assert.deepEqual(limitWindows(result), [
    {
      id: "five-hour",
      label: "5h",
      unit: "tokens",
      used: null,
      limit: 100,
      percent: -1,
      resetsAt: 123,
      windowSeconds: 7200,
      models: null,
      source: "endpoint",
    },
    {
      id: "weekly",
      label: "7d",
      unit: "credits",
      used: 5,
      limit: 500,
      percent: 1,
      resetsAt: 111,
      windowSeconds: 604800,
      models: null,
      source: "endpoint",
    },
    {
      id: "tool-calls-monthly",
      label: "tools/mo",
      unit: "requests",
      used: 20,
      limit: 2000,
      percent: null,
      resetsAt: 1796083200000, // 2026-12-01T00:00:00.000Z
      windowSeconds: null,
      models: null,
      source: "endpoint",
    },
  ]);
});

test("the five-hour window defaults to 18000 seconds without a numeric number", async () => {
  const result = await quotaRun(
    '{"code":200,"success":true,"data":{"limits":[{"type":"CREDIT_LIMIT","unit":3,"usage":10,"currentValue":1}]}}',
  );
  assert.equal(limitWindows(result)[0]?.windowSeconds, 18000);
});

test("non-numeric window fields are null (Section 3)", async () => {
  const result = await quotaRun(
    '{"code":200,"success":true,"data":{"limits":[{"type":"TOKENS_LIMIT","unit":6,"number":1e400,"usage":1e400,"currentValue":"5","percentage":1e400,"nextResetTime":"1794960000000"}]}}',
  );
  assert.deepEqual(limitWindows(result)[0], {
    id: "weekly",
    label: "7d",
    unit: "tokens",
    used: null,
    limit: null,
    percent: null,
    resetsAt: null,
    windowSeconds: 604800,
    models: null,
    source: "endpoint",
  });
});

test("a TIME_LIMIT reset uses the first instant of the next month in UTC (Section 3)", async () => {
  const body =
    '{"code":200,"success":true,"data":{"limits":[{"type":"TIME_LIMIT","usage":2000,"currentValue":20}]}}';
  const decemberHarness = harness(routed({ ...recorded(), [QUOTA]: ok(body) }), {
    clock: () => Date.UTC(2026, 11, 15, 23, 59, 59),
  });
  const december = success(await zai.run(decemberHarness.deps, decemberHarness.signal));
  assert.equal(limitWindows(december)[0]?.resetsAt, Date.UTC(2027, 0, 1));

  const withReset = await quotaRun(
    '{"code":200,"success":true,"data":{"limits":[{"type":"TIME_LIMIT","usage":2000,"currentValue":20,"nextResetTime":777}]}}',
  );
  assert.equal(limitWindows(withReset)[0]?.resetsAt, 777);
});

test("the tools fixture maps the monthly lane and a tokens five-hour window (Section 3)", async () => {
  const h = harness(routed({ ...recorded(), [QUOTA]: ok(fixture("quota-limit-tools.json")) }));
  const result = success(await zai.run(h.deps, h.signal));
  const windows = limitWindows(result);
  assert.deepEqual(
    windows.map((window) => [window.id, window.unit, window.windowSeconds, window.resetsAt]),
    [
      ["tool-calls-monthly", "requests", null, 1796083200000],
      ["five-hour", "tokens", 18000, 1794381169036],
    ],
  );
});

test("all three requests failing keeps the facets' own reasons (Section 2)", async () => {
  const h = harness(
    routed({
      [QUOTA]: { reason: "http-429", status: 429, retryAfter: 5 },
      [PLAN]: { reason: "http-401", status: 401 },
      [BALANCE]: { reason: "network" },
    }),
  );
  const result = success(await zai.run(h.deps, h.signal));
  assert.equal(limitsReason(result), "http-429");
  assert.equal(planReason(result), "http-401");
  assert.equal(balanceReason(result), "network");
  assert.deepEqual(result.firstFailure, { reason: "http-429", retryAfter: 5 });
});

test("firstFailure follows issue order, not completion order (contract Section 2)", async () => {
  const pending = new Map<string, (outcome: TransportOutcome) => void>();
  const h = harness((request) => {
    const suffix = [QUOTA, PLAN, BALANCE].find((each) => request.url.endsWith(each));
    if (suffix === undefined) assert.fail(`unexpected request ${request.url}`);
    return new Promise<TransportOutcome>((resolve) => pending.set(suffix, resolve));
  });
  const settled = zai.run(h.deps, h.signal);

  // The adapter issues quota, plan, balance; settle them in the reverse order, so a first failure
  // taken by completion order would be the balance's 401 and only issue order yields the quota's.
  const outcomes: [string, TransportOutcome][] = [
    [BALANCE, { reason: "http-401", status: 401 }],
    [PLAN, ok(fixture("subscription-list.json"))],
    [QUOTA, { reason: "http-429", status: 429, retryAfter: 17 }],
  ];
  for (const [suffix, outcome] of outcomes) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settle = pending.get(suffix);
    if (settle === undefined) assert.fail(`${suffix} was not requested`);
    settle(outcome);
  }

  const result = success(await settled);
  assert.deepEqual(result.firstFailure, { reason: "http-429", retryAfter: 17 });
});

test("hostile responses resolve and never reject (contract Section 2)", async () => {
  const bodies = [
    "",
    "null",
    "true",
    "{}",
    "[]",
    '{"code":200,"success":true,"data":{"limits":[[]],"level":{}}}',
    '{"code":200,"success":true,"data":{"limits":[{"type":"CREDIT_LIMIT","unit":3,"number":{},"usage":[],"currentValue":[]}]}}',
  ];
  for (const body of bodies) {
    for (const suffix of [QUOTA, PLAN, BALANCE]) {
      const h = harness(routed({ ...recorded(), [suffix]: ok(body) }));
      const result = await zai.run(h.deps, h.signal);
      assert.equal("facets" in result, true, `${suffix} ${body}`);
    }
  }

  const throwing = harness(() => {
    throw new Error("transport bug");
  });
  assert.deepEqual(await zai.run(throwing.deps, throwing.signal), { reason: "internal" });

  const throwingCredentials = harness(routed(recorded()), {
    credentials: async () => {
      throw new Error("credentials bug");
    },
  });
  assert.deepEqual(await zai.run(throwingCredentials.deps, throwingCredentials.signal), {
    reason: "internal",
  });
});
