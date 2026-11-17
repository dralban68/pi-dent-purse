import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SEVERITY_THRESHOLDS,
  balanceSeverity,
  cleanVendorString,
  derivePercent,
  deriveProviderEntry,
  finiteNumber,
  limitWindowSeverity,
  modelSeverity,
  providerSeverity,
  type AdapterProfile,
  type BalanceItem,
  type BalanceItemCapture,
  type Capture,
  type CaptureFacets,
  type Facet,
  type LimitWindow,
  type LimitWindowCapture,
  type ModelPrice,
  type Price,
  type ProviderEntryInput,
  type Severity,
} from "../lib/state.ts";

const THRESHOLDS = DEFAULT_SEVERITY_THRESHOLDS;

function price(): Price {
  return {
    rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    tiers: [],
    source: "inventory",
    schedule: null,
  };
}

function modelA(): ModelPrice {
  return { id: "model-a", price: price() };
}

const ALL_FACETS: AdapterProfile = {
  exposedFacets: ["plan", "balance", "limits"],
  freshnessSeconds: 300,
};

const LIMITS_ONLY: AdapterProfile = {
  exposedFacets: ["limits"],
  freshnessSeconds: 120,
};

function captureAt(capturedAt: number, facets: CaptureFacets = {}): Capture {
  return { facets, capturedAt };
}

function entryInput(overrides: Partial<ProviderEntryInput> = {}): ProviderEntryInput {
  return {
    provider: "zai",
    now: 1_000_000,
    models: [modelA()],
    adapter: ALL_FACETS,
    settings: {},
    thresholds: THRESHOLDS,
    capture: null,
    failure: null,
    ...overrides,
  };
}

function capturedWindow(overrides: Partial<LimitWindowCapture> = {}): LimitWindowCapture {
  return {
    id: "five-hour",
    label: "5h",
    unit: "percent",
    used: null,
    limit: null,
    percent: 50,
    resetsAt: null,
    windowSeconds: 18000,
    models: null,
    source: "endpoint",
    ...overrides,
  };
}

function entryWindow(overrides: Partial<LimitWindow> = {}): LimitWindow {
  return {
    id: "five-hour",
    label: "5h",
    unit: "percent",
    used: null,
    limit: null,
    percent: 50,
    resetsAt: null,
    windowSeconds: 18000,
    models: null,
    source: "endpoint",
    severity: "ok",
    ...overrides,
  };
}

function entryBalance(overrides: Partial<BalanceItem> = {}): BalanceItem {
  return {
    amount: 10,
    currency: "USD",
    currencyAssumed: false,
    gatesUsage: true,
    severity: "ok",
    ...overrides,
  };
}

function capturedBalance(overrides: Partial<BalanceItemCapture> = {}): BalanceItemCapture {
  return {
    amount: 10,
    currency: "USD",
    currencyAssumed: false,
    gatesUsage: true,
    ...overrides,
  };
}

function known<T>(value: T): Facet<T> {
  return { state: "known", value };
}

test("cleanVendorString removes control characters, trims, and cuts to 64 characters", () => {
  assert.equal(cleanVendorString("  Pro plan  "), "Pro plan");
  assert.equal(cleanVendorString(" a\u0000b\tc\n "), "abc");
  assert.equal(cleanVendorString("a\tb"), "ab");
  assert.equal(cleanVendorString("x".repeat(64)), "x".repeat(64));
  assert.equal(cleanVendorString("x".repeat(65)), "x".repeat(64));
  assert.equal(cleanVendorString(`${"x".repeat(64)}tail`), "x".repeat(64));
});

test("cleanVendorString counts characters, not UTF-16 code units", () => {
  const cleaned = cleanVendorString("😀".repeat(65));
  assert.ok(cleaned !== null);
  assert.equal(Array.from(cleaned).length, 64);
});

test("cleanVendorString yields null when the result is absent", () => {
  assert.equal(cleanVendorString(""), null);
  assert.equal(cleanVendorString("   "), null);
  assert.equal(cleanVendorString("\u0000\t\n"), null);
});

