/**
 * Configuration file and environment per specs/config-file.md: `~/.pi/purse/purse.conf`, its
 * JSONC keys, and the `PURSE_CONF` and `PURSE_OFFLINE` environment variables.
 *
 * `parseConfiguration` is pure: file text, path, and environment values in; the loaded
 * configuration and its diagnostics out. `loadConfiguration` adds the one effect, reading the
 * file, through an injectable reader so tests need no home directory. The caller keeps the
 * result as the boot window's image; the file is read once there (Section 1).
 *
 * Not fixed by the spec: the shape of a diagnostic and the message texts; here a diagnostic
 * carries the file path and the key path it names (Section 4), and its `message` is
 * `"<file>: <key path>: <problem>"`, ready to be reported as `purse: <message>`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  parse as parseJsonc,
  printParseErrorCode,
  stripComments,
  type ParseError,
} from "jsonc-parser";

import type { ProviderConfiguration } from "./adapter.ts";

import {
  DEFAULT_SEVERITY_THRESHOLDS,
  type Rates,
  type Schedule,
  type ScheduleWindow,
  type SeverityThresholds,
} from "./state.ts";

/** One rate field's override: a number ≥ 0, or `null` for unknown (Section 2, prices.md Section 2). */
export type RateOverrides = { [Field in keyof Rates]?: number | null };

/** A price schedule without its computed fields (Section 2, prices.md Section 3). */
export type ScheduleConfig = Omit<Schedule, "active" | "changesAt">;

/**
 * One provider's configuration entry (Section 2): the adapter's `ProviderConfiguration`
 * (entry-derivation settings plus `project`) and the price keys.
 */
export interface ProviderConfig extends ProviderConfiguration {
  /** Rate overrides keyed by model id (prices.md Section 2). */
  prices?: Record<string, RateOverrides>;
  /** The price schedule, or `null` to disable the built-in one (prices.md Section 3). */
  schedule?: ScheduleConfig | null;
}

/** A problem reported to the user about the configuration file or environment (Section 4). */
export interface Diagnostic {
  /** The path the diagnostic names: the configuration file, or the offending `PURSE_CONF` value. */
  file: string;
  /** The key path it names, e.g. `providers.zai.ttlSeconds`; `""` when there is no key. */
  keyPath: string;
  /** The message, reported as `purse: <message>` (Section 4). */
  message: string;
}

/** The environment values configuration reads (Section 3). */
export interface ConfigurationEnv {
  PURSE_CONF?: string | undefined;
  PURSE_OFFLINE?: string | undefined;
}

/** The configuration file's path, with any diagnostic about `PURSE_CONF` (Sections 1, 3). */
export interface ConfigurationLocation {
  path: string;
  diagnostics: Diagnostic[];
}

/** The configuration loaded for a boot window (Sections 1–3). */
export interface LoadedConfiguration {
  /** The file the values came from; read once per boot window (Section 1). */
  path: string;
  /** Per-provider settings; `{}` when absent (Section 2). */
  providers: Record<string, ProviderConfig>;
  /** Percent thresholds; the defaults when absent or invalid (Section 2). */
  severity: SeverityThresholds;
  /** Whether the status line is enabled (Section 2). */
  statusLine: boolean;
  /** `PURSE_OFFLINE` is `1`: refreshes are disabled (Section 3, refresh.md Section 3). */
  offline: boolean;
  /** One per problem, in the order found (Sections 2, 4). */
  diagnostics: Diagnostic[];
}

/** What `loadConfiguration` needs; every field has a production default. */
export interface ConfigurationDependencies {
  env?: ConfigurationEnv;
  homeDir?: string;
  /** Returns the file's text, or `null` when it does not exist; throws on another failure. */
  readFile?: (path: string) => string | null;
}

/** The configuration file's path below the home directory (Section 1). */
const CONFIG_FILE_SEGMENTS: readonly string[] = [".pi", "purse", "purse.conf"];

/** `ttlSeconds` bounds (Section 2). */
const TTL_SECONDS_MIN = 60;
const TTL_SECONDS_MAX = 86400;

