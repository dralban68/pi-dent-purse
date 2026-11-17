/**
 * User interface: the billing report, the `purse` command and the status line
 * (user-interface.md). Rendering is pure — entries, the current time and a width
 * in terminal columns go in, lines of text come out — so it needs no terminal
 * and no host. The command and the status line are thin layers over a
 * `Refresher` and an injected clock.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { Refresher, RequestOptions, RefreshMode, Timers } from "./refresh.ts";
import type { GuidedModel } from "./guidance.ts";
import type { BalanceItem, Facet, LimitWindow, Price, ProviderEntry } from "./state.ts";

/** The command registered with the host (user-interface.md Section 1). */
export const PURSE_COMMAND_NAME = "purse";
/** The command description (user-interface.md Section 1). */
export const PURSE_COMMAND_DESCRIPTION =
  "Show billing state: /purse [all] [refresh] [provider ...]";
/** The status key used with `ctx.ui.setStatus` (user-interface.md Section 3). */
export const PURSE_STATUS_KEY = "purse";
/** The custom type of the report message (user-interface.md Section 1). */
export const PURSE_MESSAGE_TYPE = "purse";

/** An argument token that selects a bypassing refresh. */
const REFRESH_TOKEN = "refresh";
/** An argument token that selects the full view. */
const ALL_TOKEN = "all";
/** Separator between status-line facets. */
const STATUS_SEPARATOR = " · ";
/** At most this many limit windows appear in the status line. */
const STATUS_MAX_WINDOWS = 3;
/** At most this many units a status-line time left is written with. */
const STATUS_TIME_LEFT_UNITS = 2;
/** The status line is rendered again at most this often while it carries a time left. */
const STATUS_RERENDER_MS = 60_000;
/** The time left of under a minute. */
const IMMINENT_TEXT = "<1m";
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Width used for the report in non-TUI modes. */
const DEFAULT_NOTIFY_WIDTH = 80;
const NOT_EXPOSED_TEXT = "—";
const UNKNOWN_TEXT = "?";

// ---------------------------------------------------------------------------
// Terminal-safe text
// ---------------------------------------------------------------------------

/**
 * Removes control characters, format characters, line/paragraph separators and
 * bidi overrides, so nothing in a vendor supplied string can drive the terminal
 * or break the layout.
 */
export function sanitizeText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Width of `text` in terminal columns, as the host's TUI measures it. */
export function displayWidth(text: string): number {
  return visibleWidth(text);
}

