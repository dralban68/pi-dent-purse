/**
 * Google adapter (specs/adapter-google.md): the usage tier and the quota limit windows of the
 * Gemini API key's cloud project. Sections 2–6 run in order: access token from `gcloud`, cloud
 * project from configuration, store or the API Keys API, quota metadata from Cloud Quotas,
 * metric types and one limit series request per `/limit` type from Cloud Monitoring, one
 * daily usage request per family with a `day` window, and the estimated spend of a paid tier
 * from the month's token counts (Section 7).
 * Shared behavior is owned by specs/adapter-contract.md.
 *
 * The adapter performs no I/O itself: every request goes through `deps.transport` and every
 * command through `deps.commandRunner`.
 */

import { createHash } from "node:crypto";

import type { Adapter, AdapterDependencies, CommandRunner } from "../adapter.ts";
import { derivePrice } from "../prices.ts";
import {
  cleanVendorString,
  finiteNumber,
  type AdapterFailure,
  type AdapterResult,
  type CaptureFacets,
  type Facet,
  type LimitWindowCapture,
} from "../state.ts";

/** Provider origin (Section 1): the Gemini API. */
const PROVIDER_ORIGIN = "https://generativelanguage.googleapis.com";

/** Host origins the adapter may contact (Section 1). */
const API_KEYS_ORIGIN = "https://apikeys.googleapis.com";
const CLOUD_QUOTAS_ORIGIN = "https://cloudquotas.googleapis.com";
const MONITORING_ORIGIN = "https://monitoring.googleapis.com";
const HOST_ALLOWLIST: readonly string[] = [API_KEYS_ORIGIN, CLOUD_QUOTAS_ORIGIN, MONITORING_ORIGIN];

/** Freshness period in seconds (Section 1). */
const FRESHNESS_SECONDS = 300;

/** Body cap in bytes of a 2xx response body (Section 1). */
const API_KEYS_BODY_CAP = 16 * 1024;
const DEFAULT_BODY_CAP = 1024 * 1024;

/** The one `gcloud` invocation (Section 2). */
const GCLOUD_COMMAND = "gcloud";
const GCLOUD_ARGS: readonly string[] = [
  "auth",
  "print-access-token",
  "--quiet",
  "--verbosity=error",
];
const GCLOUD_DEADLINE_MS = 10_000;
const GCLOUD_OUTPUT_CAP = 8 * 1024;

/** A trimmed access token: 1–4096 characters of the URL-safe token alphabet (Section 2). */
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{1,4096}$/;

/** The quota service and the metric-type shape of its series (Sections 4–6). */
const QUOTA_SERVICE = "generativelanguage.googleapis.com";
const QUOTA_METRIC_PREFIX = `${QUOTA_SERVICE}/quota/`;
const DESCRIPTOR_FILTER = `metric.type = starts_with("${QUOTA_METRIC_PREFIX}")`;
const DESCRIPTOR_PAGE_SIZE = 500;
const LIMIT_SUFFIX = "/limit";
const LIMIT_ALIGNMENT_PERIOD = "90000s";
const LIMIT_ALIGNER = "ALIGN_NEXT_OLDER";
const USAGE_ALIGNER = "ALIGN_SUM";
const LIMIT_LOOKBACK_MS = 25 * 3_600_000;
const MIN_USAGE_ALIGNMENT_SECONDS = 60;

/** The estimated spend window and its token metric types (Section 7). */
const OUTPUT_TOKEN_TYPE = `${QUOTA_SERVICE}/generate_content_usage_output_token_count`;
const USAGE_SUFFIX = "/usage";
const INPUT_TOKEN_FAMILY = "input_token_count";
const SPEND_ID = "spend:month";
const SPEND_LABEL = "spend est/month";
const SPEND_CURRENCY = "USD";
const TOKENS_PER_RATE = 1_000_000;

/** Paging and metadata caching (Section 4, "at most 5 pages"). */
const MAX_PAGES = 5;
const QUOTA_INFOS_PAGE_SIZE = 200;
const METADATA_TTL_SECONDS = 86_400;

/** The window lengths of the two known intervals and the unlimited sentinel (Sections 5–6). */
const DAY_SECONDS = 86_400;
const MINUTE_SECONDS = 60;
const UNLIMITED = -1;

/** The cloud project's parent in a `keys:lookupKey` response (Section 3). */
const PROJECT_PARENT_PATTERN = /^projects\/([^/]+)\/locations\//;

