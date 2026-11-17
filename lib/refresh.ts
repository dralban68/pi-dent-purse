/**
 * The cache and refresh logic of specs/refresh.md: per-provider captures and failures,
 * single-flight, suppression, backoff, the refresh deadline, and offline mode. Provider
 * entries are derived by `deriveProviderEntry` from the cache entry at call time.
 *
 * This module also owns what adapter-contract.md Sections 2–3 put before `run`: it resolves
 * and checks credentials (`checkCredentials`), binds each adapter's transport to its host
 * allowlist, and holds the process-wide adapter stores and header observations.
 *
 * Everything outside arrives by injection (adapters, clock, timers, configuration, the live
 * host, transports, the command runner, the change callback). An adapter is untrusted:
 * whatever it does, a `request` promise neither rejects nor hangs past the refresh deadline.
 */

import type {
  Adapter,
  AdapterDependencies,
  CheckedCredentials,
  CommandRunner,
  Credentials,
  InventoryModel,
  ProviderCredentials,
  Store,
  Transport,
} from "./adapter.ts";
import type { LoadedConfiguration, ProviderConfig } from "./config.ts";
import { deriveModelPrices } from "./prices.ts";
import { originOf } from "./transport.ts";
import {
  deriveProviderEntry,
  type AdapterResult,
  type Capture,
  type CaptureFacets,
  type ModelPrice,
  type ProviderEntry,
  type ProviderSettings,
  type ReasonCode,
} from "./state.ts";

/** The least time between the starts of two refreshes of one provider (Section 3). */
export const MINIMUM_INTERVAL_MS = 30_000;

/** A refresh must settle within this time of its start (Section 3). */
export const REFRESH_DEADLINE_MS = 15_000;

/** The serving age floor in seconds (Section 2). */
export const SERVING_AGE_FLOOR_SECONDS = 3600;

/** Backoff cap and the `retry-after` clamp bounds in seconds (Section 3). */
export const BACKOFF_MAX_SECONDS = 3600;
export const RETRY_AFTER_MIN_SECONDS = 60;
export const RETRY_AFTER_MAX_SECONDS = 3600;

/** First step of the doubling backoff, in seconds (Section 3). */
const BACKOFF_BASE_SECONDS = 60;

/** Reasons with a fixed 3600-second backoff (Section 3). */
const LONG_BACKOFF_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  "http-401",
  "http-403",
  "no-credentials",
  "unsupported-auth",
  "endpoint-mismatch",
  "gcloud-missing",
  "gcloud-unauthenticated",
  "project-unresolved",
]);

const REASON_CODES: Record<ReasonCode, true> = {
  "not-collected": true,
  offline: true,
  "no-credentials": true,
  "unsupported-auth": true,
  "endpoint-mismatch": true,
  network: true,
  timeout: true,
  deadline: true,
  redirect: true,
  "response-too-large": true,
  "http-401": true,
  "http-403": true,
  "http-429": true,
  "http-error": true,
  "bad-response": true,
  "vendor-error": true,
  "empty-response": true,
  "not-observed": true,
  "gcloud-missing": true,
  "gcloud-unauthenticated": true,
  "gcloud-failed": true,
  "project-unresolved": true,
  internal: true,
};

/** The request modes of query-protocol.md Section 2. */
export type RefreshMode = "cached" | "auto" | "refresh";

/** Timer functions; injectable so tests need no real waiting. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** What the live context provides (refresh.md Section 1); read at each use, never cached. */
export interface RefreshHost {
  /** The provider's inventory models (`modelRegistry.getAll()`); `[]` when none. */
  inventory(provider: string): readonly InventoryModel[];
  /** The providers of `modelRegistry.getAvailable()`, in any order, duplicates allowed. */
  availableProviders(): readonly string[];
  /** The provider's credentials as `getProviderAuth`/`isUsingOAuth` give them; may reject. */
  credentials(provider: string): Promise<ProviderCredentials | undefined>;
}

