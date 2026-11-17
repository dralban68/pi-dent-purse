/**
 * The Exa adapter (specs/adapter-exa.md): the team's credits balance (Section 2) and the spend
 * of its API keys over the last 30 days (Section 3), read with an Exa team service key. It is a
 * tool provider (adapter-contract.md Section 1): no provider origin, credential from the
 * `PURSE_EXA_SERVICE_KEY` environment variable. The adapter performs no I/O of its own: every
 * request goes through the injected transport, and `run` never rejects.
 */

import type {
  Adapter,
  AdapterDependencies,
  TransportFailure,
  TransportOutcome,
} from "../adapter.ts";
import {
  finiteNumber,
  type AdapterFailure,
  type AdapterResult,
  type BalanceItemCapture,
  type Facet,
  type LimitWindowCapture,
} from "../state.ts";

/** The credential variable (Section 1); config-file.md Section 3 owns its name. */
const CREDENTIAL_VARIABLE = "PURSE_EXA_SERVICE_KEY";

/** The only origin the adapter contacts (Section 1). */
const ADMIN_ORIGIN = "https://admin-api.exa.ai";

/** The credits and key list endpoints (Sections 2–3). */
const CREDITS_URL = `${ADMIN_ORIGIN}/team-management/credits`;
const KEYS_URL = `${ADMIN_ORIGIN}/team-management/api-keys`;

/** Body caps in bytes, one per endpoint (Section 1). */
const CREDITS_BODY_CAP = 16 * 1024;
const KEYS_BODY_CAP = 256 * 1024;
const USAGE_BODY_CAP = 64 * 1024;

/** Freshness period, 900 seconds (Section 1). */
const FRESHNESS_SECONDS = 900;

/** The spend window, 30 days in seconds (Section 3). */
const SPEND_WINDOW_SECONDS = 2_592_000;

/** Most elements the key list may hold (Section 3). */
const MAX_KEYS = 32;

/** Most key usage requests in flight at a time (Section 3). */
const MAX_IN_FLIGHT = 4;

/** A `publicId` as the vendor sends it (Section 3). */
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/** A JSON object, excluding `null` and arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON array, else `null`. */
function arrayOf(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** A body that is a JSON object, else `null` (Section 1). */
function parseObject(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

/** A transport failure as a result failure (adapter-contract.md Section 2). */
function failureOf(failure: TransportFailure): AdapterFailure {
  return failure.retryAfter === undefined
    ? { reason: failure.reason }
    : { reason: failure.reason, retryAfter: failure.retryAfter };
}

/** One GET of Sections 2–3, carrying only the credential header (Section 1). */
function get(
  deps: AdapterDependencies,
  url: string,
  apiKey: string,
  bodyCap: number,
  signal: AbortSignal,
): Promise<TransportOutcome> {
  return deps.transport({ url, headers: { "x-api-key": apiKey }, bodyCap, signal });
}

/** The credits body as one balance item, or the request's failure (Section 2). */
function balanceOutcome(
  outcome: TransportOutcome,
): { item: BalanceItemCapture } | { failure: AdapterFailure } {
  if ("reason" in outcome) return { failure: failureOf(outcome) };
  const body = parseObject(outcome.body);
  const amount = body === null ? null : finiteNumber(body["credits_usd"]);
  if (amount === null) return { failure: { reason: "bad-response" } };
  return { item: { amount, currency: "USD", currencyAssumed: false, gatesUsage: true } };
}

/** The distinct `publicId`s of the key list in body order, or its failure (Section 3). */
function keyListOutcome(
  outcome: TransportOutcome,
): { publicIds: string[] } | { failure: AdapterFailure } {
  if ("reason" in outcome) return { failure: failureOf(outcome) };
  const body = parseObject(outcome.body);
  const keys = body === null ? null : arrayOf(body["apiKeys"]);
  if (keys === null) return { failure: { reason: "bad-response" } };
  const publicIds: string[] = [];
  const seen = new Set<string>();
  for (const entry of keys) {
    const publicId = isRecord(entry) ? entry["publicId"] : undefined;
    if (typeof publicId !== "string" || !PUBLIC_ID_PATTERN.test(publicId)) {
      return { failure: { reason: "bad-response" } };
    }
    if (seen.has(publicId)) continue;
    seen.add(publicId);
    publicIds.push(publicId);
  }
  if (keys.length > MAX_KEYS) return { failure: { reason: "response-too-large" } };
  return { publicIds };
}

/** A usage body's `total_cost_usd`, or the request's failure (Section 3). */
function usageOutcome(outcome: TransportOutcome): { cost: number } | { failure: AdapterFailure } {
  if ("reason" in outcome) return { failure: failureOf(outcome) };
  const body = parseObject(outcome.body);
  const cost = body === null ? null : finiteNumber(body["total_cost_usd"]);
  if (cost === null || cost < 0) return { failure: { reason: "bad-response" } };
  return { cost };
}

/** `epochMs` as `YYYY-MM-DDTHH:MM:SSZ` in UTC, seconds rounded down (Section 3). */
function rfc3339(epochMs: number): string {
  const time = new Date(epochMs);
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  const date = `${pad(time.getUTCFullYear(), 4)}-${pad(time.getUTCMonth() + 1, 2)}-${pad(
    time.getUTCDate(),
    2,
  )}`;
  const clock = `${pad(time.getUTCHours(), 2)}:${pad(time.getUTCMinutes(), 2)}:${pad(
    time.getUTCSeconds(),
    2,
  )}`;
  return `${date}T${clock}Z`;
}

/** A sum of money rounded to two decimals (Section 3). */
function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The single spend window (Section 3). */
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
    windowSeconds: SPEND_WINDOW_SECONDS,
    models: null,
    source: "endpoint",
  };
}