test("cleanVendorString is not a general value sanitizer: non-strings are absent", () => {
  for (const value of [undefined, null, 5, true, {}, ["a"]]) {
    assert.equal(cleanVendorString(value), null, JSON.stringify(value));
  }
});

test("finiteNumber keeps finite numbers, including zero, and makes non-finite values absent", () => {
  assert.equal(finiteNumber(0), 0);
  assert.equal(finiteNumber(-5), -5);
  assert.equal(finiteNumber(1.5), 1.5);
  assert.equal(finiteNumber(Number.NaN), null);
  assert.equal(finiteNumber(Number.POSITIVE_INFINITY), null);
  assert.equal(finiteNumber(Number.NEGATIVE_INFINITY), null);
  for (const value of [undefined, null, "5", true, {}]) {
    assert.equal(finiteNumber(value), null, JSON.stringify(value));
  }
});

test("derivePercent: rules 2–4, one decimal, never turning an unknown into a number", () => {
  assert.equal(derivePercent(1, 3), 33.3);
  assert.equal(derivePercent(2, 3), 66.7);
  assert.equal(derivePercent(1, 7), 14.3);
  assert.equal(derivePercent(1, 8), 12.5);
  assert.equal(derivePercent(0, 100), 0);
  assert.equal(derivePercent(150, 100), 150);
  assert.equal(derivePercent(5, 0), 100);
  assert.equal(derivePercent(0, 0), 100);
  assert.equal(derivePercent(null, 100), null);
  assert.equal(derivePercent(null, 0), null);
  assert.equal(derivePercent(5, null), null);
  assert.equal(derivePercent(5, -1), null);
  assert.equal(derivePercent(Number.NaN, 100), null);
  assert.equal(derivePercent(5, Number.NaN), null);
});

test("derivePercent: rule 1 takes a captured percent that is finite and ≥ 0", () => {
  assert.equal(derivePercent(null, null, 42), 42);
  assert.equal(derivePercent(1, 4, 150), 150);
  assert.equal(derivePercent(1, 4, 0), 0);
  assert.equal(derivePercent(1, 4, -1), 25);
  assert.equal(derivePercent(1, 4, Number.NaN), 25);
  assert.equal(derivePercent(null, null, null), null);
});

test("limitWindowSeverity: boundaries at the configured thresholds", () => {
  assert.equal(limitWindowSeverity(0, THRESHOLDS), "ok");
  assert.equal(limitWindowSeverity(74.9, THRESHOLDS), "ok");
  assert.equal(limitWindowSeverity(75, THRESHOLDS), "low");
  assert.equal(limitWindowSeverity(89.9, THRESHOLDS), "low");
  assert.equal(limitWindowSeverity(90, THRESHOLDS), "critical");
  assert.equal(limitWindowSeverity(99.9, THRESHOLDS), "critical");
  assert.equal(limitWindowSeverity(100, THRESHOLDS), "exhausted");
  assert.equal(limitWindowSeverity(250, THRESHOLDS), "exhausted");
  assert.equal(limitWindowSeverity(9.9, { low: 10, critical: 20 }), "ok");
  assert.equal(limitWindowSeverity(10, { low: 10, critical: 20 }), "low");
  assert.equal(limitWindowSeverity(20, { low: 10, critical: 20 }), "critical");
});

test("limitWindowSeverity: an unknown percent is unknown, never ok or zero", () => {
  assert.equal(limitWindowSeverity(null, THRESHOLDS), "unknown");
  assert.equal(limitWindowSeverity(Number.NaN, THRESHOLDS), "unknown");
  assert.equal(limitWindowSeverity(Number.POSITIVE_INFINITY, THRESHOLDS), "unknown");
});

test("limitWindowSeverity: an adapter-spec override applies first", () => {
  assert.equal(limitWindowSeverity(0, THRESHOLDS, "exhausted"), "exhausted");
  assert.equal(limitWindowSeverity(100, THRESHOLDS, "ok"), "ok");
  assert.equal(limitWindowSeverity(null, THRESHOLDS, "critical"), "critical");
});

