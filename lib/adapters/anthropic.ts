/**
 * The Anthropic adapter (specs/adapter-anthropic.md): the subscription usage endpoint read with
 * the OAuth credential, with a fallback to the header observations the host recorded on
 * inference responses. Shared behavior is owned by specs/adapter-contract.md.
 *
 * The module performs no I/O: transport, credentials, clock, and observations arrive as
 * dependencies (adapter-contract.md Section 2). Percent and severity are derived after this
 * adapter returns (billing-state.md Sections 3 and 5); a window carries the raw vendor values
 * the spec names (adapter-anthropic.md Section 3).
 */

import type {
  Adapter,
  AdapterDependencies,
  InventoryModel,
  TransportFailure,
  TransportOutcome,
  TransportRequest,
} from "../adapter.ts";
import {
  cleanVendorString,
  finiteNumber,
  type Facet,
  type AdapterFailure,
  type AdapterResult,
  type AdapterSuccess,
  type LimitWindowCapture,
} from "../state.ts";
import { headerNumber, lowercaseHeaders } from "./headers.ts";

/** The provider origin and host allowlist (adapter-anthropic.md Section 1). */
const PROVIDER_ORIGIN = "https://api.anthropic.com";
const HOST_ALLOWLIST: readonly string[] = [PROVIDER_ORIGIN];

/** The subscription usage endpoint (adapter-anthropic.md Section 3). */
const USAGE_URL = `${PROVIDER_ORIGIN}/api/oauth/usage`;

/** The body cap of one response body, 64 KiB (adapter-anthropic.md Section 1). */
const USAGE_BODY_CAP = 64 * 1024;

/** The largest age of a header observation the fallback may use, 3600 seconds (Section 4). */
const OBSERVATION_MAX_AGE_MS = 3600 * 1000;

/** One window of a header observation (Section 4). */
export interface ObservedWindow {
  /** Percent 0–100; `null` when unobserved. */
  percent: number | null;
  /** Epoch milliseconds; `null` when unobserved. */
  resetsAt: number | null;
}

/** A header observation (Section 4). */
export interface HeaderObservation {
  /** Epoch milliseconds when recorded. */
  observedAt: number;
  fiveHour: ObservedWindow;
  weekly: ObservedWindow;
}

/** A provider-wide window the endpoint body maps to (adapter-anthropic.md Section 3). */
interface WindowMapping {
  /** The body key holding the window. */
  key: string;
  id: string;
  label: string;
  windowSeconds: number;
}

const WINDOW_MAPPINGS: readonly WindowMapping[] = [
  { key: "five_hour", id: "five-hour", label: "5h", windowSeconds: 18000 },
  { key: "seven_day", id: "weekly", label: "7d", windowSeconds: 604800 },
];

/** The kind of `limits` element that carries a separately measured model group (Section 3.1). */
const SCOPED_KIND = "weekly_scoped";

/** The window length of a scoped weekly window, 604800 seconds (Section 3.1). */
const WEEKLY_SECONDS = 604800;

/** The windows the header fallback reports (Section 4). */
const OBSERVED_WINDOWS = {
  fiveHour: { id: "five-hour", label: "5h", windowSeconds: 18000 },
  weekly: { id: "weekly", label: "7d", windowSeconds: 604800 },
} as const;

/** One usage request's outcome: the single optional retry included. */
type UsageOutcome =
  | {
      /** The request succeeded and its body is a JSON object. */
      body: Record<string, unknown>;
      firstFailure?: AdapterFailure;
    }
  | {
      /** The failure that stands (Section 3). */
      failure: AdapterFailure;
      firstFailure: AdapterFailure;
    };

/** A JSON object, as opposed to `null`, an array, or a primitive (Section 3). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` is one window of a header observation (Section 4). */
function isObservedWindow(value: unknown): value is ObservedWindow {
  if (!isObject(value)) return false;
  const percent = value["percent"];
  const resetsAt = value["resetsAt"];
  return (
    (percent === null || typeof percent === "number") &&
    (resetsAt === null || typeof resetsAt === "number")
  );
}

/** Whether `value` is a header observation this adapter recorded (Section 4). */
function isHeaderObservation(value: unknown): value is HeaderObservation {
  if (!isObject(value)) return false;
  return (
    typeof value["observedAt"] === "number" &&
    isObservedWindow(value["fiveHour"]) &&
    isObservedWindow(value["weekly"])
  );
}

/** A request failure as the adapter reports it (adapter-contract.md Section 2). */
function failureFrom(failure: TransportFailure): AdapterFailure {
  return failure.retryAfter === undefined
    ? { reason: failure.reason }
    : { reason: failure.reason, retryAfter: failure.retryAfter };
}

/** The usage body, parsed; `null` when it is not JSON or not an object (Section 3). */
function parseBody(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  return isObject(parsed) ? parsed : null;
}