/**
 * The keys' spend over the window (Section 3): one usage request per public id, in key list
 * order, at most 4 in flight, and no request issued once one has failed. The failure returned
 * is the first in issue order; the cost is the sum rounded to two decimals.
 */
async function spend(
  deps: AdapterDependencies,
  publicIds: readonly string[],
  apiKey: string,
  signal: AbortSignal,
  start: string,
  end: string,
): Promise<{ cost: number } | { failure: AdapterFailure }> {
  const results: ({ cost: number } | { failure: AdapterFailure })[] = [];
  let next = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed) return;
      const index = next;
      const publicId = publicIds[index];
      if (publicId === undefined) return;
      next += 1;
      const url = `${KEYS_URL}/${publicId}/usage?start_date=${start}&end_date=${end}`;
      const result = usageOutcome(await get(deps, url, apiKey, USAGE_BODY_CAP, signal));
      results[index] = result;
      if ("failure" in result) failed = true;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_IN_FLIGHT, publicIds.length) }, () => worker()),
  );

  let firstFailure: AdapterFailure | undefined;
  for (const result of results) {
    if (result !== undefined && "failure" in result) {
      firstFailure = result.failure;
      break;
    }
  }
  if (firstFailure !== undefined) return { failure: firstFailure };

  let total = 0;
  for (const result of results) {
    if (result !== undefined && "cost" in result) total += result.cost;
  }
  return { cost: roundToCents(total) };
}

/** One refresh: the credits and key list requests, then the key usage requests. */
async function refresh(deps: AdapterDependencies, signal: AbortSignal): Promise<AdapterResult> {
  // Section 3: the window ends at the clock's time at the start of `run`.
  const endMs = deps.clock();
  const end = rfc3339(endMs);
  const start = rfc3339(endMs - SPEND_WINDOW_SECONDS * 1000);

  // adapter-contract.md Section 3 checks ran before `run`; any credential is accepted.
  const credentials = await deps.credentials();
  if (credentials === undefined) return { reason: "no-credentials" };
  const apiKey = credentials.apiKey;

  // The key list runs concurrently with the credits request; issue order is credits first.
  const [credits, keys] = await Promise.all([
    get(deps, CREDITS_URL, apiKey, CREDITS_BODY_CAP, signal),
    get(deps, KEYS_URL, apiKey, KEYS_BODY_CAP, signal),
  ]);

  const balance = balanceOutcome(credits);
  const keyList = keyListOutcome(keys);
  const failures: AdapterFailure[] = [];
  if ("failure" in balance) failures.push(balance.failure);
  if ("failure" in keyList) failures.push(keyList.failure);

  const balanceFacet: Facet<BalanceItemCapture[]> =
    "failure" in balance
      ? { state: "unavailable", reason: balance.failure.reason }
      : { state: "known", value: [balance.item] };

  let limitsFacet: Facet<LimitWindowCapture[]>;
  if ("failure" in keyList) {
    limitsFacet = { state: "unavailable", reason: keyList.failure.reason };
  } else {
    const spent = await spend(deps, keyList.publicIds, apiKey, signal, start, end);
    if ("failure" in spent) {
      failures.push(spent.failure);
      limitsFacet = { state: "unavailable", reason: spent.failure.reason };
    } else {
      limitsFacet = { state: "known", value: [spendWindow(spent.cost)] };
    }
  }

  const firstFailure = failures[0];
  return {
    facets: { balance: balanceFacet, limits: limitsFacet },
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

/**
 * The Exa adapter (Section 1): id `exa`, a tool provider with no provider origin, credential
 * variable `PURSE_EXA_SERVICE_KEY`, host allowlist `https://admin-api.exa.ai`, freshness period
 * 900 seconds, exposed facets `balance` and `limits`.
 */
export const exa: Adapter = {
  id: "exa",
  credentialVariable: CREDENTIAL_VARIABLE,
  hostAllowlist: [ADMIN_ORIGIN],
  exposedFacets: ["balance", "limits"],
  freshnessSeconds: FRESHNESS_SECONDS,
  run,
};