/** `statusLine`'s default (Section 2). */
const DEFAULT_STATUS_LINE = true;

/** The provider-id pattern (query-protocol.md Section 2). */
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

/** Root keys (Section 2). */
const ROOT_KEYS: readonly string[] = ["providers", "severity", "statusLine"];

/** Provider keys (Section 2); `project` is allowed on `google` only. */
const PROVIDER_KEYS: readonly string[] = [
  "free",
  "adapter",
  "ttlSeconds",
  "lowBalance",
  "prices",
  "schedule",
];

/** Provider keys that are ignored, each with a diagnostic, on a free provider (Section 2). */
const FREE_IGNORED_KEYS: readonly string[] = [
  "adapter",
  "ttlSeconds",
  "lowBalance",
  "prices",
  "schedule",
  "project",
];

/** A cloud project id or number (Section 2, `project`). */
const PROJECT = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,20})$/;

/** Rate fields of a `prices` entry (Section 2). */
const RATE_KEYS: readonly (keyof Rates)[] = ["input", "output", "cacheRead", "cacheWrite"];

/** Schedule keys (Section 2). */
const SCHEDULE_KEYS: readonly string[] = ["multiplier", "timeZone", "windows"];

/** Schedule window keys (prices.md Section 3). */
const WINDOW_KEYS: readonly string[] = ["days", "from", "to"];

/** Severity keys (Section 2). */
const SEVERITY_KEYS: readonly string[] = ["low", "critical"];

/** `from` of a schedule window: `HH:MM`, 00:00–23:59 (prices.md Section 3). */
const FROM_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `to` of a schedule window: `HH:MM` up to `24:00` (prices.md Section 3). */
const TO_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function joinPath(base: string, key: string): string {
  return base === "" ? key : `${base}.${key}`;
}

function diagnostic(file: string, keyPath: string, problem: string): Diagnostic {
  const where = keyPath === "" ? file : `${file}: ${keyPath}`;
  return { file, keyPath, message: `${where}: ${problem}` };
}

/** Report one diagnostic per key not in `allowed` (Section 2: unknown keys). */
function reportUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  keyPath: string,
  file: string,
  diagnostics: Diagnostic[],
): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    diagnostics.push(diagnostic(file, joinPath(keyPath, key), "unknown key"));
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isDays(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every(
      (day: unknown) => typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6,
    )
  );
}

function isTimeZone(value: string): boolean {
  if (value === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Minutes after local midnight of an `HH:MM` time, or `null` when it is not one. */
function localTimeMinutes(value: string, allowEnd: boolean): number | null {
  if (!(allowEnd ? TO_TIME : FROM_TIME).test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

/** One `prices` entry's overrides (Section 2); violated fields are omitted. */
function parseRateOverrides(
  value: unknown,
  keyPath: string,
  file: string,
  diagnostics: Diagnostic[],
): RateOverrides | null {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic(file, keyPath, "expected an object"));
    return null;
  }
  reportUnknownKeys(value, RATE_KEYS, keyPath, file, diagnostics);

  const overrides: RateOverrides = {};
  for (const field of RATE_KEYS) {
    if (!has(value, field)) continue;
    const rate = value[field];
    if (rate === null) {
      overrides[field] = null;
    } else if (isFiniteNumber(rate) && rate >= 0) {
      overrides[field] = rate;
    } else {
      diagnostics.push(diagnostic(file, joinPath(keyPath, field), "expected a number ≥ 0 or null"));
    }
  }
  return overrides;
}

/** `prices`: overrides keyed by model id (Section 2). */
function parsePrices(
  value: unknown,
  keyPath: string,
  file: string,
  diagnostics: Diagnostic[],
): Record<string, RateOverrides> | undefined {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic(file, keyPath, "expected an object"));
    return undefined;
  }
  const prices: Record<string, RateOverrides> = {};
  for (const modelId of Object.keys(value)) {
    const overrides = parseRateOverrides(
      value[modelId],
      joinPath(keyPath, modelId),
      file,
      diagnostics,
    );
    if (overrides !== null) prices[modelId] = overrides;
  }
  return prices;
}

