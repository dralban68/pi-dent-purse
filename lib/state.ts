/**
 * Billing state per specs/billing-state.md: the provider entry, its facets, severity and
 * reason codes, and the content restrictions on vendor values. The module is pure: it reads
 * no host API, network, file, or clock; the current time is a parameter.
 *
 * Prices are derived by lib/prices.ts; adapter profiles and captures are produced by the
 * adapters and the cache. This module only describes their shapes and turns a capture into a
 * provider entry.
 */

/** Provider entry status (billing-state.md Section 2), first matching row wins. */
export type Status =
  | "unknown-provider"
  | "free"
  | "no-adapter"
  | "ok"
  | "partial"
  | "unavailable"
  | "not-collected";

/** Severity, in ascending gravity (billing-state.md Section 5). */
export type Severity = "ok" | "low" | "critical" | "exhausted" | "unknown";

/** Reason code (billing-state.md Section 6). */
export type ReasonCode =
  | "not-collected"
  | "offline"
  | "no-credentials"
  | "unsupported-auth"
  | "endpoint-mismatch"
  | "network"
  | "timeout"
  | "deadline"
  | "redirect"
  | "response-too-large"
  | "http-401"
  | "http-403"
  | "http-429"
  | "http-error"
  | "bad-response"
  | "vendor-error"
  | "empty-response"
  | "not-observed"
  | "gcloud-missing"
  | "gcloud-unauthenticated"
  | "gcloud-failed"
  | "project-unresolved"
  | "internal";

/** A facet name (billing-state.md Section 1). */
export type FacetName = "plan" | "balance" | "limits";

/** Unit of a limit window's `used` and `limit` (billing-state.md Section 3). */
export type Unit =
  | "percent"
  | "credits"
  | "tokens"
  | "requests"
  | "concurrent-requests"
  | "currency";

/** How a limit window was obtained (billing-state.md Section 3). */
export type Source = "endpoint" | "headers" | "documented";

/** A facet value: exactly one of the three shapes (billing-state.md Section 1). */
export type Facet<T> =
  | { state: "known"; value: T }
  | { state: "not-exposed" }
  | { state: "unavailable"; reason: ReasonCode };

/** A limit window's captured fields (billing-state.md Section 3). */
export interface LimitWindowBase {
  id: string;
  label: string;
  unit: Unit;
  used: number | null;
  limit: number | null;
  percent: number | null;
  resetsAt: number | null;
  windowSeconds: number | null;
  models: string[] | null;
  currency?: string;
  source: Source;
}

/** A limit window in a provider entry (billing-state.md Section 3). */
export interface LimitWindow extends LimitWindowBase {
  severity: Severity;
}

/**
 * A limit window as an adapter reports it: `severity` is absent unless the adapter spec
 * overrides it (billing-state.md Section 5).
 */
export type LimitWindowCapture = LimitWindowBase & { severity?: Severity };

/** A balance item's captured fields (billing-state.md Section 4). */
export interface BalanceItemBase {
  amount: number;
  currency: string;
  currencyAssumed: boolean;
  gatesUsage: boolean;
}

/** A balance item in a provider entry (billing-state.md Section 4). */
export interface BalanceItem extends BalanceItemBase {
  severity: Severity;
}

/**
 * A balance item as an adapter reports it: `severity` is absent unless the adapter spec
 * overrides it (billing-state.md Section 5).
 */
export type BalanceItemCapture = BalanceItemBase & { severity?: Severity };