/** The longest prefix of `text` that fits in `width` terminal columns; no ellipsis. */
export function truncateToWidth(text: string, width: number): string {
  const limit = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (limit === 0) return "";
  if (visibleWidth(text) <= limit) return text;
  let result = "";
  for (const { segment } of graphemes.segment(text)) {
    const next = result + segment;
    if (visibleWidth(next) > limit) break;
    result = next;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return UNKNOWN_TEXT;
  return String(value === 0 ? 0 : value);
}

/** An amount with two decimals, e.g. `0.00`, `12.50`, `1000000000.00`. */
export function formatAmount(amount: number): string {
  if (!Number.isFinite(amount)) return UNKNOWN_TEXT;
  return amount.toFixed(2);
}

function formatPercent(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return UNKNOWN_TEXT;
  return `${formatNumber(percent)}%`;
}

/**
 * A duration as its largest whole unit with the `s`, `m`, `h` or `d` suffix,
 * e.g. `0s`, `59s`, `1m`, `23h`, `2d`. Negative durations read `0s`.
 */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return UNKNOWN_TEXT;
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/**
 * A time left as up to two of its whole days, hours and minutes, each from the
 * remainder of the larger ones, e.g. `3d5h`, `2h14m`, `45m`; under a minute,
 * or at or below zero, `<1m` (user-interface.md Section 3).
 */
export function formatTimeLeft(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return UNKNOWN_TEXT;
  if (milliseconds < MINUTE_MS) return IMMINENT_TEXT;
  const parts: string[] = [];
  let rest = milliseconds;
  for (const [size, suffix] of [
    [DAY_MS, "d"],
    [HOUR_MS, "h"],
    [MINUTE_MS, "m"],
  ] as const) {
    const whole = Math.floor(rest / size);
    rest -= whole * size;
    if (whole >= 1) parts.push(`${whole}${suffix}`);
    if (parts.length === STATUS_TIME_LEFT_UNITS) break;
  }
  return parts.join("");
}

function captureAge(capturedAt: number | null, now: number): string {
  if (capturedAt === null) return "never";
  return formatDuration(now - capturedAt);
}

function planText(plan: Facet<string>): string {
  if (plan.state === "not-exposed") return NOT_EXPOSED_TEXT;
  if (plan.state === "unavailable") return UNKNOWN_TEXT;
  const value = sanitizeText(plan.value);
  return value === "" ? UNKNOWN_TEXT : value;
}

function unitText(window: LimitWindow): string {
  if (window.unit === "currency")
    return sanitizeText(window.currency ?? UNKNOWN_TEXT) || UNKNOWN_TEXT;
  return window.unit;
}

// ---------------------------------------------------------------------------
// Billing report (user-interface.md Section 2)
// ---------------------------------------------------------------------------

/** Options for {@link renderProviderEntry}. */
export interface ProviderEntryRenderOptions {
  /** Current time in milliseconds since the epoch. */
  now: number;
}

/** Options for {@link renderReport}. */
export interface ReportOptions {
  /** Current time in milliseconds since the epoch. */
  now: number;
  /** Available width in terminal columns; no line is wider. `Infinity`: untruncated. */
  width: number;
  /** The guided view's models; `undefined` renders the full view. */
  only?: readonly GuidedModel[];
}

function compareAscii(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function limitLine(window: LimitWindow, now: number): string {
  const money = window.unit === "currency";
  const amount = (value: number | null): string => {
    if (value === null || !Number.isFinite(value)) return UNKNOWN_TEXT;
    return money ? formatAmount(value) : formatNumber(value);
  };

  let line = `  ${sanitizeText(window.label)}`;
  // Section 2: no percent when it is unknown, the limit unknown, and used known.
  if (!(window.percent === null && window.limit === null && window.used !== null)) {
    line += ` ${formatPercent(window.percent)}`;
  }
  if (window.limit !== null) {
    line += ` ${amount(window.used)}/${amount(window.limit)} ${unitText(window)}`;
  } else if (window.used !== null) {
    line += ` ${amount(window.used)} ${unitText(window)}`;
  }
  if (window.resetsAt !== null) {
    line += ` resets in ${formatDuration(window.resetsAt - now)}`;
  }
  return line;
}

function balanceLine(item: BalanceItem): string {
  const assumed = item.currencyAssumed ? " (assumed)" : "";
  return `  ${formatAmount(item.amount)} ${sanitizeText(item.currency)}${assumed}`;
}

function rate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return UNKNOWN_TEXT;
  return formatNumber(value);
}

function modelLine(id: string, price: Price): string {
  const { rates, schedule } = price;
  let line = `  ${sanitizeText(id)} ${rate(rates.input)} ${rate(rates.output)} ${rate(
    rates.cacheRead,
  )} ${rate(rates.cacheWrite)}`;
  if (schedule !== null && schedule.active) {
    line += ` ×${formatNumber(schedule.multiplier)} now`;
  }
  return line;
}

function guidedIndex(models: readonly GuidedModel[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const { provider, id } of models) {
    const ids = index.get(provider);
    if (ids === undefined) index.set(provider, new Set([id]));
    else ids.add(id);
  }
  return index;
}

/** The entry with only the guided models; `undefined` when it has none. */
function narrowToGuided(
  entry: ProviderEntry,
  ids: ReadonlySet<string> | undefined,
): ProviderEntry | undefined {
  if (ids === undefined) return undefined;
  const models: ProviderEntry["models"] = {};
  for (const id of Object.keys(entry.models)) {
    const model = entry.models[id];
    if (model !== undefined && ids.has(id)) models[id] = model;
  }
  if (Object.keys(models).length === 0) return undefined;
  return { ...entry, models };
}

/**
 * The entry the guided view shows: whole when it has no models, else only its guided models;
 * `undefined` when it has models but none guided (Section 1).
 */
function guidedEntry(
  entry: ProviderEntry,
  ids: ReadonlySet<string> | undefined,
): ProviderEntry | undefined {
  if (Object.keys(entry.models).length === 0) return entry;
  return narrowToGuided(entry, ids);
}

/** The lines for one provider entry, without truncation. */
export function renderProviderEntry(
  entry: ProviderEntry,
  options: ProviderEntryRenderOptions,
): string[] {
  const header: string[] = [
    sanitizeText(entry.provider),
    entry.severity,
    planText(entry.plan),
    captureAge(entry.capturedAt, options.now),
  ];
  if (entry.stale) header.push("stale");
  if (entry.status !== "ok") header.push(entry.status);

  const lines: string[] = [header.join(" ")];
  if (entry.reason !== null) lines.push(`reason: ${entry.reason}`);
  if (entry.limits.state === "known") {
    for (const window of entry.limits.value) lines.push(limitLine(window, options.now));
  }
  if (entry.balance.state === "known") {
    for (const item of entry.balance.value) lines.push(balanceLine(item));
  }
  for (const id of Object.keys(entry.models).toSorted(compareAscii)) {
    const model = entry.models[id];
    if (model !== undefined) lines.push(modelLine(id, model.price));
  }
  return lines;
}

/**
 * The billing report: one block per provider in ascending ASCII order, blocks
 * separated by an empty line, every line at most `width` terminal columns. An
 * infinite `width` leaves lines untruncated, for a renderer that cuts them.
 */
export function renderReport(entries: readonly ProviderEntry[], options: ReportOptions): string[] {
  const limited = Number.isFinite(options.width);
  const width = limited ? Math.max(0, Math.floor(options.width)) : 0;
  const guided = options.only === undefined ? undefined : guidedIndex(options.only);
  const ordered = entries.toSorted((a, b) => compareAscii(a.provider, b.provider));
  const lines: string[] = [];
  for (const entry of ordered) {
    const shown = guided === undefined ? entry : guidedEntry(entry, guided.get(entry.provider));
    if (shown === undefined) continue;
    if (lines.length > 0) lines.push("");
    for (const line of renderProviderEntry(shown, { now: options.now })) lines.push(line);
  }
  return lines.map((line) => {
    const clean = sanitizeText(line).replace(/\s+$/u, "");
    return limited ? truncateToWidth(clean, width) : clean;
  });
}

// ---------------------------------------------------------------------------
// Status line (user-interface.md Section 3)
// ---------------------------------------------------------------------------

/** Whether the status line is active for a context (user-interface.md Section 3). */
export function statusLineActive(
  statusLine: boolean,
  ctx: Pick<PurseStatusContext, "mode" | "hasUI">,
): boolean {
  return statusLine && (ctx.mode === "tui" || ctx.mode === "rpc") && ctx.hasUI;
}

/** A rendered status line and whether it carries a time left. */
interface StatusRender {
  /** The text to show, or `undefined` when the status must be cleared. */
  text: string | undefined;
  /** Whether the text carries a time left, so the line must be rendered again. */
  timeLeft: boolean;
}

/** The status text for the current model's provider, as of `now`. */
function statusRender(
  entry: ProviderEntry | undefined,
  currentModelId: string | undefined,
  now: number,
): StatusRender {
  const cleared: StatusRender = { text: undefined, timeLeft: false };
  if (entry === undefined || currentModelId === undefined) return cleared;

  let text: string | undefined;
  let timeLeft = false;
  if (entry.status === "free") {
    text = "free";
  } else {
    const windows = entry.limits.state === "known" ? entry.limits.value : [];
    const shown = windows
      .filter(
        (window) =>
          window.severity !== "unknown" &&
          (window.models === null || window.models.includes(currentModelId)),
      )
      .toSorted((a, b) => (b.windowSeconds ?? 0) - (a.windowSeconds ?? 0))
      .slice(0, STATUS_MAX_WINDOWS)
      .map((window) => {
        const base = `${sanitizeText(window.label)} ${Math.round(window.percent ?? 0)}%`;
        if (window.resetsAt === null) return base;
        timeLeft = true;
        return `${base} ${formatTimeLeft(window.resetsAt - now)}`;
      });

    if (shown.length > 0) {
      text = shown.join(STATUS_SEPARATOR);
    } else {
      const items = entry.balance.state === "known" ? entry.balance.value : [];
      const gated = items
        .filter((item) => item.gatesUsage)
        .map((item) => `${formatAmount(item.amount)} ${sanitizeText(item.currency)}`);
      if (gated.length > 0) text = gated.join(STATUS_SEPARATOR);
    }
  }

  if (text === undefined) return cleared;
  const clean = sanitizeText(text);
  if (clean === "") return cleared;
  return { text: entry.stale ? `${clean} (stale)` : clean, timeLeft };
}

/**
 * The status text for the current model's provider, or `undefined` when the
 * status must be cleared.
 */
export function renderStatusLine(
  entry: ProviderEntry | undefined,
  currentModelId: string | undefined,
  now: number,
): string | undefined {
  return statusRender(entry, currentModelId, now).text;
}

// ---------------------------------------------------------------------------
// Command argument parsing (user-interface.md Section 1)
// ---------------------------------------------------------------------------

/** A parsed `/purse` invocation. */
export interface PurseSelection {
  /** Whether the `refresh` token asked for a bypassing refresh. */
  refresh: boolean;
  /** Whether the `all` token asked for the full view. */
  all: boolean;
  /** Whether at least one provider token remained after the leading flags. */
  named: boolean;
  /** The selected provider ids in ascending ASCII order. */
  providers: string[];
}

function splitArguments(args: string): string[] {
  return args.split(/\s+/u).filter((token) => token !== "");
}

/**
 * Parses the command arguments: leading `refresh` and `all` tokens in either
 * order, then provider ids, of which only known ones are kept. No provider
 * token selects every known provider; only invalid tokens select none.
 */
export function parsePurseArguments(args: string, known: readonly string[]): PurseSelection {
  const tokens = splitArguments(args);
  let refresh = false;
  let all = false;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === REFRESH_TOKEN) refresh = true;
    else if (token === ALL_TOKEN) all = true;
    else break;
    index += 1;
  }
  const names = tokens.slice(index);
  const named = names.length > 0;
  if (names.length === 0) {
    return { refresh, all, named, providers: [...new Set(known)].toSorted(compareAscii) };
  }
  const ids = new Set(known);
  const selected = new Set<string>();
  for (const name of names) {
    if (ids.has(name)) selected.add(name);
  }
  return { refresh, all, named, providers: [...selected].toSorted(compareAscii) };
}