test("balanceSeverity: exhausted at zero, low strictly below lowBalance", () => {
  assert.equal(balanceSeverity(0, 5), "exhausted");
  assert.equal(balanceSeverity(-0.01, 5), "exhausted");
  assert.equal(balanceSeverity(4.99, 5), "low");
  assert.equal(balanceSeverity(5, 5), "ok");
  assert.equal(balanceSeverity(6, 5), "ok");
  assert.equal(balanceSeverity(0.01, null), "ok");
  assert.equal(balanceSeverity(100, 0), "ok");
  assert.equal(balanceSeverity(Number.NaN, 5), "unknown");
});

test("balanceSeverity: an adapter-spec override applies first", () => {
  assert.equal(balanceSeverity(100, 5, "exhausted"), "exhausted");
  assert.equal(balanceSeverity(0, 5, "ok"), "ok");
});

test("providerSeverity ignores unknown, model-scoped windows, and non-gating balances", () => {
  const limits = known([
    entryWindow({ percent: 80, severity: "low" }),
    entryWindow({ percent: 95, severity: "critical" }),
    entryWindow({ percent: null, severity: "unknown" }),
    entryWindow({ id: "scoped", models: ["model-a"], percent: 100, severity: "exhausted" }),
  ]);
  const balance = known([
    entryBalance({ severity: "low" }),
    entryBalance({ amount: 0, gatesUsage: false, severity: "exhausted" }),
  ]);
  assert.equal(providerSeverity("ok", limits, balance), "critical");
  assert.equal(providerSeverity("partial", limits, balance), "critical");
});

test("providerSeverity is unknown when every counted severity is unknown or none exists", () => {
  assert.equal(
    providerSeverity("ok", { state: "not-exposed" }, { state: "not-exposed" }),
    "unknown",
  );
  assert.equal(
    providerSeverity("ok", known([entryWindow({ severity: "unknown" })]), known([])),
    "unknown",
  );
  assert.equal(
    providerSeverity("ok", known([]), known([entryBalance({ gatesUsage: false })])),
    "unknown",
  );
});

test("providerSeverity by status: free is ok; unavailable statuses are unknown", () => {
  const exhausted = known([entryWindow({ percent: 100, severity: "exhausted" })]);
  assert.equal(providerSeverity("free", exhausted, known([])), "ok");
  assert.equal(providerSeverity("no-adapter", { state: "not-exposed" }, known([])), "unknown");
  assert.equal(providerSeverity("unknown-provider", known([]), known([])), "unknown");
  assert.equal(providerSeverity("not-collected", { state: "not-exposed" }, known([])), "unknown");
  assert.equal(providerSeverity("unavailable", known([]), known([])), "unknown");
});

test("modelSeverity adds windows scoped to that model", () => {
  const limits = known([
    entryWindow({ percent: 80, severity: "low" }),
    entryWindow({ id: "a", models: ["model-a"], percent: 95, severity: "critical" }),
    entryWindow({ id: "b", models: ["model-b"], percent: 100, severity: "exhausted" }),
  ]);
  const balance = known([entryBalance()]);
  assert.equal(modelSeverity("ok", limits, balance, "model-a"), "critical");
  assert.equal(modelSeverity("ok", limits, balance, "model-b"), "exhausted");
  assert.equal(modelSeverity("ok", limits, balance, "model-c"), "low");
  assert.equal(modelSeverity("ok", known([]), known([]), "model-a"), "unknown");
  assert.equal(modelSeverity("free", limits, known([]), "model-a"), "ok");
  assert.equal(modelSeverity("no-adapter", limits, known([]), "model-a"), "unknown");
});

