/**
 * The Antigravity adapter (specs/adapter-antigravity.md): the Cloud Code Assist quota summary,
 * plan, and credits read with the Google account's OAuth credential. The module performs no
 * I/O; transport, credentials, and clock arrive as dependencies (adapter-contract.md Section
 * 2). `run` never rejects.
 */

import type { Adapter, AdapterDependencies, InventoryModel } from "../adapter.ts";
import {
  cleanVendorString,
  finiteNumber,
  type AdapterFailure,
  type AdapterResult,
  type Facet,
  type LimitWindowCapture,
} from "../state.ts";

/** Provider origin and host allowlist (Section 1). */
const PROVIDER_ORIGIN = "https://daily-cloudcode-pa.googleapis.com";
const HOST_ALLOWLIST: readonly string[] = [
  PROVIDER_ORIGIN,
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

/** The usage endpoints (Sections 3–4). */
const QUOTA_URL = `${PROVIDER_ORIGIN}/v1internal:retrieveUserQuotaSummary`;
const ASSIST_URL = `${PROVIDER_ORIGIN}/v1internal:loadCodeAssist`;

/** The verbatim request bodies and user agent (Sections 3–4). */
const QUOTA_BODY = "{}";
const ASSIST_BODY =
  '{"metadata":{"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}}';
const USER_AGENT =
  "antigravity/cli/1.5.5 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)";

/** Body cap, 1 MiB (Section 1). */
const BODY_CAP = 1024 * 1024;

/** The credential the host stores for the provider (Section 2). */
interface AntigravityCredential {
  token: string;
  projectId: string;
}

const TOKEN_PATTERN = /^[\x21-\x7e]+$/u;

/** The credential of the `apiKey` blob, or `null` when it is not one (Section 2). */
function parseCredential(apiKey: string): AntigravityCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(apiKey);
  } catch {
    return null;
  }
  const object = asRecord(parsed);
  if (object === null) return null;
  const token = object["token"];
  const projectId = object["projectId"];
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  if (typeof projectId !== "string" || !TOKEN_PATTERN.test(projectId)) return null;
  return { token, projectId };
}

/** A JSON object, else `null` (untrusted vendor data). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

/** The string at `key` of a JSON object, else `null` (untrusted vendor data). */
function stringAt(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  return typeof value === "string" ? value : null;
}

/** The array at `key` of a JSON object, else `null` (untrusted vendor data). */
function arrayAt(object: Record<string, unknown>, key: string): readonly unknown[] | null {
  const value = object[key];
  return Array.isArray(value) ? value : null;
}

/** The epoch milliseconds of an RFC 3339 date-time, else `null` (Section 3). */
function epochOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** One response: the object body, or the failure that replaces it. */
interface Response {
  body: Record<string, unknown> | null;
  failure?: AdapterFailure;
}

async function post(
  deps: AdapterDependencies,
  url: string,
  token: string,
  body: string,
  signal: AbortSignal,
): Promise<Response> {
  const outcome = await deps.transport({
    url,
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    },
    body,
    bodyCap: BODY_CAP,
    signal,
  });
  if ("reason" in outcome) {
    return {
      body: null,
      failure:
        outcome.retryAfter === undefined
          ? { reason: outcome.reason }
          : { reason: outcome.reason, retryAfter: outcome.retryAfter },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.body);
  } catch {
    return { body: null, failure: { reason: "bad-response" } };
  }
  const object = asRecord(parsed);
  return object === null ? { body: null, failure: { reason: "bad-response" } } : { body: object };
}

const FIVE_HOUR_SECONDS = 18000;
const WEEKLY_SECONDS = 604800;

interface GroupScope {
  tag: string | null;
  models: string[] | null;
}

/** Derives the compact group tag and matching inventory models from `group.displayName` (Section 3). */
function groupScope(
  rawDisplayName: string | null,
  inventory: readonly InventoryModel[],
): GroupScope {
  const cleaned = cleanVendorString(rawDisplayName);
  if (cleaned === null) return { tag: null, models: null };
  const stripped = cleaned
    .toLowerCase()
    .replace(/\s+models?$/u, "")
    .trim();
  const families = stripped
    .split(/\s+and\s+/u)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (families.length === 0) return { tag: null, models: null };
  const tag = families.join("/");
  const needles = families.map((family) => family.replace(/\s+/gu, "-"));
  const matched = inventory
    .filter((model) => {
      const lower = model.id.toLowerCase();
      return needles.some((needle) => lower.includes(needle));
    })
    .map((model) => model.id);
  return { tag, models: matched };
}

/** Recognizes 5h and 7d durations from a bucket's cleaned display name (Section 3). */
function bucketDuration(
  displayName: string | null,
): { token: "5h" | "7d"; seconds: number } | null {
  if (displayName === null) return null;
  const lower = displayName.toLowerCase();
  if (
    lower.includes("five hour") ||
    lower.includes("5 hour") ||
    lower.includes("5-hour") ||
    /(?:^|[^a-z0-9])5h(?:$|[^a-z0-9])/u.test(lower)
  ) {
    return { token: "5h", seconds: FIVE_HOUR_SECONDS };
  }
  if (
    lower.includes("weekly") ||
    lower.includes("seven day") ||
    lower.includes("7 day") ||
    lower.includes("7-day") ||
    /(?:^|[^a-z0-9])7d(?:$|[^a-z0-9])/u.test(lower)
  ) {
    return { token: "7d", seconds: WEEKLY_SECONDS };
  }
  return null;
}