/** USD per million tokens for one token class (prices.md Section 1). */
export interface Rates {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

/** Rates applying above an input-token count (prices.md Section 1). */
export interface PriceTier extends Rates {
  inputTokensAbove: number;
}

/** A price's provenance (prices.md Section 2). */
export type PriceSource = "inventory" | "config" | "free" | "unknown";

/** One recurring time window of a price schedule (prices.md Section 3). */
export interface ScheduleWindow {
  days: number[];
  from: string;
  to: string;
}

/** A price schedule with its derivation-time fields (prices.md Section 3). */
export interface Schedule {
  multiplier: number;
  timeZone: string;
  windows: ScheduleWindow[];
  active: boolean;
  changesAt: number | null;
}

/** A model's price (prices.md Section 1). */
export interface Price {
  rates: Rates;
  tiers: PriceTier[];
  source: PriceSource;
  schedule: Schedule | null;
}

/** A provider entry (billing-state.md Section 1). */
export interface ProviderEntry {
  provider: string;
  status: Status;
  reason: ReasonCode | null;
  adapter: string | null;
  capturedAt: number | null;
  freshUntil: number | null;
  stale: boolean;
  severity: Severity;
  plan: Facet<string>;
  balance: Facet<BalanceItem[]>;
  limits: Facet<LimitWindow[]>;
  models: Record<string, { price: Price; severity: Severity }>;
}

/**
 * The facet values one capture holds; only the adapter's exposed facets are present
 * (adapter-contract.md Section 2).
 */
export interface CaptureFacets {
  plan?: Facet<string>;
  balance?: Facet<BalanceItemCapture[]>;
  limits?: Facet<LimitWindowCapture[]>;
}

/** One successful refresh's capture (refresh.md Section 2). */
export interface Capture {
  facets: CaptureFacets;
  capturedAt: number;
  captureReason?: ReasonCode;
}

/** A whole adapter failure (adapter-contract.md Section 2). */
export interface AdapterFailure {
  reason: ReasonCode;
  retryAfter?: number;
}

/** A successful adapter run (adapter-contract.md Section 2). */
export interface AdapterSuccess {
  facets: CaptureFacets;
  firstFailure?: AdapterFailure;
  capturedAt?: number;
  captureReason?: ReasonCode;
}

/** An adapter's result (adapter-contract.md Section 2). */
export type AdapterResult = AdapterFailure | AdapterSuccess;

/** The adapter constants entry derivation needs (adapter-contract.md Section 1). */
export interface AdapterProfile {
  exposedFacets: readonly FacetName[];
  freshnessSeconds: number;
  /**
   * A tool provider's environment variable holding its credential (adapter-contract.md
   * Section 1); absent for every other provider.
   */
  credentialVariable?: string;
}

/** The provider configuration entry derivation reads (config-file.md Section 2). */
export interface ProviderSettings {
  free?: boolean;
  adapter?: boolean;
  ttlSeconds?: number;
  lowBalance?: number;
}

/** An inventory model id with its derived price (prices.md Section 1). */
export interface ModelPrice {
  id: string;
  price: Price;
}

/** Everything entry derivation reads (billing-state.md Section 2, refresh.md Section 2). */
export interface ProviderEntryInput {
  provider: string;
  now: number;
  models: readonly ModelPrice[];
  adapter: AdapterProfile | null;
  settings: ProviderSettings;
  thresholds: SeverityThresholds;
  capture: Capture | null;
  failure: ReasonCode | null;
}

/** The configured percent thresholds (config-file.md Section 2, billing-state.md Section 5). */
export interface SeverityThresholds {
  low: number;
  critical: number;
}

/** Thresholds used when none are configured (config-file.md Section 2). */
export const DEFAULT_SEVERITY_THRESHOLDS: SeverityThresholds = { low: 75, critical: 90 };

/** Longest vendor string an adapter may copy into a field (billing-state.md Section 7). */
const VENDOR_STRING_LENGTH = 64;

/**
 * Clean a vendor string an adapter spec names (billing-state.md Section 7): control
 * characters removed, trimmed, cut to 64 Unicode code points; `null` when absent. Adapters
 * apply it before returning their result.
 *
 * Callers must pass only vendor strings an adapter spec names — never a credential, account
 * identifier, URL, or header value.
 */
export function cleanVendorString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const withoutControls = value.replace(/\p{Cc}/gu, "").trim();
  const cut = Array.from(withoutControls).slice(0, VENDOR_STRING_LENGTH).join("");
  return cut === "" ? null : cut;
}

/** A finite vendor number, else `null` (billing-state.md Section 7). */
export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The percent a limit window consumed (billing-state.md Section 3): rule 1 takes `captured`
 * when it is a finite number ≥ 0; rules 2–4 derive it from `used` and `limit`.
 */
export function derivePercent(
  used: number | null,
  limit: number | null,
  captured: number | null = null,
): number | null {
  if (captured !== null && Number.isFinite(captured) && captured >= 0) return captured;
  if (used === null || !Number.isFinite(used)) return null;
  if (limit === null || !Number.isFinite(limit)) return null;
  if (limit > 0) return Math.round((used / limit) * 100 * 10) / 10;
  if (limit === 0) return 100;
  return null;
}

const SEVERITY_RANK: Record<Severity, number> = {
  unknown: 0,
  ok: 1,
  low: 2,
  critical: 3,
  exhausted: 4,
};

function gravest(severities: readonly Severity[]): Severity {
  let result: Severity = "unknown";
  for (const severity of severities) {
    if (severity === "unknown") continue;
    if (result === "unknown" || SEVERITY_RANK[severity] > SEVERITY_RANK[result]) {
      result = severity;
    }
  }
  return result;
}

