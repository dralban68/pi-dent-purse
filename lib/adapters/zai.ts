/**
 * Z.ai adapter for provider `zai` (specs/adapter-zai.md): the GLM Coding Plan quota windows
 * (Section 3), the subscription plan (Section 4), and the account balance (Section 5). The
 * adapter performs no I/O of its own; transport, credentials, and clock arrive in
 * `AdapterDependencies`. Vendor data is untrusted and `run` never rejects.
 */

import type {
  Adapter,
  AdapterDependencies,
  TransportOutcome,
  TransportRequest,
} from "../adapter.ts";
import {
  cleanVendorString,
  finiteNumber,
  type AdapterFailure,
  type AdapterResult,
  type BalanceItemCapture,
  type CaptureFacets,
  type Facet,
  type LimitWindowCapture,
  type ReasonCode,
  type Unit,
} from "../state.ts";

/** Provider origin and host allowlist (Section 1). */
const PROVIDER_ORIGIN = "https://api.z.ai";

/** Host allowlist of the adapter (Section 1). */
const HOST_ALLOWLIST: readonly string[] = [PROVIDER_ORIGIN];

/** Body cap of one response, 64 KiB (Section 1). */
const BODY_CAP = 64 * 1024;

/** Freshness period, 300 seconds (Section 1). */
const FRESHNESS_SECONDS = 300;

/** The three endpoints of Section 2. */
const QUOTA_URL = `${PROVIDER_ORIGIN}/api/monitor/usage/quota/limit`;
const PLAN_URL = `${PROVIDER_ORIGIN}/api/biz/subscription/list`;
const BALANCE_URL = `${PROVIDER_ORIGIN}/api/biz/account/query-customer-account-report`;

/** The five-hour window default when the quota entry carries no numeric `number` (Section 3). */
const FIVE_HOUR_DEFAULT_SECONDS = 18000;

/** The weekly window length (Section 3). */
const WEEKLY_SECONDS = 604800;

/** Outcome of one request that passed the Section 2 envelope; `data` is unread. */
type EndpointOutcome = { ok: true; data: unknown } | { ok: false; failure: AdapterFailure };

/** A limit window's fixed identification and window length (Section 3). */
interface WindowMapping {
  id: string;
  label: string;
  unit: Unit;
  windowSeconds: number | null;
}

/**
 * The `authorization` value every request sends (Section 2). Section 6 records as `live check`
 * whether the key is accepted with this `Bearer` prefix or raw; the choice is made here only.
 */
function authorizationHeader(apiKey: string): string {
  return `Bearer ${apiKey}`;
}

function failureOf(reason: ReasonCode, retryAfter?: number): AdapterFailure {
  return retryAfter === undefined ? { reason } : { reason, retryAfter };
}

/** A JSON object, excluding `null` and arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON array, else `null`. */
function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/**
 * Reads the Section 2 envelope: the body must be an object; unless `success` is `true` and
 * `code` is `200` the request fails with `vendor-error`.
 */
function readEnvelope(body: string): EndpointOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, failure: { reason: "bad-response" } };
  }
  if (!isRecord(parsed)) return { ok: false, failure: { reason: "bad-response" } };
  if (parsed.success !== true || parsed.code !== 200) {
    return { ok: false, failure: { reason: "vendor-error" } };
  }
  return { ok: true, data: parsed.data };
}