test("deriveProviderEntry: unknown-provider wins and exposes nothing", () => {
  const entry = deriveProviderEntry(
    entryInput({
      models: [],
      capture: captureAt(1_000_000, { plan: known("Pro") }),
      failure: "http-429",
      settings: { free: true },
    }),
  );
  assert.deepEqual(entry, {
    provider: "zai",
    status: "unknown-provider",
    reason: null,
    adapter: null,
    capturedAt: null,
    freshUntil: null,
    stale: false,
    severity: "unknown",
    plan: { state: "not-exposed" },
    balance: { state: "not-exposed" },
    limits: { state: "not-exposed" },
    models: {},
  });
});

test("deriveProviderEntry: a tool provider without inventory models is not unknown-provider", () => {
  const toolProvider: AdapterProfile = {
    ...LIMITS_ONLY,
    credentialVariable: "PURSE_TEST_TOOL_KEY",
  };
  const entry = deriveProviderEntry(
    entryInput({ provider: "exa", models: [], adapter: toolProvider }),
  );
  assert.equal(entry.status, "not-collected");
  assert.equal(entry.reason, "not-collected");
  assert.equal(entry.adapter, "exa");
  assert.deepEqual(entry.limits, { state: "unavailable", reason: "not-collected" });
  assert.deepEqual(entry.plan, { state: "not-exposed" });
  assert.deepEqual(entry.models, {});
});

test("deriveProviderEntry: a tool provider serves its capture with no models", () => {
  const capturedAt = 1_000_000;
  const entry = deriveProviderEntry(
    entryInput({
      provider: "exa",
      models: [],
      adapter: { ...ALL_FACETS, credentialVariable: "PURSE_TEST_TOOL_KEY" },
      capture: captureAt(capturedAt, {
        plan: known("team"),
        balance: known([capturedBalance({ amount: 12.5 })]),
        limits: known([capturedWindow({ unit: "currency", currency: "USD", percent: null })]),
      }),
    }),
  );
  assert.equal(entry.status, "ok");
  assert.equal(entry.severity, "ok");
  assert.equal(entry.adapter, "exa");
  assert.deepEqual(entry.models, {});
});

test("deriveProviderEntry: free wins over adapter and exposes no facet", () => {
  const entry = deriveProviderEntry(entryInput({ settings: { free: true } }));
  assert.equal(entry.status, "free");
  assert.equal(entry.severity, "ok");
  assert.equal(entry.adapter, null);
  assert.equal(entry.reason, null);
  assert.equal(entry.capturedAt, null);
  assert.equal(entry.freshUntil, null);
  assert.equal(entry.stale, false);
  assert.deepEqual(entry.plan, { state: "not-exposed" });
  assert.deepEqual(entry.balance, { state: "not-exposed" });
  assert.deepEqual(entry.limits, { state: "not-exposed" });
  assert.deepEqual(entry.models, {
    "model-a": { price: price(), severity: "ok" },
  });
});

test("deriveProviderEntry: no adapter, or a disabled adapter, is no-adapter", () => {
  for (const input of [
    entryInput({ adapter: null }),
    entryInput({ settings: { adapter: false } }),
  ]) {
    const entry = deriveProviderEntry({
      ...input,
      capture: captureAt(1_000_000, { limits: known([capturedWindow()]) }),
    });
    assert.equal(entry.status, "no-adapter");
    assert.equal(entry.severity, "unknown");
    assert.equal(entry.adapter, null);
    assert.equal(entry.capturedAt, null);
    assert.equal(entry.freshUntil, null);
    assert.equal(entry.stale, false);
    assert.deepEqual(entry.plan, { state: "not-exposed" });
    assert.deepEqual(entry.balance, { state: "not-exposed" });
    assert.deepEqual(entry.limits, { state: "not-exposed" });
    assert.deepEqual(entry.models, {
      "model-a": { price: price(), severity: "unknown" },
    });
  }
});