/** What `createRefresher` needs. */
export interface RefresherOptions {
  /** Adapters by provider id. */
  adapters: ReadonlyMap<string, Adapter> | Readonly<Record<string, Adapter>>;
  /** Current epoch milliseconds. */
  clock: () => number;
  /** The loaded configuration of the boot window; `offline` and `severity` are read from it. */
  configuration: LoadedConfiguration;
  /** The live context, or `undefined` without one (no refresh starts then). */
  host: () => RefreshHost | undefined;
  /**
   * A variable of the pi process's environment, read at each use; `undefined` when unset
   * (adapter-contract.md Section 3). Only tool providers' credential variables are read.
   */
  environment: (variable: string) => string | undefined;
  /**
   * A transport bound to an allowlist; called once per adapter with its `hostAllowlist`
   * (`(allowlist) => createTransport(fetch, allowlist)`).
   */
  transportFor: (allowedOrigins: readonly string[]) => Transport;
  /** The command runner (`createCommandRunner(pi.exec)`). */
  commandRunner: CommandRunner;
  /** Called after every completed refresh of the provider (emit `purse:changed:v1`). */
  onChanged: (provider: string) => void;
  /** Defaults to the global timers (unreferenced). */
  timers?: Timers;
}

/** Options of one `request`. */
export interface RequestOptions {
  /** Abort stops this caller's waiting; it never aborts a refresh. */
  signal?: AbortSignal;
  /** A bypassing refresh (`/purse refresh`): ignores backoff and the minimum interval. */
  bypass?: boolean;
}

/** The refresh module. */
export interface Refresher {
  /** Whether a live context exists (query-protocol.md `not-ready` otherwise). */
  ready(): boolean;
  /** The known providers in ascending ASCII order (refresh.md Section 1); `[]` without host. */
  knownProviders(): string[];
  /**
   * Records a header observation for the provider, in the shape its adapter spec fixes,
   * replacing the previous one; no refresh.
   */
  recordObservation(provider: string, observation: unknown): void;
  /** The provider's entry derived from the cache now; synchronous, never refreshes. */
  entry(provider: string): ProviderEntry;
  /**
   * Serves the provider per `mode` and resolves with its entry after any requested refresh
   * settled. Never rejects. `cached`: the entry as it stands. `auto`: refreshes when no fresh
   * capture. `refresh`: refreshes regardless of freshness. A refresh is joined when one is in
   * flight, suppressed per Section 3 (the current entry is returned), and never started for a
   * provider without adapter, a free or adapter-disabled provider, a provider other than a tool
   * provider without inventory models, or without live context. An aborted `signal` resolves at
   * once with the current entry.
   */
  request(provider: string, mode?: RefreshMode, options?: RequestOptions): Promise<ProviderEntry>;
  /**
   * Discards the cache, adapter stores, and header observations (`session_shutdown` with
   * reason `reload` or `quit`): in-flight refreshes are aborted and record nothing, their
   * waiters resolve, no change is emitted.
   */
  clear(): void;
}

/** Backoff in seconds after a failed refresh (or a capture reason), Section 3. */
export function backoffSeconds(
  reason: ReasonCode,
  failureCount: number,
  retryAfter?: number,
): number {
  if (LONG_BACKOFF_REASONS.has(reason)) return 3600;
  if (reason === "http-429" && typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
    return Math.min(Math.max(retryAfter, RETRY_AFTER_MIN_SECONDS), RETRY_AFTER_MAX_SECONDS);
  }
  return Math.min(BACKOFF_BASE_SECONDS * 2 ** (failureCount - 1), BACKOFF_MAX_SECONDS);
}

/**
 * The credential checks of adapter-contract.md Section 3, in order: a non-empty `apiKey`, then
 * the endpoint: the origin of `baseUrl` when present, else of every inventory model, equals the
 * provider origin. A tool provider has no provider origin, so the endpoint check is skipped for
 * it. Origins compare as `originOf` normalizes them.
 */