/** Limit window severity (billing-state.md Section 5); an adapter-spec override wins. */
export function limitWindowSeverity(
  percent: number | null,
  thresholds: SeverityThresholds,
  override?: Severity,
): Severity {
  if (override !== undefined) return override;
  if (percent === null || !Number.isFinite(percent)) return "unknown";
  if (percent >= 100) return "exhausted";
  if (percent >= thresholds.critical) return "critical";
  if (percent >= thresholds.low) return "low";
  return "ok";
}

/** Balance item severity (billing-state.md Section 5); an adapter-spec override wins. */
export function balanceSeverity(
  amount: number,
  lowBalance: number | null,
  override?: Severity,
): Severity {
  if (override !== undefined) return override;
  if (!Number.isFinite(amount)) return "unknown";
  if (amount <= 0) return "exhausted";
  if (lowBalance !== null && amount < lowBalance) return "low";
  return "ok";
}

function severityOfFacets(
  status: Status,
  limits: Facet<LimitWindow[]>,
  balance: Facet<BalanceItem[]>,
  counts: (window: LimitWindow) => boolean,
): Severity {
  if (status === "free") return "ok";
  if (status !== "ok" && status !== "partial") return "unknown";

  const severities: Severity[] = [];
  if (limits.state === "known") {
    for (const window of limits.value) {
      if (counts(window)) severities.push(window.severity);
    }
  }
  if (balance.state === "known") {
    for (const item of balance.value) {
      if (item.gatesUsage) severities.push(item.severity);
    }
  }
  return gravest(severities);
}

/** Provider severity (billing-state.md Section 5). */
export function providerSeverity(
  status: Status,
  limits: Facet<LimitWindow[]>,
  balance: Facet<BalanceItem[]>,
): Severity {
  return severityOfFacets(status, limits, balance, (window) => window.models === null);
}

/** Model severity (billing-state.md Section 5). */
export function modelSeverity(
  status: Status,
  limits: Facet<LimitWindow[]>,
  balance: Facet<BalanceItem[]>,
  modelId: string,
): Severity {
  return severityOfFacets(
    status,
    limits,
    balance,
    (window) => window.models === null || window.models.includes(modelId),
  );
}

interface EntryFacets {
  plan: Facet<string>;
  balance: Facet<BalanceItem[]>;
  limits: Facet<LimitWindow[]>;
}

function notExposedFacets(): EntryFacets {
  return {
    plan: { state: "not-exposed" },
    balance: { state: "not-exposed" },
    limits: { state: "not-exposed" },
  };
}

function unavailableFacets(reason: ReasonCode, exposed: readonly FacetName[]): EntryFacets {
  return {
    plan: exposed.includes("plan") ? { state: "unavailable", reason } : { state: "not-exposed" },
    balance: exposed.includes("balance")
      ? { state: "unavailable", reason }
      : { state: "not-exposed" },
    limits: exposed.includes("limits")
      ? { state: "unavailable", reason }
      : { state: "not-exposed" },
  };
}

function modelRecords(
  models: readonly ModelPrice[],
  severityOf: (id: string) => Severity,
): Record<string, { price: Price; severity: Severity }> {
  return Object.fromEntries(
    models.map((model) => [model.id, { price: model.price, severity: severityOf(model.id) }]),
  );
}

/**
 * The capture a cache entry serves: one younger than the serving age
 * `max(3600 seconds, freshness period)` (refresh.md Section 2, billing-state.md Section 2).
 */
function servedCapture(
  capture: Capture | null,
  freshnessSeconds: number,
  now: number,
): Capture | null {
  if (capture === null) return null;
  const servingAgeMs = Math.max(3600, freshnessSeconds) * 1000;
  return now - capture.capturedAt < servingAgeMs ? capture : null;
}

function deriveLimitWindow(
  window: LimitWindowCapture,
  thresholds: SeverityThresholds,
  now: number,
): LimitWindow {
  // Section 3: past its reset, a window's captured usage no longer holds.
  const reset = window.resetsAt !== null && window.resetsAt <= now;
  const used = reset ? null : window.used;
  const percent = reset ? null : derivePercent(window.used, window.limit, window.percent);
  return {
    id: window.id,
    label: window.label,
    unit: window.unit,
    used,
    limit: window.limit,
    percent,
    resetsAt: window.resetsAt,
    windowSeconds: window.windowSeconds,
    models: window.models === null ? null : [...window.models],
    ...(window.currency === undefined ? {} : { currency: window.currency }),
    source: window.source,
    severity: reset ? "unknown" : limitWindowSeverity(percent, thresholds, window.severity),
  };
}

function deriveBalanceItem(item: BalanceItemCapture, lowBalance: number | null): BalanceItem {
  return {
    amount: item.amount,
    currency: item.currency,
    currencyAssumed: item.currencyAssumed,
    gatesUsage: item.gatesUsage,
    severity: balanceSeverity(item.amount, lowBalance, item.severity),
  };
}