/** One argument completion, shaped like the host's `AutocompleteItem`. */
export interface PurseCompletion {
  value: string;
  label: string;
  description?: string;
}

/**
 * Completions for the command arguments: `all` and `refresh` in the first
 * position and the known provider ids matching the token being typed.
 */
export function completePurseArguments(
  prefix: string,
  known: readonly string[],
): PurseCompletion[] | null {
  const trimmedStart = prefix.replace(/^\s+/u, "");
  const tokens = trimmedStart === "" ? [] : splitArguments(trimmedStart);
  const trailingSpace = /\s$/u.test(prefix);
  const completed = trailingSpace ? tokens : tokens.slice(0, -1);
  const token = trailingSpace ? "" : (tokens[tokens.length - 1] ?? "");
  const first = completed.length === 0;
  const candidates = (first ? [ALL_TOKEN, REFRESH_TOKEN, ...known] : known).filter((candidate) =>
    candidate.startsWith(token),
  );
  if (candidates.length === 0) return null;
  return candidates.map((candidate) => ({
    value: [...completed, candidate].join(" ") + " ",
    label: candidate,
  }));
}

// ---------------------------------------------------------------------------
// Host surface — the minimal part of the extension API this module needs
// ---------------------------------------------------------------------------

/** The report message handed to the sender. */
export interface PurseReportMessage {
  /** The report's lines joined by a newline. */
  content: string;
}