/** One GET of Section 2 under the transport contract (adapter-contract.md Section 4). */
async function requestEnvelope(
  deps: AdapterDependencies,
  url: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<EndpointOutcome> {
  const request: TransportRequest = {
    url,
    headers: { authorization: authorizationHeader(apiKey) },
    bodyCap: BODY_CAP,
    signal,
  };
  const outcome: TransportOutcome = await deps.transport(request);
  if ("reason" in outcome)
    return { ok: false, failure: failureOf(outcome.reason, outcome.retryAfter) };
  return readEnvelope(outcome.body);
}

/** The fixed identification and window length of one quota element, else `null` (Section 3). */
function windowMapping(element: Record<string, unknown>): WindowMapping | null {
  const type = element.type;
  if (type === "CREDIT_LIMIT" || type === "TOKENS_LIMIT") {
    const unit: Unit = type === "CREDIT_LIMIT" ? "credits" : "tokens";
    if (element.unit === 3) {
      const number = finiteNumber(element.number);
      return {
        id: "five-hour",
        label: "5h",
        unit,
        windowSeconds: number === null ? FIVE_HOUR_DEFAULT_SECONDS : number * 3600,
      };
    }
    if (element.unit === 6)
      return { id: "weekly", label: "7d", unit, windowSeconds: WEEKLY_SECONDS };
    return null;
  }
  if (type === "TIME_LIMIT") {
    return { id: "tool-calls-monthly", label: "tools/mo", unit: "requests", windowSeconds: null };
  }
  return null;
}

/** First instant of the next calendar month in UTC (Section 3). */
function firstOfNextMonthUtc(now: number): number | null {
  if (!Number.isFinite(now)) return null;
  const date = new Date(now);
  const first = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return Number.isFinite(first) ? first : null;
}

/** A window's reset time: `nextResetTime`, else the monthly fallback (Section 3). */
function resetTime(id: string, value: unknown, now: number): number | null {
  const reported = finiteNumber(value);
  if (reported !== null) return reported;
  if (id !== "tool-calls-monthly") return null;
  return firstOfNextMonthUtc(now);
}

/** One quota element as a window, else `null` when the element is skipped (Section 3). */
function quotaWindow(value: unknown, now: number): LimitWindowCapture | null {
  if (!isRecord(value)) return null;
  const mapping = windowMapping(value);
  if (mapping === null) return null;
  return {
    id: mapping.id,
    label: mapping.label,
    unit: mapping.unit,
    used: finiteNumber(value.currentValue),
    limit: finiteNumber(value.usage) ?? finiteNumber(value.total),
    percent: finiteNumber(value.percentage),
    resetsAt: resetTime(mapping.id, value.nextResetTime, now),
    windowSeconds: mapping.windowSeconds,
    models: null,
    source: "endpoint",
  };
}

/** All windows of quota `data.limits[]`, skipping unusable elements and repeated ids. */
function quotaWindows(quotaData: unknown, now: number): LimitWindowCapture[] {
  const data = isRecord(quotaData) ? quotaData : null;
  const limits = data === null ? null : asArray(data.limits);
  if (limits === null) return [];
  const windows: LimitWindowCapture[] = [];
  const seen = new Set<string>();
  for (const element of limits) {
    const window = quotaWindow(element, now);
    if (window === null || seen.has(window.id)) continue;
    seen.add(window.id);
    windows.push(window);
  }
  return windows;
}

/** The `limits` facet (Section 3). */
function limitsFacet(quota: EndpointOutcome, now: number): Facet<LimitWindowCapture[]> {
  if (!quota.ok) return { state: "unavailable", reason: quota.failure.reason };
  const windows = quotaWindows(quota.data, now);
  if (windows.length === 0) return { state: "unavailable", reason: "empty-response" };
  return { state: "known", value: windows };
}

/** The `productName` of the first `VALID` plan object, else `null` (Section 4). */
function validPlanName(planData: unknown): string | null {
  const plans = asArray(planData);
  if (plans === null) return null;
  for (const entry of plans) {
    if (!isRecord(entry) || entry.status !== "VALID") continue;
    return cleanVendorString(entry.productName);
  }
  return null;
}

/** The quota body's `data.level`, else `null` (Section 4). */
function quotaLevel(quotaData: unknown): string | null {
  const data = isRecord(quotaData) ? quotaData : null;
  return data === null ? null : cleanVendorString(data.level);
}

/** The `plan` facet (Section 4). */
function planFacet(plan: EndpointOutcome, quota: EndpointOutcome): Facet<string> {
  const fromPlan = plan.ok ? validPlanName(plan.data) : null;
  if (fromPlan !== null) return { state: "known", value: fromPlan };
  const fromQuota = quota.ok ? quotaLevel(quota.data) : null;
  if (fromQuota !== null) return { state: "known", value: fromQuota };
  if (!plan.ok) return { state: "unavailable", reason: plan.failure.reason };
  return { state: "unavailable", reason: "empty-response" };
}

/** The `balance` facet (Section 5). */
function balanceFacet(balance: EndpointOutcome): Facet<BalanceItemCapture[]> {
  if (!balance.ok) return { state: "unavailable", reason: balance.failure.reason };
  const data = isRecord(balance.data) ? balance.data : null;
  const amount = data === null ? null : finiteNumber(data.availableBalance);
  if (amount === null) return { state: "unavailable", reason: "bad-response" };
  return {
    state: "known",
    value: [{ amount, currency: "USD", currencyAssumed: true, gatesUsage: false }],
  };
}

/** One refresh: the three concurrent requests and the facets (adapter-contract.md Section 3 ran before). */
async function refresh(deps: AdapterDependencies, signal: AbortSignal): Promise<AdapterResult> {
  const credentials = await deps.credentials();
  if (credentials === undefined) return { reason: "no-credentials" };
  const apiKey = credentials.apiKey;

  const [quota, plan, balance] = await Promise.all([
    requestEnvelope(deps, QUOTA_URL, apiKey, signal),
    requestEnvelope(deps, PLAN_URL, apiKey, signal),
    requestEnvelope(deps, BALANCE_URL, apiKey, signal),
  ]);

  const outcomes = [quota, plan, balance];
  let firstFailure: AdapterFailure | undefined;
  for (const outcome of outcomes) {
    if (!outcome.ok && firstFailure === undefined) {
      firstFailure = outcome.failure;
    }
  }

  const now = deps.clock();
  const facets: CaptureFacets = {
    plan: planFacet(plan, quota),
    balance: balanceFacet(balance),
    limits: limitsFacet(quota, now),
  };

  return {
    facets,
    ...(firstFailure === undefined ? {} : { firstFailure }),
  };
}

/** Runs one refresh; an unexpected exception is a whole failure with `internal`. */
async function run(deps: AdapterDependencies, signal: AbortSignal): Promise<AdapterResult> {
  try {
    return await refresh(deps, signal);
  } catch {
    return { reason: "internal" };
  }
}

export const zai: Adapter = {
  id: "zai",
  providerOrigin: PROVIDER_ORIGIN,
  hostAllowlist: HOST_ALLOWLIST,
  exposedFacets: ["plan", "balance", "limits"],
  freshnessSeconds: FRESHNESS_SECONDS,
  run,
};