/** A cloud project id or number (Section 3; config-file.md Section 2, `project`). */
const PROJECT_PATTERN = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,20})$/;

/** The time zone of the day windows' midnight (Sections 5–6). */
const LA_TIME_ZONE = "America/Los_Angeles";

const FREE_TIER = "Free tier";
const PAID_TIER_1 = "Paid tier 1";
const PAID_TIER_2 = "Paid tier 2";
const PAID_TIER_3 = "Paid tier 3";

/** The interval a quota id resets in; `null` is the spec's "otherwise unknown". */
type QuotaInterval = "day" | "minute" | null;

/** A calendar date in `America/Los_Angeles`. */
interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** The first failed request or command of one run (adapter-contract.md Section 2). */
interface Tally {
  firstFailure: AdapterFailure | undefined;
}

/** Everything one run needs after the access token is known. */
interface RunContext {
  readonly deps: AdapterDependencies;
  readonly signal: AbortSignal;
  readonly apiKey: string;
  readonly token: string;
  readonly now: number;
  readonly tally: Tally;
}

/** Outcome of a step that either yields a value or is a whole failure (Sections 2–5). */
type StepResult<T> = { ok: true; value: T } | { ok: false; failure: AdapterFailure };

/** Outcome of one request: the parsed body, or the failure plus the response's status. */
type RequestOutcome =
  | { ok: true; body: unknown }
  | { ok: false; failure: AdapterFailure; status: number | undefined };

/** The `limit_name` and `model` labels a series carries (Section 5). */
interface SeriesLabels {
  /** Cleaned, for the returned window (billing-state.md Section 7). */
  quotaId: string | null;
  /** As sent by the vendor, compared with the quota metadata's `quotaId` (Section 5). */
  rawQuotaId: string | null;
  /** Cleaned; `null` when absent. */
  model: string | null;
  /** As sent by the vendor; `null` when absent. */
  rawModel: string | null;
}

/** One `timeSeries[]` object (Section 5). */
interface QuotaSeries extends SeriesLabels {
  family: string;
  value: number;
}

/** A `day` window waiting for its `used` from Section 6. */
interface DayWindow {
  window: LimitWindowCapture;
  family: string;
  rawQuotaId: string;
  rawModel: string | null;
}

/**
 * The quota metadata: the `refreshInterval` per `quotaId` (`null` when the vendor sent no
 * string), or `null` when the metadata is absent (Section 4).
 */
type QuotaMetadata = ReadonlyMap<string, string | null>;

/** The spend cap in USD of a usage tier, `null` when it has no fixed one (Section 7). */
const SPEND_CAPS: Readonly<Record<string, number>> = { [PAID_TIER_1]: 250, [PAID_TIER_2]: 2000 };

const LA_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: LA_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** A JSON object, else `null` (untrusted vendor data). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

/** The array at `key` of a JSON object, else an empty array (untrusted vendor data). */
function arrayAt(body: unknown, key: string): readonly unknown[] {
  const object = asRecord(body);
  if (object === null) return [];
  const value = object[key];
  return Array.isArray(value) ? value : [];
}

/** The string at `key` of a JSON object, else `null` (untrusted vendor data). */
function stringAt(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  return typeof value === "string" ? value : null;
}

/** An RFC 3339 timestamp for a moment in time (Sections 5–6). */
function rfc3339(ms: number): string {
  return new Date(ms).toISOString();
}