export function checkCredentials(
  providerOrigin: string | undefined,
  credentials: ProviderCredentials | undefined,
  inventory: readonly InventoryModel[],
): CheckedCredentials | "no-credentials" | "endpoint-mismatch" {
  const apiKey = credentials?.apiKey;
  if (credentials === undefined || typeof apiKey !== "string" || apiKey === "") {
    return "no-credentials";
  }
  if (providerOrigin === undefined) return { apiKey, oauth: credentials.oauth === true };
  const expected = originOf(providerOrigin);
  const baseUrls =
    credentials.baseUrl === undefined
      ? inventory.map((model) => model.baseUrl)
      : [credentials.baseUrl];
  if (expected === null || !baseUrls.every((baseUrl) => originOf(baseUrl) === expected)) {
    return "endpoint-mismatch";
  }
  return { apiKey, oauth: credentials.oauth === true };
}

/** Adapter-private store over the clock (adapter-contract.md Section 2). */
function createStore(clock: () => number): Store {
  const items = new Map<string, { value: unknown; expiresAt: number | null }>();
  return {
    get(key) {
      const item = items.get(key);
      if (item === undefined) return;
      if (item.expiresAt !== null && clock() >= item.expiresAt) {
        items.delete(key);
        return;
      }
      return item.value;
    },
    set(key, value, ttlSeconds) {
      items.set(key, {
        value,
        expiresAt: ttlSeconds === undefined ? null : clock() + ttlSeconds * 1000,
      });
    },
  };
}

type Outcome =
  | { kind: "failure"; reason: ReasonCode; retryAfter?: number }
  | {
      kind: "success";
      facets: CaptureFacets;
      capturedAt?: number;
      captureReason?: ReasonCode;
      retryAfter?: number;
    };

interface Flight {
  done: Promise<void>;
  /** Ends the flight; with `null` records nothing. */
  finish(outcome: Outcome | null): void;
  /** Aborts the adapter's signal. */
  abort(): void;
}

interface CacheEntry {
  capture: Capture | null;
  failure: { reason: ReasonCode; at: number } | null;
  failureCount: number;
  backoffEnd: number | null;
  lastStart: number | null;
  inFlight: Flight | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === "string" && Object.hasOwn(REASON_CODES, value);
}

function reasonOf(value: unknown): ReasonCode | null {
  return isReasonCode(value) ? value : null;
}

function isFacets(value: unknown): value is CaptureFacets {
  return isRecord(value);
}

function failureOf(value: unknown): Outcome {
  const record = isRecord(value) ? value : {};
  const reason = reasonOf(record.reason);
  if (reason === null) return { kind: "failure", reason: "internal" };
  const retryAfter = record.retryAfter;
  return typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0
    ? { kind: "failure", reason, retryAfter }
    : { kind: "failure", reason };
}

/** Whether any facet of the result's `facets` has state `known` (refresh.md Section 3). */
function hasKnownFacet(facets: unknown): boolean {
  if (!isRecord(facets)) return false;
  return ["plan", "balance", "limits"].some((name) => {
    const facet = facets[name];
    return isRecord(facet) && facet.state === "known";
  });
}