/** The host UI methods this module calls. */
export interface PurseUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}

/** The parts of the command context this module reads. */
export interface PurseCommandContext {
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
  ui: PurseUi;
  /** The session branch's guided models, empty when it has no model guidance. */
  guidance: readonly GuidedModel[];
}

/** The parts of the command context the status line reads. */
export interface PurseStatusContext {
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
  ui: { setStatus(key: string, text: string | undefined): void };
}

/** The current model as far as the status line needs it. */
export interface PurseModel {
  provider: string;
  id: string;
}

/** What `pi.registerCommand` receives. */
export interface PurseCommand {
  name: string;
  description: string;
  getArgumentCompletions(argumentPrefix: string): PurseCompletion[] | null;
  handler(args: string, ctx: PurseCommandContext): Promise<void>;
}

/** Dependencies of {@link createPurseCommand}. */
export interface PurseCommandOptions {
  refresher: Refresher;
  /** The current time in milliseconds since the epoch. */
  clock: () => number;
  /** Delivers the report to the session transcript in mode `tui`. */
  send: (message: PurseReportMessage) => void;
  /** Width in terminal columns for the non-TUI report; defaults to 80. */
  notifyWidth?: number;
}

/** Dependencies of {@link createStatusLineUpdater}. */
export interface StatusLineOptions {
  refresher: Refresher;
  /** The `statusLine` configuration key. */
  statusLine: boolean;
  /** The render time in milliseconds since the epoch. */
  clock: () => number;
  /** Timer functions for the re-render; default to unreferenced global timers. */
  timers?: Timers;
}

/** Updates the status line for a host event's model. */
export type StatusLineUpdater = (ctx: PurseStatusContext, model?: PurseModel) => void;