test("deriveProviderEntry: a fresh capture is ok, with facets, severities, and a fresh window", () => {
  const capturedAt = 1_000_000;
  const entry = deriveProviderEntry(
    entryInput({
      now: capturedAt + 1_000,
      capture: captureAt(capturedAt, {
        plan: known("Pro"),
        balance: known([capturedBalance({ amount: 10 })]),
        limits: known([capturedWindow({ percent: 95 })]),
      }),
    }),
  );
  assert.equal(entry.status, "ok");
  assert.equal(entry.reason, null);
  assert.equal(entry.adapter, "zai");
  assert.equal(entry.capturedAt, capturedAt);
  assert.equal(entry.freshUntil, capturedAt + 300_000);
  assert.equal(entry.stale, false);
  assert.equal(entry.severity, "critical");
  assert.deepEqual(entry.plan, { state: "known", value: "Pro" });
  assert.deepEqual(entry.balance, { state: "known", value: [entryBalance({ amount: 10 })] });
  assert.deepEqual(entry.limits, {
    state: "known",
    value: [entryWindow({ percent: 95, severity: "critical" })],
  });
  assert.deepEqual(entry.models, {
    "model-a": { price: price(), severity: "critical" },
  });
});

test("deriveProviderEntry: a capture's stale window is between freshness and serving age", () => {
  const capturedAt = 1_000_000;
  const facets: CaptureFacets = {
    limits: known([capturedWindow({ percent: 10 })]),
  };
  const input = entryInput({ adapter: LIMITS_ONLY, capture: captureAt(capturedAt, facets) });

  const fresh = deriveProviderEntry({ ...input, now: capturedAt + 119_999 });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.freshUntil, capturedAt + 120_000);

  const stale = deriveProviderEntry({ ...input, now: capturedAt + 120_000 });
  assert.equal(stale.stale, true);
  assert.equal(stale.status, "ok");

  const served = deriveProviderEntry({ ...input, now: capturedAt + 3_599_999 });
  assert.equal(served.status, "ok");
  assert.equal(served.stale, true);

  const discarded = deriveProviderEntry({ ...input, now: capturedAt + 3_600_000 });
  assert.equal(discarded.status, "not-collected");
  assert.equal(discarded.capturedAt, null);
  assert.equal(discarded.freshUntil, null);
  assert.equal(discarded.stale, false);
});

test("deriveProviderEntry: ttlSeconds replaces the adapter freshness period", () => {
  const capturedAt = 1_000_000;
  const input = entryInput({
    adapter: LIMITS_ONLY,
    settings: { ttlSeconds: 600 },
    capture: captureAt(capturedAt, { limits: known([capturedWindow({ percent: 10 })]) }),
  });

  const fresh = deriveProviderEntry({ ...input, now: capturedAt + 599_999 });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.freshUntil, capturedAt + 600_000);

  const stale = deriveProviderEntry({ ...input, now: capturedAt + 900_000 });
  assert.equal(stale.status, "ok");
  assert.equal(stale.stale, true);
});

test("deriveProviderEntry: a recorded failure is unavailable with its reason", () => {
  const entry = deriveProviderEntry(entryInput({ failure: "http-429" }));
  assert.equal(entry.status, "unavailable");
  assert.equal(entry.reason, "http-429");
  assert.equal(entry.adapter, "zai");
  assert.equal(entry.capturedAt, null);
  assert.equal(entry.freshUntil, null);
  assert.equal(entry.stale, false);
  assert.equal(entry.severity, "unknown");
  assert.deepEqual(entry.plan, { state: "unavailable", reason: "http-429" });
  assert.deepEqual(entry.balance, { state: "unavailable", reason: "http-429" });
  assert.deepEqual(entry.limits, { state: "unavailable", reason: "http-429" });
  assert.deepEqual(entry.models, {
    "model-a": { price: price(), severity: "unknown" },
  });
});

test("deriveProviderEntry: no capture and no failure is not-collected", () => {
  const entry = deriveProviderEntry(entryInput());
  assert.equal(entry.status, "not-collected");
  assert.equal(entry.reason, "not-collected");
  assert.equal(entry.adapter, "zai");
  assert.equal(entry.capturedAt, null);
  assert.equal(entry.severity, "unknown");
  assert.deepEqual(entry.plan, { state: "unavailable", reason: "not-collected" });
  assert.deepEqual(entry.balance, { state: "unavailable", reason: "not-collected" });
  assert.deepEqual(entry.limits, { state: "unavailable", reason: "not-collected" });
  assert.deepEqual(entry.models, {
    "model-a": { price: price(), severity: "unknown" },
  });
});