/** Section 3 Outcome: an untrusted adapter result becomes a failure or a success. */
function interpret(result: AdapterResult | unknown): Outcome {
  if (!isRecord(result)) return { kind: "failure", reason: "internal" };
  if ("reason" in result) return failureOf(result);
  const { facets, firstFailure, capturedAt, captureReason } = result;
  if (!isFacets(facets)) return { kind: "failure", reason: "internal" };
  const reason = captureReason === undefined ? undefined : reasonOf(captureReason);
  if (reason === null) return { kind: "failure", reason: "internal" };
  if (firstFailure !== undefined && !hasKnownFacet(facets) && reason === undefined) {
    return failureOf(firstFailure);
  }
  // A capture reason takes the `retryAfter` of the first failure when it is that failure.
  const first = firstFailure === undefined ? null : failureOf(firstFailure);
  const retryAfter =
    reason !== undefined && first?.kind === "failure" && first.reason === reason
      ? first.retryAfter
      : undefined;
  return {
    kind: "success",
    facets,
    ...(typeof capturedAt === "number" && Number.isFinite(capturedAt) ? { capturedAt } : {}),
    ...(reason === undefined ? {} : { captureReason: reason }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  };
}

const PROBE_MODEL: ModelPrice = {
  id: "probe",
  price: {
    rates: { input: null, output: null, cacheRead: null, cacheWrite: null },
    tiers: [],
    source: "unknown",
    schedule: null,
  },
};

/**
 * Copies the capture so the adapter keeps no handle on cached data, and proves entry
 * derivation accepts it; a malformed capture fails the refresh with `internal`.
 */
function sealCapture(adapter: Adapter, capture: Capture): Capture | null {
  try {
    const sealed = structuredClone(capture);
    deriveProviderEntry({
      provider: adapter.id,
      now: capture.capturedAt,
      models: [PROBE_MODEL],
      adapter,
      settings: {},
      thresholds: { low: 75, critical: 90 },
      capture: sealed,
      failure: null,
    });
    return sealed;
  } catch {
    return null;
  }
}

/** Creates the refresh module; one instance holds the process-wide cache. */
export function createRefresher(options: RefresherOptions): Refresher {
  const { clock, configuration, onChanged } = options;
  const handles = new Map<number, ReturnType<typeof setTimeout>>();
  let nextHandle = 1;
  const timers: Timers = options.timers ?? {
    setTimeout: (callback, ms) => {
      const id = nextHandle++;
      const handle = setTimeout(() => {
        handles.delete(id);
        callback();
      }, ms);
      handle.unref();
      handles.set(id, handle);
      return id;
    },
    clearTimeout: (id) => {
      if (typeof id !== "number") return;
      const handle = handles.get(id);
      if (handle !== undefined) clearTimeout(handle);
      handles.delete(id);
    },
  };
  const adapterMap: ReadonlyMap<string, Adapter> =
    options.adapters instanceof Map ? options.adapters : new Map(Object.entries(options.adapters));
  const adapterOf = (provider: string): Adapter | undefined => adapterMap.get(provider);
  const cache = new Map<string, CacheEntry>();
  const stores = new Map<string, Store>();
  const observations = new Map<string, unknown>();
  /** When each provider's latest header observation was recorded (Section 2, freshness). */
  const observedAt = new Map<string, number>();
  const transports = new Map<string, Transport>();

  const settingsOf = (provider: string): ProviderConfig =>
    Object.hasOwn(configuration.providers, provider)
      ? (configuration.providers[provider] ?? {})
      : {};

  const inventoryOf = (provider: string): readonly InventoryModel[] =>
    options.host()?.inventory(provider) ?? [];

  /** Whether a header observation was recorded after `lastStart` (Section 2, freshness). */
  const observedSince = (provider: string, lastStart: number | null): boolean => {
    const at = observedAt.get(provider);
    return at !== undefined && (lastStart === null || at > lastStart);
  };
  const freshnessMs = (adapter: Adapter, settings: ProviderSettings): number =>
    (settings.ttlSeconds ?? adapter.freshnessSeconds) * 1000;

  function entry(provider: string): ProviderEntry {
    const now = clock();
    const settings = settingsOf(provider);
    const state = cache.get(provider);
    const inventory = inventoryOf(provider);
    return deriveProviderEntry({
      provider,
      now,
      models:
        inventory.length === 0
          ? []
          : deriveModelPrices({ provider, settings, now, models: inventory }),
      adapter: adapterOf(provider) ?? null,
      settings,
      thresholds: configuration.severity,
      capture: state?.capture ?? null,
      failure: state?.failure?.reason ?? null,
    });
  }

  function knownProviders(): string[] {
    const host = options.host();
    if (host === undefined) return [];
    const providers = new Set(host.availableProviders());
    for (const [provider, settings] of Object.entries(configuration.providers)) {
      if (settings.free === true && host.inventory(provider).length > 0) providers.add(provider);
    }
    // Section 1: every tool provider whose credential variable holds a non-empty value.
    for (const adapter of adapterMap.values()) {
      const variable = adapter.credentialVariable;
      if (variable === undefined) continue;
      const value = options.environment(variable);
      if (value !== undefined && value !== "") providers.add(adapter.id);
    }
    return [...providers].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  function storeOf(adapter: Adapter): Store {
    let store = stores.get(adapter.id);
    if (store === undefined) {
      store = createStore(clock);
      stores.set(adapter.id, store);
    }
    return store;
  }

  function transportOf(adapter: Adapter): Transport {
    let transport = transports.get(adapter.id);
    if (transport === undefined) {
      transport = options.transportFor(adapter.hostAllowlist);
      transports.set(adapter.id, transport);
    }
    return transport;
  }

  /**
   * The credentials of the adapter's provider (Section 3): a tool provider's `apiKey` is the
   * value of its credential variable, absent when unset, with no `oauth` and no `baseUrl`;
   * every other provider's come from the host.
   */
  function credentialsOf(
    adapter: Adapter,
    host: RefreshHost,
  ): Promise<ProviderCredentials | undefined> {
    const variable = adapter.credentialVariable;
    if (variable === undefined) return host.credentials(adapter.id);
    const value = options.environment(variable);
    return Promise.resolve({
      ...(value === undefined ? {} : { apiKey: value }),
      oauth: false,
    });
  }

  /** Resolves and checks credentials, then builds the adapter's dependencies (Sections 2–3). */
  async function prepare(
    adapter: Adapter,
    host: RefreshHost,
  ): Promise<AdapterDependencies | ReasonCode> {
    const inventory = host.inventory(adapter.id);
    const checked = checkCredentials(
      adapter.providerOrigin,
      await credentialsOf(adapter, host),
      inventory,
    );
    if (typeof checked === "string") return checked;
    let first = true;
    const credentials: Credentials = async () => {
      if (first) {
        first = false;
        return checked;
      }
      const current = options.host();
      if (current === undefined) return;
      const again = checkCredentials(
        adapter.providerOrigin,
        await credentialsOf(adapter, current),
        current.inventory(adapter.id),
      );
      return typeof again === "string" ? undefined : again;
    };
    return {
      transport: transportOf(adapter),
      commandRunner: options.commandRunner,
      credentials,
      inventory,
      clock,
      configuration: settingsOf(adapter.id),
      store: storeOf(adapter),
      observations: { latest: () => observations.get(adapter.id) },
    };
  }

  function record(state: CacheEntry, adapter: Adapter, outcome: Outcome, now: number): void {
    if (outcome.kind === "failure") {
      state.failure = { reason: outcome.reason, at: now };
      // Section 3: an `offline` failure is recorded but changes neither the failure count
      // nor the backoff end.
      if (outcome.reason !== "offline") {
        state.failureCount += 1;
        state.backoffEnd =
          now + backoffSeconds(outcome.reason, state.failureCount, outcome.retryAfter) * 1000;
      }
      return;
    }
    const capture: Capture = {
      facets: outcome.facets,
      capturedAt: outcome.capturedAt ?? now,
      ...(outcome.captureReason === undefined ? {} : { captureReason: outcome.captureReason }),
    };
    const sealed = sealCapture(adapter, capture);
    if (sealed === null) {
      record(state, adapter, { kind: "failure", reason: "internal" }, now);
      return;
    }
    state.capture = sealed;
    state.failure = null;
    if (outcome.captureReason === undefined) {
      state.failureCount = 0;
      state.backoffEnd = null;
    } else {
      state.failureCount += 1;
      state.backoffEnd =
        now + backoffSeconds(outcome.captureReason, state.failureCount, outcome.retryAfter) * 1000;
    }
  }

  function startRefresh(
    provider: string,
    adapter: Adapter,
    state: CacheEntry,
    host: RefreshHost,
  ): Flight {
    state.lastStart = clock();
    const controller = new AbortController();
    let finished = false;
    let timer: unknown;
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const abort = (): void => {
      try {
        controller.abort();
      } catch {
        // Listener errors are the adapter's.
      }
    };
    const finish = (outcome: Outcome | null): void => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      if (state.inFlight === flight) state.inFlight = null;
      if (outcome !== null && cache.get(provider) === state) {
        record(state, adapter, outcome, clock());
        try {
          onChanged(provider);
        } catch {
          // A change callback must not break the refresh.
        }
      }
      resolveDone();
    };
    const flight: Flight = { done, finish, abort };
    state.inFlight = flight;

    if (configuration.offline) {
      finish({ kind: "failure", reason: "offline" });
      return flight;
    }

    timer = timers.setTimeout(() => {
      timer = undefined;
      abort();
      finish({ kind: "failure", reason: "deadline" });
    }, REFRESH_DEADLINE_MS);

    const run = async (): Promise<Outcome> => {
      const prepared = await prepare(adapter, host);
      if (typeof prepared === "string") return { kind: "failure", reason: prepared };
      if (finished) return { kind: "failure", reason: "deadline" };
      return interpret(await adapter.run(prepared, controller.signal));
    };
    new Promise<Outcome>((resolve) => {
      resolve(run());
    }).then(finish, () => finish({ kind: "failure", reason: "internal" }));
    return flight;
  }

  function wait(provider: string, flight: Flight, signal?: AbortSignal): Promise<ProviderEntry> {
    if (signal === undefined) return flight.done.then(() => entry(provider));
    return new Promise<ProviderEntry>((resolve) => {
      const onAbort = (): void => resolve(entry(provider));
      // A throwing signal must not reject or strand the waiter.
      try {
        signal.addEventListener("abort", onAbort, { once: true });
      } catch {}
      void flight.done.then(() => {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {}
        resolve(entry(provider));
      });
    });
  }

  function request(
    provider: string,
    mode: RefreshMode = "cached",
    requestOptions: RequestOptions = {},
  ): Promise<ProviderEntry> {
    const { signal, bypass = false } = requestOptions;
    const adapter = adapterOf(provider);
    const settings = settingsOf(provider);
    const host = options.host();
    if (
      mode === "cached" ||
      signal?.aborted === true ||
      adapter === undefined ||
      host === undefined ||
      settings.free === true ||
      settings.adapter === false ||
      // Section 3: only a tool provider needs no inventory model.
      (adapter.credentialVariable === undefined && host.inventory(provider).length === 0)
    ) {
      return Promise.resolve(entry(provider));
    }

    const existing = cache.get(provider);
    if (existing?.inFlight) return wait(provider, existing.inFlight, signal);

    const now = clock();
    const fresh =
      existing?.capture != null &&
      now < existing.capture.capturedAt + freshnessMs(adapter, settings) &&
      !observedSince(provider, existing.lastStart);
    if (mode === "auto" && fresh) return Promise.resolve(entry(provider));

    if (existing && !bypass) {
      if (existing.backoffEnd !== null && now < existing.backoffEnd) {
        return Promise.resolve(entry(provider));
      }
      if (
        mode !== "auto" &&
        existing.lastStart !== null &&
        now - existing.lastStart < MINIMUM_INTERVAL_MS
      ) {
        return Promise.resolve(entry(provider));
      }
    }

    const state = existing ?? {
      capture: null,
      failure: null,
      failureCount: 0,
      backoffEnd: null,
      lastStart: null,
      inFlight: null,
    };
    cache.set(provider, state);
    return wait(provider, startRefresh(provider, adapter, state, host), signal);
  }

  function clear(): void {
    const flights = [...cache.values()].map((state) => state.inFlight);
    cache.clear();
    stores.clear();
    observations.clear();
    observedAt.clear();
    for (const flight of flights) {
      if (flight === null) continue;
      flight.abort();
      flight.finish(null);
    }
  }

  return {
    ready: () => options.host() !== undefined,
    knownProviders,
    recordObservation: (provider, observation) => {
      observations.set(provider, observation);
      observedAt.set(provider, clock());
    },
    entry,
    request,
    clear,
  };
}