// ---------------------------------------------------------------------------
// Command (user-interface.md Section 1)
// ---------------------------------------------------------------------------

function knownProviders(refresher: Refresher): string[] {
  if (!refresher.ready()) return [];
  return refresher.knownProviders();
}

function requestOptionsFor(selection: PurseSelection): {
  mode: RefreshMode;
  options: RequestOptions;
} {
  if (selection.refresh) return { mode: "refresh", options: { bypass: true } };
  return { mode: "auto", options: {} };
}

/**
 * Builds the `purse` command: argument completions, argument parsing and the
 * three UI modes (a transcript message in `tui`, a notification elsewhere,
 * silence without a UI).
 */
export function createPurseCommand(options: PurseCommandOptions): PurseCommand {
  const { refresher, clock, send } = options;
  const notifyWidth = options.notifyWidth ?? DEFAULT_NOTIFY_WIDTH;

  return {
    name: PURSE_COMMAND_NAME,
    description: PURSE_COMMAND_DESCRIPTION,
    getArgumentCompletions: (argumentPrefix) =>
      completePurseArguments(argumentPrefix, knownProviders(refresher)),
    async handler(args, ctx) {
      const selection = parsePurseArguments(args, knownProviders(refresher));
      const { mode, options: requestOptions } = requestOptionsFor(selection);
      if (selection.providers.length === 0) return;

      const entries = await Promise.all(
        selection.providers.map((provider) => refresher.request(provider, mode, requestOptions)),
      );
      if (!ctx.hasUI) return;

      // Without `all` and without provider tokens, the guided view; with no model guidance, the full view.
      const only =
        selection.all || selection.named || ctx.guidance.length === 0 ? undefined : ctx.guidance;
      const tui = ctx.mode === "tui";
      // The transcript's width is unknown here: the host renders the message.
      const lines = renderReport(entries, {
        now: clock(),
        width: tui ? Number.POSITIVE_INFINITY : notifyWidth,
        ...(only === undefined ? {} : { only }),
      });
      if (lines.length === 0) return;
      if (tui) send({ content: lines.join("\n") });
      else ctx.ui.notify(lines.join("\n"), "info");
    },
  };
}

// ---------------------------------------------------------------------------
// Status line updater (user-interface.md Section 3)
// ---------------------------------------------------------------------------

/** Global timers that keep no reference on the process. */
function createStatusTimers(): Timers {
  const handles = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;
  return {
    setTimeout(callback, ms) {
      const id = nextId++;
      const handle = setTimeout(() => {
        handles.delete(id);
        callback();
      }, ms);
      handle.unref();
      handles.set(id, handle);
      return id;
    },
    clearTimeout(id) {
      if (typeof id !== "number") return;
      const handle = handles.get(id);
      if (handle !== undefined) clearTimeout(handle);
      handles.delete(id);
    },
  };
}

/**
 * Builds the status-line updater: it reads the cached entry of the event's
 * model provider and writes `purse`'s footer text, or clears it, rendering
 * again every minute while a shown time left keeps changing.
 */
export function createStatusLineUpdater(options: StatusLineOptions): StatusLineUpdater {
  const { refresher, statusLine, clock } = options;
  const timers = options.timers ?? createStatusTimers();
  let timer: unknown;
  let last: { ctx: PurseStatusContext; model: PurseModel } | undefined;

  function stopTimer(): void {
    if (timer === undefined) return;
    timers.clearTimeout(timer);
    timer = undefined;
  }

  function startTimer(): void {
    timer = timers.setTimeout(() => {
      timer = undefined;
      if (last !== undefined) draw(last.ctx, last.model);
    }, STATUS_RERENDER_MS);
  }

  function clear(ctx: PurseStatusContext): void {
    stopTimer();
    last = undefined;
    ctx.ui.setStatus(PURSE_STATUS_KEY, undefined);
  }

  function draw(ctx: PurseStatusContext, model: PurseModel | undefined): void {
    if (!statusLineActive(statusLine, ctx) || model === undefined || !refresher.ready()) {
      clear(ctx);
      return;
    }
    const { text, timeLeft } = statusRender(refresher.entry(model.provider), model.id, clock());
    if (text === undefined) {
      clear(ctx);
      return;
    }
    last = { ctx, model };
    ctx.ui.setStatus(PURSE_STATUS_KEY, text);
    stopTimer();
    if (timeLeft) startTimer();
  }

  return (ctx, model) => {
    draw(ctx, model);
  };
}
