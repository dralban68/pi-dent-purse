/**
 * The AMD TokenLab adapter (specs/adapter-amd.md): no request and no command. The vendor has no
 * usage endpoint, so limits come only from the headers of inference responses the host made and
 * purse recorded. Shared behavior is owned by specs/adapter-contract.md.
 *
 * The module performs no I/O: the recorded observation and the clock arrive as dependencies
 * (adapter-contract.md Section 2). Percent and severity are derived after this adapter returns
 * (billing-state.md Sections 3 and 5); a window carries the raw vendor values the spec names
 * (adapter-amd.md Section 3).
 */

import type { Adapter, AdapterDependencies } from "../adapter.ts";
import type { AdapterResult, LimitWindowCapture } from "../state.ts";
import { headerNumber, lowercaseHeaders } from "./headers.ts";

/** The provider origin and host allowlist (adapter-amd.md Section 1): the adapter contacts none. */
const PROVIDER_ORIGIN = "https://api.tokenlab.amd.com";
const HOST_ALLOWLIST: readonly string[] = [];

/** The rpm window resets and is as long as this, in milliseconds and seconds (Section 3). */
const RPM_WINDOW_MS = 60_000;
const RPM_WINDOW_SECONDS = 60;

/** A window of a header observation that reports its allowance and what is left (Section 2). */
export interface AmdWindowObservation {
  limit: number | null;
  remaining: number | null;
}

/** The budget window of a header observation (Section 2): USD, with its own usage and reset. */
export interface AmdBudgetObservation extends AmdWindowObservation {
  used: number | null;
  /** Epoch milliseconds; `null` when unobserved. */
  resetsAt: number | null;
}

/** A header observation (Section 2). */
export interface AmdObservation {
  /** Epoch milliseconds when recorded. */
  observedAt: number;
  budget: AmdBudgetObservation;
  rpm: AmdWindowObservation;
}

/** The headers a header observation reads (Section 2). */
const OBSERVATION_HEADERS = {
  budgetLimit: "x-ratelimit-limit-user-budget-usd",
  budgetUsed: "x-ratelimit-used-user-budget-usd",
  budgetRemaining: "x-ratelimit-remaining-user-budget-usd",
  budgetReset: "x-ratelimit-reset-user-budget-usd",
  rpmLimit: "x-ratelimit-limit-user-rpm",
  rpmRemaining: "x-ratelimit-remaining-user-rpm",
} as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` is a number or `null`, as an observed field is (Section 2). */
function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

/** Whether `value` is a window of an amd header observation (Section 2). */
function isWindow(value: unknown): value is AmdWindowObservation {
  return isObject(value) && isNumberOrNull(value["limit"]) && isNumberOrNull(value["remaining"]);
}

/** Whether `value` is the budget window of an amd header observation (Section 2). */
function isBudget(value: unknown): value is AmdBudgetObservation {
  return (
    isWindow(value) &&
    isObject(value) &&
    isNumberOrNull(value["used"]) &&
    isNumberOrNull(value["resetsAt"])
  );
}

/** Whether `value` is an amd header observation this adapter recorded (Section 2). */
function isAmdObservation(value: unknown): value is AmdObservation {
  return (
    isObject(value) &&
    typeof value["observedAt"] === "number" &&
    isBudget(value["budget"]) &&
    isWindow(value["rpm"])
  );
}

/**
 * The header observation inference-response headers yield (adapter-amd.md Section 2), or
 * `undefined` when neither limit header is present. Header names compare case-insensitively;
 * a value that is absent, empty after trimming, or not a finite number is `null`. The caller
 * records it only for responses of provider `amd`.
 */
export function observeAmdHeaders(
  headers: Readonly<Record<string, string>>,
  now: number,
): AmdObservation | undefined {
  const lower = lowercaseHeaders(headers);
  if (!lower.has(OBSERVATION_HEADERS.budgetLimit) && !lower.has(OBSERVATION_HEADERS.rpmLimit)) {
    return undefined;
  }
  const reset = headerNumber(lower, OBSERVATION_HEADERS.budgetReset);
  return {
    observedAt: now,
    budget: {
      limit: headerNumber(lower, OBSERVATION_HEADERS.budgetLimit),
      used: headerNumber(lower, OBSERVATION_HEADERS.budgetUsed),
      remaining: headerNumber(lower, OBSERVATION_HEADERS.budgetRemaining),
      resetsAt: reset === null ? null : reset * 1000,
    },
    rpm: {
      limit: headerNumber(lower, OBSERVATION_HEADERS.rpmLimit),
      remaining: headerNumber(lower, OBSERVATION_HEADERS.rpmRemaining),
    },
  };
}

/** The budget window's used: the observed one, else limit − remaining when both are known (Section 3). */
function budgetUsed(budget: AmdBudgetObservation): number | null {
  if (budget.used !== null) return budget.used;
  if (budget.limit === null || budget.remaining === null) return null;
  return budget.limit - budget.remaining;
}

/** The rpm window's used: limit − remaining when both are known (Section 3). */
function rpmUsed(rpm: AmdWindowObservation): number | null {
  if (rpm.limit === null || rpm.remaining === null) return null;
  return rpm.limit - rpm.remaining;
}

/** The observation's windows, budget then rpm; one whose limit is `null` is omitted (Section 3). */
function observedWindows(observation: AmdObservation): LimitWindowCapture[] {
  const { budget, rpm } = observation;
  const windows: LimitWindowCapture[] = [];
  if (budget.limit !== null) {
    windows.push({
      id: "budget",
      label: "budget",
      unit: "currency",
      currency: "USD",
      used: budgetUsed(budget),
      limit: budget.limit,
      percent: null,
      resetsAt: budget.resetsAt,
      windowSeconds: null,
      models: null,
      source: "headers",
    });
  }
  if (rpm.limit !== null) {
    windows.push({
      id: "rpm",
      label: "rpm",
      unit: "requests",
      used: rpmUsed(rpm),
      limit: rpm.limit,
      percent: null,
      resetsAt: observation.observedAt + RPM_WINDOW_MS,
      windowSeconds: RPM_WINDOW_SECONDS,
      models: null,
      source: "headers",
    });
  }
  return windows;
}

/** One refresh (adapter-contract.md Section 2, adapter-amd.md Sections 2–3): no I/O. */
function refresh(deps: AdapterDependencies): AdapterResult {
  const observation = deps.observations.latest();
  if (!isAmdObservation(observation)) {
    return { facets: { limits: { state: "unavailable", reason: "not-observed" } } };
  }
  const windows = observedWindows(observation);
  if (windows.length === 0) {
    return {
      facets: { limits: { state: "unavailable", reason: "not-observed" } },
      capturedAt: observation.observedAt,
    };
  }
  return {
    facets: { limits: { state: "known", value: windows } },
    capturedAt: observation.observedAt,
  };
}

/** The AMD TokenLab adapter (adapter-amd.md Section 1). */
export const amd: Adapter = {
  id: "amd",
  providerOrigin: PROVIDER_ORIGIN,
  hostAllowlist: HOST_ALLOWLIST,
  exposedFacets: ["limits"],
  freshnessSeconds: 60,

  async run(deps: AdapterDependencies): Promise<AdapterResult> {
    try {
      return refresh(deps);
    } catch {
      return { reason: "internal" };
    }
  },
};