/** `resets_at` as epoch milliseconds; `null` when absent or unparsable (Section 3). */
function epochMillis(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The inventory model ids of the provider whose lowercase form contains `name` (Section 3.1). */
function scopedModels(inventory: readonly InventoryModel[], name: string): string[] {
  return inventory
    .filter((model) => model.id.toLowerCase().includes(name))
    .map((model) => model.id);
}

/**
 * One `limits` element of a separately measured model group (Section 3.1): its `<name>` and its
 * window, `null` when the element's `models` list is empty; `null` for an element that is not one.
 */
function scopedWindow(
  entry: unknown,
  inventory: readonly InventoryModel[],
): { name: string; window: LimitWindowCapture | null } | null {
  if (!isObject(entry) || entry["kind"] !== SCOPED_KIND) return null;
  const scope = entry["scope"];
  if (!isObject(scope)) return null;
  const model = scope["model"];
  if (!isObject(model)) return null;
  const name = cleanVendorString(model["display_name"])?.toLowerCase();
  if (name === undefined) return null;
  const models = scopedModels(inventory, name);
  return {
    name,
    window:
      models.length === 0
        ? null
        : {
            id: `weekly-${name}`,
            label: `7d ${name}`,
            unit: "percent",
            used: null,
            limit: null,
            percent: finiteNumber(entry["percent"]),
            resetsAt: epochMillis(entry["resets_at"]),
            windowSeconds: WEEKLY_SECONDS,
            models,
            source: "endpoint",
          },
  };
}

/** The separately measured model groups' windows, per `limits` element in body order (Section 3.1). */
function scopedWindows(
  body: Record<string, unknown>,
  inventory: readonly InventoryModel[],
): LimitWindowCapture[] {
  const limits = body["limits"];
  if (!Array.isArray(limits)) return [];
  const windows: LimitWindowCapture[] = [];
  const seen = new Set<string>();
  for (const entry of limits) {
    const scoped = scopedWindow(entry, inventory);
    if (scoped === null || seen.has(scoped.name)) continue;
    seen.add(scoped.name);
    if (scoped.window !== null) windows.push(scoped.window);
  }
  return windows;
}

/** One provider-wide body window (Section 3); a key that is absent, `null`, or not an object yields none. */
function windowFrom(mapping: WindowMapping, window: Record<string, unknown>): LimitWindowCapture {
  return {
    id: mapping.id,
    label: mapping.label,
    unit: "percent",
    used: null,
    limit: null,
    percent: finiteNumber(window["utilization"]),
    resetsAt: epochMillis(window["resets_at"]),
    windowSeconds: mapping.windowSeconds,
    models: null,
    source: "endpoint",
  };
}

/** The windows the usage body maps to: provider-wide, then scoped (Section 3). */
function endpointWindows(
  body: Record<string, unknown>,
  inventory: readonly InventoryModel[],
): LimitWindowCapture[] {
  const windows: LimitWindowCapture[] = [];
  for (const mapping of WINDOW_MAPPINGS) {
    const window = body[mapping.key];
    if (isObject(window)) windows.push(windowFrom(mapping, window));
  }
  windows.push(...scopedWindows(body, inventory));
  return windows;
}

/** One observed window (Section 4): observed values, unobserved ones `null`. */
function observedWindow(
  window: ObservedWindow,
  id: string,
  label: string,
  windowSeconds: number,
): LimitWindowCapture {
  return {
    id,
    label,
    unit: "percent",
    used: null,
    limit: null,
    percent: finiteNumber(window.percent),
    resetsAt: finiteNumber(window.resetsAt),
    windowSeconds,
    models: null,
    source: "headers",
  };
}

/** The header observation's windows, five-hour then weekly (Section 4). */
function observedWindows(observation: HeaderObservation): LimitWindowCapture[] {
  const { fiveHour, weekly } = OBSERVED_WINDOWS;
  return [
    observedWindow(observation.fiveHour, fiveHour.id, fiveHour.label, fiveHour.windowSeconds),
    observedWindow(observation.weekly, weekly.id, weekly.label, weekly.windowSeconds),
  ];
}

/** The latest header observation, when younger than 3600 seconds (Section 4). */
function freshObservation(deps: AdapterDependencies): HeaderObservation | undefined {
  const observation = deps.observations.latest();
  if (!isHeaderObservation(observation)) return undefined;
  return deps.clock() - observation.observedAt < OBSERVATION_MAX_AGE_MS ? observation : undefined;
}

/** One usage request with the listed headers (Section 3). */
function issueUsageRequest(
  token: string,
  deps: AdapterDependencies,
  signal: AbortSignal,
): Promise<TransportOutcome> {
  const request: TransportRequest = {
    url: USAGE_URL,
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
    bodyCap: USAGE_BODY_CAP,
    signal,
  };
  return deps.transport(request);
}

/**
 * Runs the usage request and, on `http-401`, resolves credentials once more and repeats the
 * request once with a differing token (Section 3). When the repeat fails, the `http-401` stands
 * (Section 3: "otherwise, or when the repeat fails, the failure stands").
 */
async function usageRequest(
  token: string,
  deps: AdapterDependencies,
  signal: AbortSignal,
): Promise<UsageOutcome> {
  const first = await issueUsageRequest(token, deps, signal);

  if (!("reason" in first)) {
    const body = parseBody(first.body);
    if (body === null) {
      const failure: AdapterFailure = { reason: "bad-response" };
      return { failure, firstFailure: failure };
    }
    return { body };
  }

  const firstFailure = failureFrom(first);
  if (first.reason !== "http-401") {
    return { failure: firstFailure, firstFailure };
  }

  const renewed = await deps.credentials();
  const renewedToken = renewed?.apiKey;
  if (renewedToken === undefined || renewedToken === token) {
    return { failure: firstFailure, firstFailure };
  }

  const retried = await issueUsageRequest(renewedToken, deps, signal);
  const body = "reason" in retried ? null : parseBody(retried.body);
  if (body === null) {
    return { failure: firstFailure, firstFailure };
  }
  return { body, firstFailure };
}

/** The result fields a successful run shares (adapter-contract.md Section 2). */
function success(outcome: UsageOutcome, limits: Facet<LimitWindowCapture[]>): AdapterSuccess {
  return {
    facets: { limits },
    ...(outcome.firstFailure === undefined ? {} : { firstFailure: outcome.firstFailure }),
  };
}

/** One refresh (adapter-contract.md Section 2, adapter-anthropic.md Sections 2–4). */
async function refresh(deps: AdapterDependencies, signal: AbortSignal): Promise<AdapterResult> {
  // adapter-contract.md Section 3 checks ran before `run`; this is the adapter's own (Section 2).
  const credentials = await deps.credentials();
  if (credentials === undefined) return { reason: "no-credentials" };
  if (!credentials.oauth) return { reason: "unsupported-auth" };

  const outcome = await usageRequest(credentials.apiKey, deps, signal);

  if ("failure" in outcome) {
    // adapter-anthropic.md Section 4: an `internal` failure stands even when a fresh
    // header observation exists; only other reasons fall back to the observation.
    if (outcome.failure.reason === "internal") return outcome.failure;
    const observation = freshObservation(deps);
    if (observation === undefined) return outcome.failure;
    return {
      ...success(outcome, { state: "known", value: observedWindows(observation) }),
      capturedAt: observation.observedAt,
      captureReason: outcome.failure.reason,
    };
  }

  const windows = endpointWindows(outcome.body, deps.inventory);
  const primary = windows.some((window) => window.id === "five-hour" || window.id === "weekly");
  if (!primary) {
    return success(outcome, { state: "unavailable", reason: "empty-response" });
  }
  return success(outcome, { state: "known", value: windows });
}

/** The headers a header observation reads (adapter-anthropic.md Section 4). */
const OBSERVATION_HEADERS = {
  fiveHourUtilization: "anthropic-ratelimit-unified-5h-utilization",
  fiveHourReset: "anthropic-ratelimit-unified-5h-reset",
  weeklyUtilization: "anthropic-ratelimit-unified-7d-utilization",
  weeklyReset: "anthropic-ratelimit-unified-7d-reset",
} as const;

/**
 * The header observation inference-response headers yield (adapter-anthropic.md Section 4), or
 * `undefined` when neither utilization header is present. Header names compare
 * case-insensitively. The caller records it only for responses of provider `anthropic`.
 */
export function observeHeaders(
  headers: Readonly<Record<string, string>>,
  now: number,
): HeaderObservation | undefined {
  const lower = lowercaseHeaders(headers);
  if (
    !lower.has(OBSERVATION_HEADERS.fiveHourUtilization) &&
    !lower.has(OBSERVATION_HEADERS.weeklyUtilization)
  ) {
    return undefined;
  }
  const percent = (name: string): number | null => {
    const fraction = headerNumber(lower, name);
    return fraction === null ? null : fraction * 100;
  };
  const resetsAt = (name: string): number | null => {
    const seconds = headerNumber(lower, name);
    return seconds === null ? null : seconds * 1000;
  };
  return {
    observedAt: now,
    fiveHour: {
      percent: percent(OBSERVATION_HEADERS.fiveHourUtilization),
      resetsAt: resetsAt(OBSERVATION_HEADERS.fiveHourReset),
    },
    weekly: {
      percent: percent(OBSERVATION_HEADERS.weeklyUtilization),
      resetsAt: resetsAt(OBSERVATION_HEADERS.weeklyReset),
    },
  };
}

/** The Anthropic adapter (adapter-anthropic.md Section 1). */
export const anthropic: Adapter = {
  id: "anthropic",
  providerOrigin: PROVIDER_ORIGIN,
  hostAllowlist: HOST_ALLOWLIST,
  exposedFacets: ["limits"],
  freshnessSeconds: 120,

  async run(deps: AdapterDependencies, signal: AbortSignal): Promise<AdapterResult> {
    try {
      return await refresh(deps, signal);
    } catch {
      return { reason: "internal" };
    }
  },
};