/** One schedule window (prices.md Section 3); `null` when it violates its contract. */
function parseScheduleWindow(
  value: unknown,
  keyPath: string,
  file: string,
  diagnostics: Diagnostic[],
): ScheduleWindow | null {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic(file, keyPath, "expected an object"));
    return null;
  }
  reportUnknownKeys(value, WINDOW_KEYS, keyPath, file, diagnostics);

  let valid = true;

  const days = isDays(value.days) ? [...value.days] : null;
  if (days === null) {
    diagnostics.push(
      diagnostic(file, joinPath(keyPath, "days"), "expected an array of integers from 0 to 6"),
    );
    valid = false;
  }

  const fromText = value.from;
  const fromMinutes = typeof fromText === "string" ? localTimeMinutes(fromText, false) : null;
  if (fromMinutes === null) {
    diagnostics.push(diagnostic(file, joinPath(keyPath, "from"), "expected a local time HH:MM"));
    valid = false;
  }

  const toText = value.to;
  const toMinutes = typeof toText === "string" ? localTimeMinutes(toText, true) : null;
  if (toMinutes === null) {
    diagnostics.push(
      diagnostic(file, joinPath(keyPath, "to"), "expected a local time HH:MM up to 24:00"),
    );
    valid = false;
  }

  if (fromMinutes !== null && toMinutes !== null && fromMinutes >= toMinutes) {
    diagnostics.push(
      diagnostic(file, joinPath(keyPath, "from"), "expected a time earlier than `to`"),
    );
    valid = false;
  }

  if (!valid || days === null || typeof fromText !== "string" || typeof toText !== "string") {
    return null;
  }
  return { days, from: fromText, to: toText };
}

/** `schedule` (Section 2): its value, `null` for a disabled schedule, `undefined` when invalid. */
function parseSchedule(
  value: unknown,
  keyPath: string,
  file: string,
  diagnostics: Diagnostic[],
): ScheduleConfig | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) {
    diagnostics.push(diagnostic(file, keyPath, "expected an object or null"));
    return undefined;
  }
  reportUnknownKeys(value, SCHEDULE_KEYS, keyPath, file, diagnostics);

  let valid = true;

  const multiplier = value.multiplier;
  if (!isFiniteNumber(multiplier) || multiplier <= 0) {
    diagnostics.push(
      diagnostic(file, joinPath(keyPath, "multiplier"), "expected a number greater than 0"),
    );
    valid = false;
  }

  const timeZone = value.timeZone;
  if (typeof timeZone !== "string" || !isTimeZone(timeZone)) {
    diagnostics.push(
      diagnostic(file, joinPath(keyPath, "timeZone"), "expected an IANA time zone name"),
    );
    valid = false;
  }

  const windows: ScheduleWindow[] = [];
  const rawWindows = value.windows;
  if (Array.isArray(rawWindows)) {
    for (const [index, rawWindow] of rawWindows.entries()) {
      const window = parseScheduleWindow(
        rawWindow,
        `${joinPath(keyPath, "windows")}[${index}]`,
        file,
        diagnostics,
      );
      if (window === null) valid = false;
      else windows.push(window);
    }
  } else {
    diagnostics.push(diagnostic(file, joinPath(keyPath, "windows"), "expected an array"));
    valid = false;
  }

  if (!valid || !isFiniteNumber(multiplier) || typeof timeZone !== "string") return undefined;
  return { multiplier, timeZone, windows };
}