test("deriveProviderEntry: an exposed facet that is unavailable makes the entry partial", () => {
  const entry = deriveProviderEntry(
    entryInput({
      now: 1_001_000,
      capture: captureAt(1_000_000, {
        plan: known("Pro"),
        balance: known([capturedBalance({ amount: 0 })]),
        limits: { state: "unavailable", reason: "http-429" },
      }),
    }),
  );
  assert.equal(entry.status, "partial");
  assert.equal(entry.reason, "http-429");
  assert.equal(entry.severity, "exhausted");
  assert.deepEqual(entry.plan, { state: "known", value: "Pro" });
  assert.deepEqual(entry.limits, { state: "unavailable", reason: "http-429" });
  assert.deepEqual(entry.models, {
    "model-a": { price: price(), severity: "exhausted" },
  });
});

test("deriveProviderEntry: unexposed facets are not-exposed and do not affect status", () => {
  const entry = deriveProviderEntry(
    entryInput({
      adapter: LIMITS_ONLY,
      capture: captureAt(1_000_000, { limits: known([capturedWindow({ percent: 10 })]) }),
    }),
  );
  assert.equal(entry.status, "ok");
  assert.deepEqual(entry.plan, { state: "not-exposed" });
  assert.deepEqual(entry.balance, { state: "not-exposed" });
  assert.deepEqual(entry.limits, {
    state: "known",
    value: [entryWindow({ percent: 10, severity: "ok" })],
  });
});

test("deriveProviderEntry: a capture lacking an exposed facet is unavailable internal", () => {
  const entry = deriveProviderEntry(
    entryInput({
      adapter: LIMITS_ONLY,
      capture: captureAt(1_000_000, {}),
    }),
  );
  assert.equal(entry.status, "partial");
  assert.equal(entry.reason, "internal");
  assert.deepEqual(entry.limits, { state: "unavailable", reason: "internal" });

  const notExposed = deriveProviderEntry(
    entryInput({
      adapter: LIMITS_ONLY,
      capture: captureAt(1_000_000, { limits: { state: "not-exposed" } }),
    }),
  );
  assert.deepEqual(notExposed.limits, { state: "unavailable", reason: "internal" });
});

test("deriveProviderEntry: a partial entry's reason is the first unavailable facet in order limits, balance, plan", () => {
  const entry = deriveProviderEntry(
    entryInput({
      capture: captureAt(1_000_000, {
        plan: { state: "unavailable", reason: "vendor-error" },
        balance: { state: "unavailable", reason: "http-403" },
        limits: known([capturedWindow({ percent: 10 })]),
      }),
    }),
  );
  assert.equal(entry.status, "partial");
  assert.equal(entry.reason, "http-403");

  const withFailure = deriveProviderEntry(
    entryInput({
      capture: captureAt(1_000_000, {
        plan: { state: "unavailable", reason: "vendor-error" },
        balance: known([capturedBalance()]),
        limits: known([capturedWindow({ percent: 10 })]),
      }),
      failure: "network",
    }),
  );
  assert.equal(withFailure.reason, "network");
});

test("deriveProviderEntry: limit window percent is derived from used and limit when not captured", () => {
  const entry = deriveProviderEntry(
    entryInput({
      adapter: LIMITS_ONLY,
      capture: captureAt(1_000_000, {
        limits: known([
          capturedWindow({ unit: "credits", used: 95, limit: 100, percent: null }),
          capturedWindow({ id: "neg", unit: "credits", used: 1, limit: 4, percent: -5 }),
          capturedWindow({ id: "vendor", unit: "credits", used: 1, limit: 4, percent: 80 }),
        ]),
      }),
    }),
  );
  assert.equal(entry.limits.state, "known");
  if (entry.limits.state !== "known") return;
  assert.deepEqual(
    entry.limits.value.map((w) => [w.percent, w.severity]),
    [
      [95, "critical"],
      [25, "ok"],
      [80, "low"],
    ],
  );
});

