/**
 * The `purse:query:v1` service of specs/query-protocol.md: validation of one request, the
 * offer, cancellation, the reply deadline, and the reply. Provider entries come from the
 * refresher (specs/refresh.md); this module neither derives nor refreshes on its own.
 *
 * A request is untrusted input from another extension: no value in any field makes the
 * handler throw, and the offered reply promise settles and never rejects.
 */

import type { Refresher, RefreshMode, Timers } from "./refresh.ts";
import type { ProviderEntry } from "./state.ts";

/** The consumer → service channel (Section 1). */
export const QUERY_CHANNEL = "purse:query:v1";

/** A provider id (Section 2); the pattern is compiled with the `u` flag. */
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;

/** The reply status values (Section 3). */
export type QueryStatus = "ok" | "not-ready" | "bad-request" | "cancelled";

/** A reply (Section 4). */
export interface QueryReply {
  protocol: 1;
  status: QueryStatus;
  generatedAt: number;
  providers: Record<string, ProviderEntry>;
}

/** The offer callback a request carries (Section 2). */
export type Respond = (reply: Promise<QueryReply>) => boolean;

/** A request (Section 2). Every field may hold any value: the payload is untrusted. */
export interface QueryRequest {
  providers?: string[];
  mode?: RefreshMode;
  signal?: AbortSignal;
  maxWaitMs?: number;
  respond: Respond;
}

/** The handler of one query: the `purse:query:v1` listener. */
export type QueryHandler = (request: unknown) => void;

/** What `createQueryHandler` needs. */
export interface QueryHandlerDependencies {
  /** The service's refresher. */
  refresher: Refresher;
  /** Current epoch milliseconds (the reply's `generatedAt`). */
  clock: () => number;
  /** Timer functions for the reply deadline; default to unreferenced global timers. */
  timers?: Timers;
}

/** A promise and its resolver; there is no reject, so a reply promise cannot reject. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Global timers that keep no reference on the process (the deadline is a short wait). */
function createGlobalTimers(): Timers {
  const handles = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;
  return {
    setTimeout: (callback, ms) => {
      const id = nextId++;
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
}

function isRespond(value: unknown): value is Respond {
  return typeof value === "function";
}

function isMode(value: unknown): value is RefreshMode {
  return value === "cached" || value === "auto" || value === "refresh";
}

/** A structural `AbortSignal` check: a signal may come from another module instance. */
function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== "object" || value === null) return false;
  try {
    return (
      typeof Reflect.get(value, "aborted") === "boolean" &&
      typeof Reflect.get(value, "addEventListener") === "function" &&
      typeof Reflect.get(value, "removeEventListener") === "function"
    );
  } catch {
    return false;
  }
}

/** One validated request field. */
type Parsed =
  | { kind: "ignore" }
  | { kind: "invalid"; respond: Respond }
  | {
      kind: "valid";
      respond: Respond;
      providers: string[] | null;
      mode: RefreshMode;
      signal: AbortSignal | undefined;
      maxWaitMs: number | undefined;
    };

/**
 * Reads a payload per Section 2: a payload that is not an object or whose `respond` is not a
 * function is ignored; any other field that violates Section 2 makes the request invalid.
 * Unknown fields are ignored.
 */
function parseRequest(payload: unknown): Parsed {
  const isObject =
    (typeof payload === "object" && payload !== null) || typeof payload === "function";
  if (!isObject) return { kind: "ignore" };

  let respond: unknown;
  try {
    respond = Reflect.get(payload, "respond");
  } catch {
    return { kind: "ignore" };
  }
  if (!isRespond(respond)) return { kind: "ignore" };

  try {
    const providers = Reflect.get(payload, "providers");
    const mode = Reflect.get(payload, "mode");
    const signal = Reflect.get(payload, "signal");

    let parsedProviders: string[] | null = null;
    if (providers !== undefined) {
      if (!Array.isArray(providers)) return { kind: "invalid", respond };
      const ids: string[] = [];
      for (const provider of providers) {
        if (typeof provider !== "string") return { kind: "invalid", respond };
        // Section 2: an id outside the pattern is not served and has no entry.
        if (PROVIDER_ID.test(provider)) ids.push(provider);
      }
      parsedProviders = ids;
    }

    let parsedMode: RefreshMode = "cached";
    if (mode !== undefined) {
      if (!isMode(mode)) return { kind: "invalid", respond };
      parsedMode = mode;
    }

    let parsedSignal: AbortSignal | undefined;
    if (signal !== undefined) {
      if (!isAbortSignal(signal)) return { kind: "invalid", respond };
      parsedSignal = signal;
    }

    const maxWaitMs = Reflect.get(payload, "maxWaitMs");
    let parsedWait: number | undefined;
    if (maxWaitMs !== undefined) {
      if (typeof maxWaitMs !== "number" || !Number.isFinite(maxWaitMs) || maxWaitMs < 0) {
        return { kind: "invalid", respond };
      }
      parsedWait = maxWaitMs;
    }

    return {
      kind: "valid",
      respond,
      providers: parsedProviders,
      mode: parsedMode,
      signal: parsedSignal,
      maxWaitMs: parsedWait,
    };
  } catch {
    return { kind: "invalid", respond };
  }
}