function planFacet(capture: Capture, exposed: readonly FacetName[]): Facet<string> {
  if (!exposed.includes("plan")) return { state: "not-exposed" };
  const facet = capture.facets.plan;
  if (facet === undefined || facet.state === "not-exposed") {
    return { state: "unavailable", reason: "internal" };
  }
  if (facet.state === "unavailable") return { state: "unavailable", reason: facet.reason };
  return { state: "known", value: facet.value };
}

function limitsFacet(
  capture: Capture,
  exposed: readonly FacetName[],
  thresholds: SeverityThresholds,
  now: number,
): Facet<LimitWindow[]> {
  if (!exposed.includes("limits")) return { state: "not-exposed" };
  const facet = capture.facets.limits;
  if (facet === undefined || facet.state === "not-exposed") {
    return { state: "unavailable", reason: "internal" };
  }
  if (facet.state === "unavailable") return { state: "unavailable", reason: facet.reason };
  return {
    state: "known",
    value: facet.value.map((window) => deriveLimitWindow(window, thresholds, now)),
  };
}

function balanceFacet(
  capture: Capture,
  exposed: readonly FacetName[],
  lowBalance: number | null,
): Facet<BalanceItem[]> {
  if (!exposed.includes("balance")) return { state: "not-exposed" };
  const facet = capture.facets.balance;
  if (facet === undefined || facet.state === "not-exposed") {
    return { state: "unavailable", reason: "internal" };
  }
  if (facet.state === "unavailable") return { state: "unavailable", reason: facet.reason };
  return {
    state: "known",
    value: facet.value.map((item) => deriveBalanceItem(item, lowBalance)),
  };
}

/**
 * Derive a provider entry from the cache state, configuration, inventory prices, and the
 * current time (billing-state.md Sections 1–5, refresh.md Section 2).
 */
export function deriveProviderEntry(input: ProviderEntryInput): ProviderEntry {
  const { provider, models, adapter, settings, thresholds, now } = input;

  if (models.length === 0 && adapter?.credentialVariable === undefined) {
    return {
      provider,
      status: "unknown-provider",
      reason: null,
      adapter: null,
      capturedAt: null,
      freshUntil: null,
      stale: false,
      severity: "unknown",
      ...notExposedFacets(),
      models: {},
    };
  }

  if (settings.free === true) {
    return {
      provider,
      status: "free",
      reason: null,
      adapter: null,
      capturedAt: null,
      freshUntil: null,
      stale: false,
      severity: "ok",
      ...notExposedFacets(),
      models: modelRecords(models, () => "ok"),
    };
  }

  if (adapter === null || settings.adapter === false) {
    return {
      provider,
      status: "no-adapter",
      reason: null,
      adapter: null,
      capturedAt: null,
      freshUntil: null,
      stale: false,
      severity: "unknown",
      ...notExposedFacets(),
      models: modelRecords(models, () => "unknown"),
    };
  }

  const freshnessSeconds = settings.ttlSeconds ?? adapter.freshnessSeconds;
  const capture = servedCapture(input.capture, freshnessSeconds, now);

  if (capture !== null) {
    const plan = planFacet(capture, adapter.exposedFacets);
    const balance = balanceFacet(capture, adapter.exposedFacets, settings.lowBalance ?? null);
    const limits = limitsFacet(capture, adapter.exposedFacets, thresholds, now);
    const firstUnavailable = [limits, balance, plan].find((facet) => facet.state === "unavailable");
    const status: Status = firstUnavailable === undefined ? "ok" : "partial";
    const facetReason = firstUnavailable?.state === "unavailable" ? firstUnavailable.reason : null;
    const freshUntil = capture.capturedAt + freshnessSeconds * 1000;

    return {
      provider,
      status,
      reason: input.failure ?? capture.captureReason ?? facetReason,
      adapter: provider,
      capturedAt: capture.capturedAt,
      freshUntil,
      stale: now >= freshUntil,
      severity: providerSeverity(status, limits, balance),
      plan,
      balance,
      limits,
      models: modelRecords(models, (id) => modelSeverity(status, limits, balance, id)),
    };
  }

  const reason: ReasonCode = input.failure ?? "not-collected";
  const status: Status = input.failure === null ? "not-collected" : "unavailable";
  return {
    provider,
    status,
    reason,
    adapter: provider,
    capturedAt: null,
    freshUntil: null,
    stale: false,
    severity: "unknown",
    ...unavailableFacets(reason, adapter.exposedFacets),
    models: modelRecords(models, () => "unknown"),
  };
}