test("deriveProviderEntry: a window past its reset loses used, percent, and severity", () => {
  const input = entryInput({
    adapter: LIMITS_ONLY,
    capture: captureAt(1_000_000, { limits: known([]) }),
  });
  const window = { unit: "credits", used: 100, limit: 100, percent: 100 } as const;
  const entry = deriveProviderEntry({
    ...input,
    capture: captureAt(1_000_000, {
      limits: known([
        capturedWindow({ ...window, id: "past", resetsAt: input.now }),
        capturedWindow({
          ...window,
          id: "override",
          resetsAt: input.now - 1,
          severity: "exhausted",
        }),
        capturedWindow({ ...window, id: "ahead", resetsAt: input.now + 1 }),
      ]),
    }),
  });
  assert.equal(entry.limits.state, "known");
  if (entry.limits.state !== "known") return;
  assert.deepEqual(
    entry.limits.value.map((w) => [w.used, w.percent, w.severity]),
    [
      [null, null, "unknown"],
      [null, null, "unknown"],
      [100, 100, "exhausted"],
    ],
  );
});

test("deriveProviderEntry: reason is the failure, else the capture reason", () => {
  const capturedAt = 1_000_000;
  const facets: CaptureFacets = {
    limits: known([capturedWindow({ percent: 10 })]),
  };

  const withFailure = deriveProviderEntry(
    entryInput({
      now: capturedAt + 1_000,
      adapter: LIMITS_ONLY,
      capture: captureAt(capturedAt, facets),
      failure: "network",
    }),
  );
  assert.equal(withFailure.status, "ok");
  assert.equal(withFailure.reason, "network");

  const withCaptureReason = deriveProviderEntry(
    entryInput({
      now: capturedAt + 1_000,
      adapter: LIMITS_ONLY,
      capture: { ...captureAt(capturedAt, facets), captureReason: "http-429" },
    }),
  );
  assert.equal(withCaptureReason.status, "ok");
  assert.equal(withCaptureReason.reason, "http-429");

  const withBoth = deriveProviderEntry(
    entryInput({
      now: capturedAt + 1_000,
      adapter: LIMITS_ONLY,
      capture: { ...captureAt(capturedAt, facets), captureReason: "http-429" },
      failure: "network",
    }),
  );
  assert.equal(withBoth.reason, "network");
});

test("deriveProviderEntry: an adapter-spec severity override is kept at the item", () => {
  const entry = deriveProviderEntry(
    entryInput({
      now: 1_001_000,
      capture: captureAt(1_000_000, {
        balance: known([capturedBalance({ amount: 100, severity: "exhausted" })]),
        limits: known([capturedWindow({ percent: 0, severity: "exhausted" })]),
      }),
    }),
  );
  assert.deepEqual(entry.balance, {
    state: "known",
    value: [entryBalance({ amount: 100, severity: "exhausted" })],
  });
  assert.deepEqual(entry.limits, {
    state: "known",
    value: [entryWindow({ percent: 0, severity: "exhausted" })],
  });
  assert.equal(entry.severity, "exhausted");
});

test("deriveProviderEntry: lowBalance gives a balance item severity low", () => {
  const entry = deriveProviderEntry(
    entryInput({
      now: 1_001_000,
      settings: { lowBalance: 20 },
      capture: captureAt(1_000_000, {
        balance: known([capturedBalance({ amount: 10 })]),
        limits: known([capturedWindow({ percent: 10 })]),
      }),
    }),
  );
  assert.deepEqual(entry.balance, {
    state: "known",
    value: [entryBalance({ amount: 10, severity: "low" })],
  });
  assert.equal(entry.severity, "low");
});

