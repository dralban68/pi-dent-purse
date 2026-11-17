/**
 * The OpenAI Codex adapter (specs/adapter-openai-codex.md): the ChatGPT subscription usage
 * endpoint read with the OAuth credential. The module performs no I/O; transport, credentials,
 * and clock arrive as dependencies (adapter-contract.md Section 2). `run` never rejects.
 */

import type { Adapter, AdapterDependencies, TransportOutcome } from "../adapter.ts";
import {
  cleanVendorString,
  finiteNumber,
  type AdapterFailure,
  type AdapterResult,
  type Facet,
  type LimitWindowCapture,
} from "../state.ts";

/** Provider origin and host allowlist (Section 1). */
const PROVIDER_ORIGIN = "https://chatgpt.com";
const HOST_ALLOWLIST: readonly string[] = [PROVIDER_ORIGIN];

/** The usage endpoint (Section 3). */
const USAGE_URL = `${PROVIDER_ORIGIN}/backend-api/wham/usage`;

/** Body cap, 16 KiB (Section 1). */
const BODY_CAP = 16 * 1024;

/** The `rate_limit` windows, in order (Section 4). */
const WINDOW_MAPPINGS = [
  { key: "primary_window", id: "five-hour", label: "5h", windowSeconds: 18000 },
  { key: "secondary_window", id: "weekly", label: "7d", windowSeconds: 604800 },
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  return isObject(parsed) ? parsed : null;
}

/** The windows of `rate_limit` (Section 4). */
function windows(body: Record<string, unknown>): LimitWindowCapture[] {
  const rateLimit = body["rate_limit"];
  if (!isObject(rateLimit)) return [];
  const result: LimitWindowCapture[] = [];
  for (const mapping of WINDOW_MAPPINGS) {
    const window = rateLimit[mapping.key];
    if (!isObject(window)) continue;
    const length = finiteNumber(window["limit_window_seconds"]);
    const resetAt = finiteNumber(window["reset_at"]);
    result.push({
      id: mapping.id,
      label: mapping.label,
      unit: "percent",
      used: null,
      limit: null,
      percent: finiteNumber(window["used_percent"]),
      resetsAt: resetAt === null ? null : resetAt * 1000,
      windowSeconds: length !== null && length > 0 ? length : mapping.windowSeconds,
      models: null,
      source: "endpoint",
    });
  }
  return result;
}

async function refresh(deps: AdapterDependencies, signal: AbortSignal): Promise<AdapterResult> {
  const credentials = await deps.credentials();
  if (credentials === undefined) return { reason: "no-credentials" };
  if (!credentials.oauth) return { reason: "unsupported-auth" };

  const outcome: TransportOutcome = await deps.transport({
    url: USAGE_URL,
    headers: { authorization: `Bearer ${credentials.apiKey}` },
    bodyCap: BODY_CAP,
    signal,
  });
  let failure: AdapterFailure | undefined;
  let body: Record<string, unknown> | null = null;
  if ("reason" in outcome) {
    failure =
      outcome.retryAfter === undefined
        ? { reason: outcome.reason }
        : { reason: outcome.reason, retryAfter: outcome.retryAfter };
  } else {
    body = parseBody(outcome.body);
    if (body === null) failure = { reason: "bad-response" };
  }
  if (failure !== undefined || body === null) {
    const reason = failure?.reason ?? "bad-response";
    return {
      facets: {
        plan: { state: "unavailable", reason },
        limits: { state: "unavailable", reason },
      },
      firstFailure: failure ?? { reason },
    };
  }

  const found = windows(body);
  const limits: Facet<LimitWindowCapture[]> =
    found.length === 0
      ? { state: "unavailable", reason: "empty-response" }
      : { state: "known", value: found };
  const planName = cleanVendorString(body["plan_type"]);
  const plan: Facet<string> =
    planName === null
      ? { state: "unavailable", reason: "empty-response" }
      : { state: "known", value: planName };
  return { facets: { plan, limits } };
}

async function run(deps: AdapterDependencies, signal: AbortSignal): Promise<AdapterResult> {
  try {
    return await refresh(deps, signal);
  } catch {
    return { reason: "internal" };
  }
}

export const openaiCodex: Adapter = {
  id: "openai-codex",
  providerOrigin: PROVIDER_ORIGIN,
  hostAllowlist: HOST_ALLOWLIST,
  exposedFacets: ["plan", "limits"],
  freshnessSeconds: 120,
  run,
};