/** The quota pools' windows (Section 3). */
function quotaWindows(
  body: Record<string, unknown> | null,
  inventory: readonly InventoryModel[],
): LimitWindowCapture[] {
  if (body === null) return [];
  const windows = new Map<string, LimitWindowCapture>();
  for (const group of arrayAt(body, "groups") ?? []) {
    const groupObject = asRecord(group);
    if (groupObject === null) continue;
    const scope = groupScope(stringAt(groupObject, "displayName"), inventory);
    for (const bucket of arrayAt(groupObject, "buckets") ?? []) {
      const bucketObject = asRecord(bucket);
      if (bucketObject === null) continue;
      const bucketId = cleanVendorString(stringAt(bucketObject, "bucketId"));
      const displayName = cleanVendorString(stringAt(bucketObject, "displayName"));
      const fraction = finiteNumber(bucketObject["remainingFraction"]);
      // A fraction outside [0, 1] carries no honest percentage (Section 3).
      if (fraction === null || fraction < 0 || fraction > 1) continue;
      const id = bucketId ?? displayName;
      if (id === null || windows.has(id)) continue;
      const duration = bucketDuration(displayName);
      const label =
        duration === null
          ? (displayName ?? id)
          : scope.tag === null
            ? duration.token
            : `${duration.token} ${scope.tag}`;
      windows.set(id, {
        id,
        label,
        unit: "percent",
        used: null,
        limit: null,
        percent: Math.round((1 - fraction) * 1000) / 10,
        resetsAt: epochOf(bucketObject["resetTime"]),
        windowSeconds: duration === null ? null : duration.seconds,
        models: scope.models,
        source: "endpoint",
      });
    }
  }
  return [...windows.values()];
}

/** The plan name, first that applies (Section 4). */
function planName(body: Record<string, unknown> | null): string | null {
  if (body === null) return null;
  const paid = asRecord(body["paidTier"]);
  const current = asRecord(body["currentTier"]);
  const names = [
    paid === null ? null : cleanVendorString(stringAt(paid, "name")),
    paid === null ? null : cleanVendorString(stringAt(paid, "id")),
    current === null ? null : cleanVendorString(stringAt(current, "name")),
    current === null ? null : cleanVendorString(stringAt(current, "id")),
  ];
  return names.find((name) => name !== null) ?? null;
}

/** The credit windows of the first credits array present (Section 4). */
function creditWindows(body: Record<string, unknown> | null): LimitWindowCapture[] {
  if (body === null) return [];
  const paid = asRecord(body["paidTier"]);
  const current = asRecord(body["currentTier"]);
  const credits =
    (paid === null ? null : arrayAt(paid, "availableCredits")) ??
    (current === null ? null : arrayAt(current, "availableCredits")) ??
    arrayAt(body, "availableCredits");
  if (credits === null) return [];
  const windows: LimitWindowCapture[] = [];
  const seen = new Set<string>();
  for (const credit of credits) {
    const creditObject = asRecord(credit);
    if (creditObject === null) continue;
    const amount = finiteNumber(creditObject["creditAmount"]);
    if (amount === null) continue;
    const type = cleanVendorString(stringAt(creditObject, "creditType"));
    const id = type === null ? "credits" : `credits:${type}`;
    if (seen.has(id)) continue;
    seen.add(id);
    windows.push({
      id,
      label: "credits",
      unit: "credits",
      used: null,
      limit: amount,
      percent: null,
      resetsAt: null,
      windowSeconds: null,
      models: null,
      source: "endpoint",
    });
  }
  return windows;
}

async function refresh(deps: AdapterDependencies, signal: AbortSignal): Promise<AdapterResult> {
  const credentials = await deps.credentials();
  if (credentials === undefined) return { reason: "no-credentials" };
  if (!credentials.oauth) return { reason: "unsupported-auth" };
  const credential = parseCredential(credentials.apiKey);
  if (credential === null) return { reason: "unsupported-auth" };
  const { token } = credential;

  // Sections 3–4: the issue order, quota summary before plan.
  const summary = await post(deps, QUOTA_URL, token, QUOTA_BODY, signal);
  const assist = await post(deps, ASSIST_URL, token, ASSIST_BODY, signal);
  const firstFailure = summary.failure ?? assist.failure;

  let limits: Facet<LimitWindowCapture[]>;
  if (summary.failure === undefined) {
    const windows = [...quotaWindows(summary.body, deps.inventory), ...creditWindows(assist.body)];
    limits =
      windows.length === 0
        ? { state: "unavailable", reason: "empty-response" }
        : { state: "known", value: windows };
  } else {
    limits = { state: "unavailable", reason: summary.failure.reason };
  }

  let plan: Facet<string>;
  if (assist.failure === undefined) {
    const name = planName(assist.body);
    plan =
      name === null
        ? { state: "unavailable", reason: "empty-response" }
        : { state: "known", value: name };
  } else {
    plan = { state: "unavailable", reason: assist.failure.reason };
  }

  return firstFailure === undefined
    ? { facets: { plan, limits } }
    : { facets: { plan, limits }, firstFailure };
}

async function run(deps: AdapterDependencies, signal: AbortSignal): Promise<AdapterResult> {
  try {
    return await refresh(deps, signal);
  } catch {
    return { reason: "internal" };
  }
}

export const antigravity: Adapter = {
  id: "antigravity",
  providerOrigin: PROVIDER_ORIGIN,
  hostAllowlist: HOST_ALLOWLIST,
  exposedFacets: ["plan", "limits"],
  freshnessSeconds: 300,
  run,
};