test("deriveProviderEntry: an unknown percent stays null and unknown, never zero or ok", () => {
  const entry = deriveProviderEntry(
    entryInput({
      adapter: LIMITS_ONLY,
      now: 1_001_000,
      capture: captureAt(1_000_000, {
        limits: known([capturedWindow({ percent: null, used: null, limit: null })]),
      }),
    }),
  );
  assert.deepEqual(entry.limits, {
    state: "known",
    value: [
      entryWindow({
        percent: null,
        used: null,
        limit: null,
        severity: "unknown",
      }),
    ],
  });
  assert.equal(entry.severity, "unknown");
  assert.equal(entry.models["model-a"]?.severity, "unknown");
});

test("deriveProviderEntry: a known empty limits array yields unknown provider severity", () => {
  const entry = deriveProviderEntry(
    entryInput({
      adapter: LIMITS_ONLY,
      now: 1_001_000,
      capture: captureAt(1_000_000, { limits: known([]) }),
    }),
  );
  assert.equal(entry.status, "ok");
  assert.deepEqual(entry.limits, { state: "known", value: [] });
  assert.equal(entry.severity, "unknown");
});

test("deriveProviderEntry: a currency limit window keeps its currency only where present", () => {
  const entry = deriveProviderEntry(
    entryInput({
      adapter: LIMITS_ONLY,
      now: 1_001_000,
      capture: captureAt(1_000_000, {
        limits: known([
          capturedWindow({ unit: "currency", currency: "USD", limit: 10 }),
          capturedWindow({ id: "tokens", unit: "tokens", limit: 10 }),
        ]),
      }),
    }),
  );
  assert.ok(entry.limits.state === "known");
  const [money, tokens] = entry.limits.value;
  assert.ok(money !== undefined && tokens !== undefined);
  assert.equal(money.currency, "USD");
  assert.equal("currency" in tokens, false);
});

test("deriveProviderEntry: provider and model identifiers are not cleaned or altered", () => {
  const longModelId = `model-${"x".repeat(100)}`;
  const entry = deriveProviderEntry(
    entryInput({
      provider: "llm-dralban68",
      models: [{ id: longModelId, price: price() }],
      now: 1_001_000,
      capture: captureAt(1_000_000, {
        plan: known("Pro"),
        balance: known([]),
        limits: known([capturedWindow({ id: longModelId })]),
      }),
    }),
  );
  assert.equal(entry.provider, "llm-dralban68");
  assert.deepEqual(Object.keys(entry.models), [longModelId]);
  assert.ok(entry.limits.state === "known");
  assert.equal(entry.limits.value[0]?.id, longModelId);
});

test("deriveProviderEntry: the entry has exactly the specified fields and is JSON-compatible", () => {
  const entry = deriveProviderEntry(
    entryInput({
      now: 1_001_000,
      capture: captureAt(1_000_000, {
        plan: known("Pro"),
        balance: known([capturedBalance({ amount: 10 })]),
        limits: known([capturedWindow({ percent: 50 })]),
      }),
    }),
  );
  assert.deepEqual(Object.keys(entry).toSorted(), [
    "adapter",
    "balance",
    "capturedAt",
    "freshUntil",
    "limits",
    "models",
    "plan",
    "provider",
    "reason",
    "severity",
    "stale",
    "status",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(entry)), entry);
});

test("deriveProviderEntry is pure: equal inputs give equal entries and inputs are unchanged", () => {
  const input = entryInput({
    now: 1_001_000,
    settings: { lowBalance: 20 },
    capture: captureAt(1_000_000, {
      plan: known("Pro"),
      balance: known([capturedBalance({ amount: 10 })]),
      limits: known([capturedWindow({ percent: 50, models: ["model-a"] })]),
    }),
  });
  const snapshot = structuredClone(input);
  const first = deriveProviderEntry(input);
  const second = deriveProviderEntry(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, snapshot);
});

// The severity test fixtures must stay assignable to the exported entry types.
const severitySample: Severity = providerSeverity(
  "ok",
  known([entryWindow({ severity: "low" })]),
  known([entryBalance()]),
);
assert.equal(severitySample, "low");