/** One provider's entry (Section 2); violated keys are omitted, a non-object entry is `null`. */
function parseProvider(
  value: unknown,
  providerId: string,
  file: string,
  diagnostics: Diagnostic[],
): ProviderConfig | null {
  const keyPath = `providers.${providerId}`;
  if (!isRecord(value)) {
    diagnostics.push(diagnostic(file, keyPath, "expected an object"));
    return null;
  }

  const allowed = providerId === "google" ? [...PROVIDER_KEYS, "project"] : PROVIDER_KEYS;
  reportUnknownKeys(value, allowed, keyPath, file, diagnostics);

  const free = value.free === true;
  if (has(value, "free") && typeof value.free !== "boolean") {
    diagnostics.push(diagnostic(file, joinPath(keyPath, "free"), "expected a boolean"));
  }

  // Free takes precedence over the adapter and its settings, each with one diagnostic.
  if (free) {
    for (const key of FREE_IGNORED_KEYS) {
      if (!allowed.includes(key) || !has(value, key)) continue;
      diagnostics.push(diagnostic(file, joinPath(keyPath, key), "ignored on a free provider"));
    }
    return { free: true };
  }

  const config: ProviderConfig = {};

  if (value.free === false) config.free = false;

  if (has(value, "adapter")) {
    if (typeof value.adapter === "boolean") config.adapter = value.adapter;
    else diagnostics.push(diagnostic(file, joinPath(keyPath, "adapter"), "expected a boolean"));
  }

  if (has(value, "ttlSeconds")) {
    const ttl = value.ttlSeconds;
    if (
      typeof ttl === "number" &&
      Number.isInteger(ttl) &&
      ttl >= TTL_SECONDS_MIN &&
      ttl <= TTL_SECONDS_MAX
    ) {
      config.ttlSeconds = ttl;
    } else {
      diagnostics.push(
        diagnostic(file, joinPath(keyPath, "ttlSeconds"), "expected an integer from 60 to 86400"),
      );
    }
  }

  if (has(value, "lowBalance")) {
    const lowBalance = value.lowBalance;
    if (isFiniteNumber(lowBalance) && lowBalance >= 0) config.lowBalance = lowBalance;
    else {
      diagnostics.push(
        diagnostic(file, joinPath(keyPath, "lowBalance"), "expected a number of at least 0"),
      );
    }
  }

  if (has(value, "prices")) {
    const prices = parsePrices(value.prices, joinPath(keyPath, "prices"), file, diagnostics);
    if (prices !== undefined) config.prices = prices;
  }

  if (has(value, "schedule")) {
    const schedule = parseSchedule(
      value.schedule,
      joinPath(keyPath, "schedule"),
      file,
      diagnostics,
    );
    if (schedule !== undefined) config.schedule = schedule;
  }

  // On another provider `project` is an unknown key: reported above, never loaded.
  if (providerId === "google" && has(value, "project")) {
    const project = value.project;
    if (typeof project === "string" && PROJECT.test(project)) config.project = project;
    else {
      diagnostics.push(
        diagnostic(file, joinPath(keyPath, "project"), "expected a cloud project id or number"),
      );
    }
  }

  return config;
}

/** `providers` (Section 2); entries with an invalid provider id are ignored. */
function parseProviders(
  value: unknown,
  file: string,
  diagnostics: Diagnostic[],
): Record<string, ProviderConfig> {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic(file, "providers", "expected an object"));
    return {};
  }
  const providers: Record<string, ProviderConfig> = {};
  for (const providerId of Object.keys(value)) {
    if (!PROVIDER_ID.test(providerId)) {
      diagnostics.push(
        diagnostic(
          file,
          `providers.${providerId}`,
          "expected a provider id matching ^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$",
        ),
      );
      continue;
    }
    const provider = parseProvider(value[providerId], providerId, file, diagnostics);
    if (provider !== null) providers[providerId] = provider;
  }
  return providers;
}

/** `severity` (Section 2): each invalid field defaults; an invalid order defaults both. */
function parseSeverity(
  value: unknown,
  file: string,
  diagnostics: Diagnostic[],
): SeverityThresholds {
  const fallback: SeverityThresholds = { ...DEFAULT_SEVERITY_THRESHOLDS };
  if (value === undefined) return fallback;
  if (!isRecord(value)) {
    diagnostics.push(diagnostic(file, "severity", "expected an object"));
    return fallback;
  }
  reportUnknownKeys(value, SEVERITY_KEYS, "severity", file, diagnostics);

  let low = DEFAULT_SEVERITY_THRESHOLDS.low;
  let critical = DEFAULT_SEVERITY_THRESHOLDS.critical;

  if (has(value, "low")) {
    if (isFiniteNumber(value.low)) low = value.low;
    else diagnostics.push(diagnostic(file, "severity.low", "expected a number"));
  }
  if (has(value, "critical")) {
    if (isFiniteNumber(value.critical)) critical = value.critical;
    else diagnostics.push(diagnostic(file, "severity.critical", "expected a number"));
  }

  if (!(low > 0 && low < critical && critical <= 100)) {
    diagnostics.push(diagnostic(file, "severity", "expected 0 < low < critical ≤ 100"));
    return fallback;
  }
  return { low, critical };
}