/** The civil date and time of `ms` in `America/Los_Angeles` (Sections 5–6). */
function losAngelesParts(ms: number): CivilDate & { hour: number; minute: number; second: number } {
  const parts = LA_PARTS_FORMATTER.formatToParts(ms);
  const read = (type: string): number => {
    const part = parts.find((entry) => entry.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** The instant of a calendar date's midnight in `America/Los_Angeles` (Sections 5–6). */
function losAngelesMidnight(date: CivilDate): number {
  const target = Date.UTC(date.year, date.month - 1, date.day);
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = losAngelesParts(instant);
    const observedMs = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const delta = target - observedMs;
    if (delta === 0) break;
    instant += delta;
  }
  return instant;
}

/** The latest midnight in `America/Los_Angeles` at or before `ms` (Section 6). */
function latestLosAngelesMidnight(ms: number): number {
  return losAngelesMidnight(losAngelesParts(ms));
}

/** The next midnight in `America/Los_Angeles` after `ms` (Section 5). */
function nextLosAngelesMidnight(ms: number): number {
  const date = losAngelesParts(ms);
  const tomorrow = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return losAngelesMidnight({
    year: tomorrow.getUTCFullYear(),
    month: tomorrow.getUTCMonth() + 1,
    day: tomorrow.getUTCDate(),
  });
}

/** The latest month start in `America/Los_Angeles` at or before `ms` (Section 7). */
function latestLosAngelesMonthStart(ms: number): number {
  const date = losAngelesParts(ms);
  return losAngelesMidnight({ year: date.year, month: date.month, day: 1 });
}

/** The next month start in `America/Los_Angeles` after `ms` (Section 7). */
function nextLosAngelesMonthStart(ms: number): number {
  const date = losAngelesParts(ms);
  const next = new Date(Date.UTC(date.year, date.month, 1));
  return losAngelesMidnight({
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: 1,
  });
}

/** The hex SHA-256 digest of a string (Section 3). */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The store key of the metric types of a cloud project (Section 5). */
function metricTypesKey(project: string): string {
  return `google-metric-types:${sha256Hex(project)}`;
}

/** The store key of the quota metadata of a cloud project (Section 4). */
function metadataKey(project: string): string {
  return `google-quota-metadata:${sha256Hex(project)}`;
}

/** Records the first failed request or command of the run. */
function record(tally: Tally, failure?: AdapterFailure): void {
  if (failure !== undefined && tally.firstFailure === undefined) tally.firstFailure = failure;
}

/**
 * One `GET` with the access token (Sections 2, 4). The transport has already mapped the
 * status; `status` stays inside the adapter, and response text and other headers never leave
 * it (adapter-contract.md Section 4).
 */
async function requestJson(
  context: RunContext,
  url: string,
  bodyCap: number,
): Promise<RequestOutcome> {
  const outcome = await context.deps.transport({
    url,
    headers: { authorization: `Bearer ${context.token}` },
    bodyCap,
    signal: context.signal,
  });
  if ("reason" in outcome) {
    const failure: AdapterFailure = { reason: outcome.reason };
    if (outcome.retryAfter !== undefined) failure.retryAfter = outcome.retryAfter;
    record(context.tally, failure);
    return { ok: false, failure, status: outcome.status };
  }
  try {
    const body: unknown = JSON.parse(outcome.body);
    record(context.tally);
    return { ok: true, body };
  } catch {
    const failure: AdapterFailure = { reason: "bad-response" };
    record(context.tally, failure);
    return { ok: false, failure, status: undefined };
  }
}

/**
 * One paged `GET`: the body of each page, following `nextPageToken` as `pageToken` for at
 * most 5 pages (Section 1). A failed page fails the request.
 */
async function requestPages(
  context: RunContext,
  url: URL,
  bodyCap: number,
): Promise<{ ok: true; bodies: unknown[] } | { ok: false; failure: AdapterFailure }> {
  const bodies: unknown[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const target = new URL(url);
    if (pageToken !== null) target.searchParams.set("pageToken", pageToken);
    const outcome = await requestJson(context, target.toString(), bodyCap);
    if (!outcome.ok) return { ok: false, failure: outcome.failure };
    bodies.push(outcome.body);
    const next = stringAt(asRecord(outcome.body) ?? {}, "nextPageToken");
    if (next === null || next === "") break;
    pageToken = next;
  }
  return { ok: true, bodies };
}

/** Section 2: the access token, or the whole failure the command's outcome maps to. */
async function readAccessToken(
  commandRunner: CommandRunner,
  signal: AbortSignal,
  tally: Tally,
): Promise<StepResult<string>> {
  const outcome = await commandRunner({
    command: GCLOUD_COMMAND,
    args: GCLOUD_ARGS,
    deadlineMs: GCLOUD_DEADLINE_MS,
    outputCap: GCLOUD_OUTPUT_CAP,
    signal,
  });
  if ("reason" in outcome) {
    const failure: AdapterFailure = { reason: outcome.reason };
    record(tally, failure);
    return { ok: false, failure };
  }
  if (outcome.code !== 0) {
    const failure: AdapterFailure = {
      reason: outcome.stderr.includes("ENOENT")
        ? "gcloud-missing"
        : outcome.stderr.includes("gcloud auth login")
          ? "gcloud-unauthenticated"
          : "gcloud-failed",
    };
    record(tally, failure);
    return { ok: false, failure };
  }
  const token = outcome.stdout.trim();
  if (!ACCESS_TOKEN_PATTERN.test(token)) {
    const failure: AdapterFailure = { reason: "gcloud-failed" };
    record(tally, failure);
    return { ok: false, failure };
  }
  record(tally);
  return { ok: true, value: token };
}

/**
 * Section 3: the `project` configuration, else the store item keyed by the API key's digest,
 * else `keys:lookupKey`.
 */
async function resolveProject(context: RunContext): Promise<StepResult<string>> {
  const configured = context.deps.configuration.project;
  if (typeof configured === "string" && configured.trim() !== "") {
    return { ok: true, value: configured.trim() };
  }

  const key = sha256Hex(context.apiKey);
  const stored = context.deps.store.get(key);
  if (typeof stored === "string" && PROJECT_PATTERN.test(stored))
    return { ok: true, value: stored };

  const url = new URL(`${API_KEYS_ORIGIN}/v2/keys:lookupKey`);
  url.searchParams.set("keyString", context.apiKey);
  const outcome = await requestJson(context, url.toString(), API_KEYS_BODY_CAP);
  if (!outcome.ok) {
    if (outcome.failure.reason === "http-403" || outcome.status === 404) {
      return { ok: false, failure: { reason: "project-unresolved" } };
    }
    return { ok: false, failure: outcome.failure };
  }
  const parent = stringAt(asRecord(outcome.body) ?? {}, "parent");
  const match = parent === null ? null : PROJECT_PARENT_PATTERN.exec(parent);
  const project = match?.[1];
  if (project === undefined || !PROJECT_PATTERN.test(project)) {
    return { ok: false, failure: { reason: "project-unresolved" } };
  }
  context.deps.store.set(key, project);
  return { ok: true, value: project };
}

/**
 * Section 4: the quota metadata, or `null` when absent. The result is cached for 86400
 * seconds; a failure is not a whole failure.
 */
async function readQuotaMetadata(
  context: RunContext,
  project: string,
): Promise<QuotaMetadata | null> {
  const key = metadataKey(project);
  const cached = context.deps.store.get(key);
  if (cached !== undefined) {
    const metadata = storedMetadata(cached);
    if (metadata !== null) return metadata;
  }

  const url = new URL(
    `${CLOUD_QUOTAS_ORIGIN}/v1/projects/${encodeURIComponent(project)}/locations/global/services/${QUOTA_SERVICE}/quotaInfos`,
  );
  url.searchParams.set("pageSize", String(QUOTA_INFOS_PAGE_SIZE));
  const outcome = await requestPages(context, url, DEFAULT_BODY_CAP);
  if (!outcome.ok) return null;

  const metadata = new Map<string, string | null>();
  for (const body of outcome.bodies) {
    for (const entry of arrayAt(body, "quotaInfos")) {
      const object = asRecord(entry);
      if (object === null) continue;
      const quotaId = stringAt(object, "quotaId");
      if (quotaId === null) continue;
      metadata.set(quotaId, stringAt(object, "refreshInterval"));
    }
  }
  context.deps.store.set(key, Object.fromEntries(metadata), METADATA_TTL_SECONDS);
  return metadata;
}

/** The quota metadata a store item holds, or `null` when the item has an unexpected shape. */
function storedMetadata(value: unknown): QuotaMetadata | null {
  const object = asRecord(value);
  if (object === null) return null;
  const metadata = new Map<string, string | null>();
  for (const [quotaId, refreshInterval] of Object.entries(object)) {
    metadata.set(quotaId, typeof refreshInterval === "string" ? refreshInterval : null);
  }
  return metadata;
}

/** A label from `metric.labels` (Section 5). */
function metricLabel(item: Record<string, unknown>, name: string): string | null {
  const labels = asRecord(asRecord(item["metric"])?.["labels"]);
  return labels === null ? null : stringAt(labels, name);
}

/** The finite value of one Monitoring point, else `null` (Section 5). */
function pointValue(point: unknown): number | null {
  const object = asRecord(point);
  if (object === null) return null;
  const value = asRecord(object["value"]);
  if (value === null) return null;
  const int64 = stringAt(value, "int64Value");
  if (int64 !== null && /^-?\d+$/.test(int64)) {
    const parsed = Number(int64);
    if (Number.isFinite(parsed)) return parsed;
  }
  return finiteNumber(value["doubleValue"]);
}

/** The labels of one series, cleaned for output (Section 5, billing-state.md Section 7). */
function seriesLabels(item: Record<string, unknown>): SeriesLabels {
  const rawQuotaId = metricLabel(item, "limit_name");
  const rawModel = metricLabel(item, "model");
  return {
    quotaId: cleanVendorString(rawQuotaId),
    rawQuotaId,
    model: cleanVendorString(rawModel),
    rawModel,
  };
}

/** Section 5: the metric types, from the store or the metric descriptors. */
async function readMetricTypes(
  context: RunContext,
  project: string,
): Promise<StepResult<readonly string[]>> {
  const key = metricTypesKey(project);
  const cached = context.deps.store.get(key);
  if (Array.isArray(cached) && cached.every((entry) => typeof entry === "string")) {
    return { ok: true, value: cached };
  }

  const url = new URL(
    `${MONITORING_ORIGIN}/v3/projects/${encodeURIComponent(project)}/metricDescriptors`,
  );
  url.searchParams.set("filter", DESCRIPTOR_FILTER);
  url.searchParams.set("pageSize", String(DESCRIPTOR_PAGE_SIZE));
  const outcome = await requestPages(context, url, DEFAULT_BODY_CAP);
  if (!outcome.ok) return { ok: false, failure: outcome.failure };
  const types: string[] = [];
  for (const body of outcome.bodies) {
    for (const entry of arrayAt(body, "metricDescriptors")) {
      const type = stringAt(asRecord(entry) ?? {}, "type");
      if (type !== null) types.push(type);
    }
  }
  context.deps.store.set(key, types, METADATA_TTL_SECONDS);
  return { ok: true, value: types };
}

/** The family of a limit type, else `null` (Section 5). */
function limitFamily(type: string): string | null {
  if (!type.startsWith(QUOTA_METRIC_PREFIX) || !type.endsWith(LIMIT_SUFFIX)) return null;
  const family = type.slice(QUOTA_METRIC_PREFIX.length, type.length - LIMIT_SUFFIX.length);
  return family === "" ? null : family;
}

/** The time-series request URL of one metric type (Sections 5–6). */
function timeSeriesUrl(
  project: string,
  type: string,
  startMs: number,
  endMs: number,
  alignmentPeriod: string,
  aligner: string,
): URL {
  const url = new URL(`${MONITORING_ORIGIN}/v3/projects/${encodeURIComponent(project)}/timeSeries`);
  url.searchParams.set("filter", `metric.type = "${type}"`);
  url.searchParams.set("interval.startTime", rfc3339(startMs));
  url.searchParams.set("interval.endTime", rfc3339(endMs));
  url.searchParams.set("aggregation.alignmentPeriod", alignmentPeriod);
  url.searchParams.set("aggregation.perSeriesAligner", aligner);
  return url;
}

/**
 * Section 5: the valid series of one limit type's request, or its failure. A series needs a
 * quota id and a finite value.
 */
async function readLimitSeries(
  context: RunContext,
  project: string,
  type: string,
  family: string,
): Promise<StepResult<QuotaSeries[]>> {
  const url = timeSeriesUrl(
    project,
    type,
    context.now - LIMIT_LOOKBACK_MS,
    context.now,
    LIMIT_ALIGNMENT_PERIOD,
    LIMIT_ALIGNER,
  );
  const outcome = await requestPages(context, url, DEFAULT_BODY_CAP);
  if (!outcome.ok) return { ok: false, failure: outcome.failure };
  const series: QuotaSeries[] = [];
  for (const body of outcome.bodies) {
    for (const entry of arrayAt(body, "timeSeries")) {
      const item = asRecord(entry);
      if (item === null) continue;
      const labels = seriesLabels(item);
      if (labels.quotaId === null) continue;
      const points = item["points"];
      const value = Array.isArray(points) ? pointValue(points[0]) : null;
      if (value === null) continue;
      series.push({ family, value, ...labels });
    }
  }
  return { ok: true, value: series };
}

/**
 * Section 5: the usage tier, from the families of the series that survived the value check.
 */
function usageTier(series: readonly QuotaSeries[]): string {
  const families = series.map((entry) => entry.family);
  if (families.some((family) => family.includes("paid_tier_3"))) return PAID_TIER_3;
  if (families.some((family) => family.includes("paid_tier_2"))) return PAID_TIER_2;
  if (families.some((family) => !family.includes("free_tier"))) return PAID_TIER_1;
  return FREE_TIER;
}

/** Section 4: the interval a quota id resets in. */
function quotaInterval(quotaId: string, metadata: QuotaMetadata | null): QuotaInterval {
  if (metadata !== null && metadata.has(quotaId)) {
    const refreshInterval = metadata.get(quotaId);
    if (refreshInterval === "day") return "day";
    if (refreshInterval === "minute") return "minute";
    return null;
  }
  if (quotaId.includes("PerDay")) return "day";
  if (quotaId.includes("PerMinute")) return "minute";
  return null;
}

/** The last part of a window's `label` (Section 5). */
function intervalLabel(interval: QuotaInterval): "day" | "min" | "?" {
  if (interval === "day") return "day";
  if (interval === "minute") return "min";
  return "?";
}

/** A window's `windowSeconds` (Section 5). */
function windowSeconds(interval: QuotaInterval): number | null {
  if (interval === "day") return DAY_SECONDS;
  if (interval === "minute") return MINUTE_SECONDS;
  return null;
}

/** The key that pairs a usage series with a day window of its family (Section 6). */
function usageKey(quotaId: string, model: string | null): string {
  return JSON.stringify([quotaId, model]);
}

/**
 * Section 5: one window per remaining series with a value other than `-1`, and the `day`
 * windows that need their `used` from Section 6.
 */
function buildWindows(
  series: readonly QuotaSeries[],
  tier: string,
  metadata: QuotaMetadata | null,
  now: number,
): { windows: LimitWindowCapture[]; dayWindows: DayWindow[] } {
  const free = tier === FREE_TIER;
  const windows: LimitWindowCapture[] = [];
  const dayWindows: DayWindow[] = [];
  const seen = new Set<string>();
  for (const entry of series) {
    if (entry.family.includes("free_tier") !== free) continue;
    if (entry.value === UNLIMITED) continue;
    const quotaId = entry.quotaId;
    const rawQuotaId = entry.rawQuotaId;
    if (quotaId === null || rawQuotaId === null) continue;
    const id = entry.model === null ? quotaId : `${quotaId}:${entry.model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const interval = quotaInterval(quotaId, metadata);
    const tokens = entry.family.includes("token");
    const window: LimitWindowCapture = {
      id,
      label: `${entry.model ?? "all"} ${tokens ? "tok" : "req"}/${intervalLabel(interval)}`,
      unit: tokens ? "tokens" : "requests",
      used: null,
      limit: entry.value,
      percent: null,
      resetsAt: interval === "day" ? nextLosAngelesMidnight(now) : null,
      windowSeconds: windowSeconds(interval),
      models: entry.model === null ? null : [entry.model],
      source: "endpoint",
    };
    windows.push(window);
    if (interval === "day") {
      dayWindows.push({ window, family: entry.family, rawQuotaId, rawModel: entry.rawModel });
    }
  }
  return { windows, dayWindows };
}

/**
 * Section 6: one request per family; fills each of the family's `day` windows' `used` with the
 * sum of its matching series' finite point values, `0` when the request succeeded without one.
 * A failure is not a whole failure.
 */
async function fillDailyUsage(
  context: RunContext,
  project: string,
  families: ReadonlyMap<string, DayWindow[]>,
): Promise<void> {
  const start = latestLosAngelesMidnight(context.now);
  const alignmentSeconds = Math.max(
    MIN_USAGE_ALIGNMENT_SECONDS,
    Math.floor((context.now - start) / 1000),
  );
  await Promise.all(
    [...families].map(async ([family, windows]) => {
      const url = timeSeriesUrl(
        project,
        `${QUOTA_METRIC_PREFIX}${family}/usage`,
        start,
        context.now,
        `${alignmentSeconds}s`,
        USAGE_ALIGNER,
      );
      const outcome = await requestPages(context, url, DEFAULT_BODY_CAP);
      if (!outcome.ok) return;
      const used = new Map<string, number>();
      for (const body of outcome.bodies) {
        for (const entry of arrayAt(body, "timeSeries")) {
          const item = asRecord(entry);
          if (item === null) continue;
          const labels = seriesLabels(item);
          if (labels.rawQuotaId === null) continue;
          const points = item["points"];
          if (!Array.isArray(points)) continue;
          let total = 0;
          for (const point of points) total += pointValue(point) ?? 0;
          const key = usageKey(labels.rawQuotaId, labels.rawModel);
          used.set(key, (used.get(key) ?? 0) + total);
        }
      }
      for (const entry of windows) {
        entry.window.used = used.get(usageKey(entry.rawQuotaId, entry.rawModel)) ?? 0;
      }
    }),
  );
}

/** The family of an input-token usage type of a paid tier, else `null` (Section 7). */
function spendInputFamily(type: string): string | null {
  if (!type.startsWith(QUOTA_METRIC_PREFIX) || !type.endsWith(USAGE_SUFFIX)) return null;
  const family = type.slice(QUOTA_METRIC_PREFIX.length, type.length - USAGE_SUFFIX.length);
  return family.includes(INPUT_TOKEN_FAMILY) && !family.includes("free_tier") ? family : null;
}

/**
 * Section 7: the series totals of one month-to-date request as `[quota id, model, total]`, or
 * `null` when the request failed. A series without a model is skipped.
 */
async function readMonthTotals(
  context: RunContext,
  project: string,
  type: string,
): Promise<[string | null, string, number][] | null> {
  const start = latestLosAngelesMonthStart(context.now);
  const alignmentSeconds = Math.max(
    MIN_USAGE_ALIGNMENT_SECONDS,
    Math.floor((context.now - start) / 1000),
  );
  const url = timeSeriesUrl(
    project,
    type,
    start,
    context.now,
    `${alignmentSeconds}s`,
    USAGE_ALIGNER,
  );
  const outcome = await requestPages(context, url, DEFAULT_BODY_CAP);
  if (!outcome.ok) return null;
  const totals: [string | null, string, number][] = [];
  for (const body of outcome.bodies) {
    for (const entry of arrayAt(body, "timeSeries")) {
      const item = asRecord(entry);
      if (item === null) continue;
      const labels = seriesLabels(item);
      if (labels.rawModel === null) continue;
      const points = item["points"];
      if (!Array.isArray(points)) continue;
      let total = 0;
      for (const point of points) total += pointValue(point) ?? 0;
      totals.push([labels.rawQuotaId, labels.rawModel, total]);
    }
  }
  return totals;
}

/**
 * Section 7: the estimated spend window of a paid tier. `used` is `null` when a request
 * failed, a token-bearing model is outside the inventory, or a token-bearing rate is
 * unknown; a failure is not a whole failure.
 */
async function spendWindow(
  context: RunContext,
  project: string,
  tier: string,
  metricTypes: readonly string[],
): Promise<LimitWindowCapture> {
  const inputTypes = [...new Set(metricTypes)].filter((type) => spendInputFamily(type) !== null);
  const [output, ...inputs] = await Promise.all(
    [OUTPUT_TOKEN_TYPE, ...inputTypes].map((type) => readMonthTotals(context, project, type)),
  );

  let used: number | null = null;
  if (output !== undefined && output !== null && inputs.every((entry) => entry !== null)) {
    const inputTokens = new Map<string, number>();
    for (const family of inputs) {
      // Quota ids of one family repeat a model's total: the greatest counts once.
      const greatest = new Map<string, Map<string | null, number>>();
      for (const [quotaId, model, total] of family ?? []) {
        const byQuota = greatest.get(model) ?? new Map<string | null, number>();
        byQuota.set(quotaId, (byQuota.get(quotaId) ?? 0) + total);
        greatest.set(model, byQuota);
      }
      for (const [model, byQuota] of greatest) {
        inputTokens.set(model, (inputTokens.get(model) ?? 0) + Math.max(...byQuota.values()));
      }
    }
    const outputTokens = new Map<string, number>();
    for (const [, model, total] of output) {
      outputTokens.set(model, (outputTokens.get(model) ?? 0) + total);
    }
    let spend = 0;
    let known = true;
    const priced = new Set<string>();
    for (const model of context.deps.inventory) {
      if (priced.has(model.id)) continue;
      priced.add(model.id);
      const { rates } = derivePrice(model, {
        provider: google.id,
        settings: context.deps.configuration,
        now: context.now,
      });
      const inputCount = inputTokens.get(model.id) ?? 0;
      const outputCount = outputTokens.get(model.id) ?? 0;
      if (inputCount > 0 && rates.input === null) known = false;
      if (outputCount > 0 && rates.output === null) known = false;
      spend +=
        (inputCount * (rates.input ?? 0) + outputCount * (rates.output ?? 0)) / TOKENS_PER_RATE;
    }
    const withTokens = new Set<string>();
    for (const [model, total] of inputTokens) if (total > 0) withTokens.add(model);
    for (const [model, total] of outputTokens) if (total > 0) withTokens.add(model);
    for (const model of withTokens) if (!priced.has(model)) known = false;
    used = !known || !Number.isFinite(spend) ? null : Math.round(spend * 100) / 100;
  }

  return {
    id: SPEND_ID,
    label: SPEND_LABEL,
    unit: "currency",
    currency: SPEND_CURRENCY,
    used,
    limit: SPEND_CAPS[tier] ?? null,
    percent: null,
    resetsAt: nextLosAngelesMonthStart(context.now),
    windowSeconds: null,
    models: null,
    source: "endpoint",
    // Display only: the estimate counts toward no severity and stays off the status line.
    severity: "unknown",
  };
}

/** A successful run's result (adapter-contract.md Section 2). */
function successResult(tally: Tally, facets: CaptureFacets): AdapterResult {
  return {
    facets,
    ...(tally.firstFailure === undefined ? {} : { firstFailure: tally.firstFailure }),
  };
}

/** A facet that is `unavailable` with the spec's reason (Section 5). */
function unavailable(reason: "empty-response"): Facet<never> {
  return { state: "unavailable", reason };
}

/** Sections 2–7, in order. */
async function runRefresh(deps: AdapterDependencies, signal: AbortSignal): Promise<AdapterResult> {
  const now = deps.clock();
  // adapter-contract.md Section 3 checks ran before `run`.
  const credentials = await deps.credentials();
  if (credentials === undefined) return { reason: "no-credentials" };
  const apiKey = credentials.apiKey;

  const tally: Tally = { firstFailure: undefined };
  const token = await readAccessToken(deps.commandRunner, signal, tally);
  if (!token.ok) return token.failure;

  const context: RunContext = { deps, signal, apiKey, token: token.value, now, tally };

  const project = await resolveProject(context);
  if (!project.ok) return project.failure;

  const metadata = await readQuotaMetadata(context, project.value);
  const metricTypes = await readMetricTypes(context, project.value);
  if (!metricTypes.ok) return metricTypes.failure;

  // Ascending by UTF-16 code units, each type once (Section 5).
  const limitTypes: [string, string][] = [];
  for (const type of [...new Set(metricTypes.value)].toSorted()) {
    const family = limitFamily(type);
    if (family !== null) limitTypes.push([type, family]);
  }
  const results = await Promise.all(
    limitTypes.map(([type, family]) => readLimitSeries(context, project.value, type, family)),
  );
  const allSeries: QuotaSeries[] = [];
  for (const result of results) {
    if (!result.ok) return result.failure;
    allSeries.push(...result.value);
  }

  const emptyPlan = unavailable("empty-response");
  if (allSeries.length === 0) {
    return successResult(tally, { plan: emptyPlan, limits: emptyPlan });
  }

  const tier = usageTier(allSeries);
  const { windows, dayWindows } = buildWindows(allSeries, tier, metadata, now);
  if (windows.length === 0) {
    return successResult(tally, {
      plan: { state: "known", value: tier },
      limits: unavailable("empty-response"),
    });
  }

  const typeSet = new Set(metricTypes.value);
  const usageFamilies = new Map<string, DayWindow[]>();
  for (const entry of dayWindows) {
    if (!typeSet.has(`${QUOTA_METRIC_PREFIX}${entry.family}/usage`)) continue;
    const group = usageFamilies.get(entry.family);
    if (group === undefined) usageFamilies.set(entry.family, [entry]);
    else group.push(entry);
  }
  if (usageFamilies.size > 0) await fillDailyUsage(context, project.value, usageFamilies);
  if (tier !== FREE_TIER) {
    windows.push(await spendWindow(context, project.value, tier, metricTypes.value));
  }
  return successResult(tally, {
    plan: { state: "known", value: tier },
    limits: { state: "known", value: windows },
  });
}

/**
 * The Google adapter (Section 1): Gemini API key limits and usage tier through Google Cloud
 * APIs, authorized by a `gcloud` access token. The transport and the command runner are the
 * only ways out; an unexpected exception is a whole failure with `internal`.
 */
export const google: Adapter = {
  id: "google",
  providerOrigin: PROVIDER_ORIGIN,
  hostAllowlist: HOST_ALLOWLIST,
  exposedFacets: ["plan", "limits"],
  freshnessSeconds: FRESHNESS_SECONDS,
  async run(deps: AdapterDependencies, signal: AbortSignal): Promise<AdapterResult> {
    try {
      return await runRefresh(deps, signal);
    } catch {
      return { reason: "internal" };
    }
  },
};