/** Ascending ASCII order of provider ids. */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Unique provider ids, sorted for stability; duplicates collapse (Section 2). */
function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].toSorted(compareIds);
}

/** A deep copy, so a reply shares no state with the refresher or another reply (Section 3). */
function cloneEntry(entry: ProviderEntry): ProviderEntry {
  try {
    return structuredClone(entry);
  } catch {
    return JSON.parse(JSON.stringify(entry));
  }
}

/** Creates the service of one request; `index.ts` subscribes the result to `purse:query:v1`. */
export function createQueryHandler(dependencies: QueryHandlerDependencies): QueryHandler {
  const { refresher, clock } = dependencies;
  const timers = dependencies.timers ?? createGlobalTimers();

  return (payload: unknown): void => {
    const parsed = parseRequest(payload);
    if (parsed.kind === "ignore") return;

    const reply = deferred<QueryReply>();
    // The offer: respond runs synchronously inside emit, before any refresh starts.
    let accepted = false;
    try {
      accepted = parsed.respond(reply.promise) === true;
    } catch {
      accepted = false;
    }

    /** Provider ids of the reply, resolved once at the start. */
    let providers: readonly string[] = [];
    /** Entries the refresher returned for a requested provider, by provider. */
    const resolved = new Map<string, ProviderEntry>();
    /** Providers whose request has not settled yet. */
    let remaining = 0;
    let settled = false;
    let deadline: { handle: unknown } | null = null;
    let detach: (() => void) | null = null;
    /** purse's own signal, aborted with the consumer's: no consumer object reaches the refresher. */
    let link: AbortController | null = null;

    const compose = (): Record<string, ProviderEntry> => {
      const entries: Record<string, ProviderEntry> = {};
      try {
        for (const provider of providers) {
          const entry = resolved.get(provider) ?? refresher.entry(provider);
          entries[provider] = cloneEntry(entry);
        }
      } catch {
        // A conforming refresher never throws here; the reply keeps what it already has.
      }
      return entries;
    };

    const finish = (status: QueryStatus): void => {
      if (settled) return;
      settled = true;
      if (deadline !== null) {
        timers.clearTimeout(deadline.handle);
        deadline = null;
      }
      if (detach !== null) {
        detach();
        detach = null;
      }
      if (link !== null) {
        // Releases the refresher's waiters; it never aborts a refresh (refresh.md Section 3).
        link.abort();
        link = null;
      }
      let generatedAt: number;
      try {
        generatedAt = clock();
      } catch {
        generatedAt = Date.now();
      }
      reply.resolve({
        protocol: 1,
        status,
        generatedAt,
        providers: status === "ok" ? compose() : {},
      });
    };

    const done = (provider: string, entry?: ProviderEntry): void => {
      if (settled) return;
      if (entry !== undefined) resolved.set(provider, entry);
      remaining -= 1;
      if (remaining <= 0) finish("ok");
    };

    const start = (): void => {
      if (parsed.kind === "invalid") {
        finish("bad-request");
        return;
      }

      let ready = false;
      try {
        ready = refresher.ready();
      } catch {
        ready = false;
      }
      if (!ready) {
        finish("not-ready");
        return;
      }

      let ids: readonly string[];
      try {
        ids = parsed.providers ?? refresher.knownProviders();
      } catch {
        ids = parsed.providers ?? [];
      }
      providers = sortedUnique(ids);
      if (providers.length === 0) {
        finish("ok");
        return;
      }

      const signal = parsed.signal;
      let aborted = false;
      if (signal !== undefined) {
        try {
          aborted = signal.aborted === true;
        } catch {
          aborted = false;
        }
      }
      if (aborted) {
        finish("cancelled");
        return;
      }

      // A non-accepting offer stops the service (Section 3): no refresh, no listener on the
      // signal. The reply still settles at once, with entries as they stand.
      if (!accepted) {
        finish("ok");
        return;
      }

      remaining = providers.length;
      // A delay above 2^31-1 ms fires immediately; a refresh settles within 15 s anyway.
      if (parsed.maxWaitMs !== undefined && parsed.maxWaitMs <= 2_147_483_647) {
        deadline = { handle: timers.setTimeout(() => finish("ok"), parsed.maxWaitMs) };
      }

      if (signal !== undefined) {
        link = new AbortController();
        const onAbort = (): void => finish(remaining === 0 ? "ok" : "cancelled");
        try {
          signal.addEventListener("abort", onAbort, { once: true });
          detach = (): void => {
            try {
              signal.removeEventListener("abort", onAbort);
            } catch {
              // A hostile signal cannot keep the reply from settling.
            }
          };
        } catch {
          detach = null;
        }
      }

      const options = link === null ? undefined : { signal: link.signal };
      for (const provider of providers) {
        try {
          Promise.resolve(refresher.request(provider, parsed.mode, options)).then(
            (entry) => done(provider, entry),
            () => done(provider),
          );
        } catch {
          done(provider);
        }
      }
    };

    try {
      start();
    } catch {
      finish("ok");
    }
  };
}