/**
 * The configuration file's path: `PURSE_CONF` when it is absolute, else
 * `~/.pi/purse/purse.conf` (Sections 1, 3).
 */
export function configurationPath(env: ConfigurationEnv, homeDir: string): ConfigurationLocation {
  const configured = env.PURSE_CONF;
  if (configured !== undefined) {
    if (isAbsolute(configured)) return { path: configured, diagnostics: [] };
    return {
      path: join(homeDir, ...CONFIG_FILE_SEGMENTS),
      diagnostics: [diagnostic(configured, "PURSE_CONF", "expected an absolute path")],
    };
  }
  return { path: join(homeDir, ...CONFIG_FILE_SEGMENTS), diagnostics: [] };
}

/**
 * The configuration from the file text (`null` for a missing file), its path, and the
 * environment (Sections 1–3). Pure: no file is read, no clock, no host API.
 */
export function parseConfiguration(
  text: string | null,
  path: string,
  env: ConfigurationEnv = {},
): LoadedConfiguration {
  const diagnostics: Diagnostic[] = [];
  const configuration: LoadedConfiguration = {
    path,
    providers: {},
    severity: { ...DEFAULT_SEVERITY_THRESHOLDS },
    statusLine: DEFAULT_STATUS_LINE,
    offline: env.PURSE_OFFLINE === "1",
    diagnostics,
  };

  // A missing file, or one holding no JSON value, is an empty configuration, silently (Section 1).
  if (text === null || stripComments(text).trim() === "") return configuration;

  const errors: ParseError[] = [];
  const root: unknown = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const first = errors[0];
    if (first === undefined) return configuration;
    diagnostics.push(
      diagnostic(
        path,
        "",
        `invalid JSONC at offset ${first.offset}: ${printParseErrorCode(first.error)}`,
      ),
    );
    return configuration;
  }
  if (!isRecord(root)) {
    diagnostics.push(diagnostic(path, "", "expected the root to be an object"));
    return configuration;
  }

  reportUnknownKeys(root, ROOT_KEYS, "", path, diagnostics);

  if (has(root, "providers"))
    configuration.providers = parseProviders(root.providers, path, diagnostics);
  configuration.severity = parseSeverity(root.severity, path, diagnostics);

  if (has(root, "statusLine")) {
    if (typeof root.statusLine === "boolean") configuration.statusLine = root.statusLine;
    else diagnostics.push(diagnostic(path, "statusLine", "expected a boolean"));
  }

  return configuration;
}

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  if (!("code" in error)) return undefined;
  return error.code;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `readFileSync` with a missing file as `null` and every other failure thrown (Section 1). */
function readFileText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

/**
 * Resolve the path, read the file once, and parse it (Sections 1–3). A read failure other
 * than a missing file is one diagnostic and an empty configuration. Call it once per boot
 * window, at the first `session_start`, and keep the result.
 */
export function loadConfiguration(
  dependencies: ConfigurationDependencies = {},
): LoadedConfiguration {
  const env = dependencies.env ?? process.env;
  const homeDir = dependencies.homeDir ?? homedir();
  const readFile = dependencies.readFile ?? readFileText;
  const location = configurationPath(env, homeDir);

  let text: string | null;
  try {
    text = readFile(location.path);
  } catch (error) {
    return {
      ...parseConfiguration(null, location.path, env),
      diagnostics: [
        ...location.diagnostics,
        diagnostic(location.path, "", `could not be read: ${messageOf(error)}`),
      ],
    };
  }

  const loaded = parseConfiguration(text, location.path, env);
  loaded.diagnostics.unshift(...location.diagnostics);
  return loaded;
}
