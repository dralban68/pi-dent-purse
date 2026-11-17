import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Adapter,
  AdapterDependencies,
  InventoryModel,
  ProviderCredentials,
  Transport,
} from "../lib/adapter.ts";
import type { LoadedConfiguration, ProviderConfig } from "../lib/config.ts";
import {
  BACKOFF_MAX_SECONDS,
  MINIMUM_INTERVAL_MS,
  REFRESH_DEADLINE_MS,
  backoffSeconds,
  checkCredentials,
  createRefresher,
  type RefreshMode,
  type Refresher,
  type Timers,
} from "../lib/refresh.ts";
import type { AdapterResult, FacetName, ProviderEntry, ReasonCode } from "../lib/state.ts";

const SECOND = 1000;
const START = 1_000_000_000_000;

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class FakeTime {
  now = START;
  private timers: { id: number; at: number; callback: () => void }[] = [];
  private nextId = 1;
  readonly clock = (): number => this.now;
  readonly timerApi: Timers = {
    setTimeout: (callback, ms) => {
      const id = this.nextId++;
      this.timers.push({ id, at: this.now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => {
      this.timers = this.timers.filter((timer) => timer.id !== handle);
    },
  };
  get pending(): number {
    return this.timers.length;
  }
  /** Moves time forward, firing due timers in order. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .toSorted((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.now = Math.max(this.now, due.at);
      due.callback();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function ok(plan = "pro", extra: object = {}): AdapterResult {
  return {
    facets: { plan: { state: "known", value: plan } },
    ...extra,
  };
}

function fail(reason: ReasonCode, retryAfter?: number): AdapterResult {
  return retryAfter === undefined ? { reason } : { reason, retryAfter };
}

type RunFn = (
  call: number,
  signal: AbortSignal,
  deps: AdapterDependencies,
) => Promise<AdapterResult> | AdapterResult;

interface TestAdapter extends Adapter {
  calls: number;
  signals: AbortSignal[];
  deps: AdapterDependencies[];
}

function makeAdapter(
  run: RunFn,
  freshnessSeconds = 300,
  exposedFacets: readonly FacetName[] = ["plan"],
  toolVariable?: string,
): TestAdapter {
  const adapter: TestAdapter = {
    id: "anthropic",
    ...(toolVariable === undefined
      ? { providerOrigin: "https://example.test" }
      : { credentialVariable: toolVariable }),
    hostAllowlist: ["https://example.test"],
    exposedFacets,
    freshnessSeconds,
    calls: 0,
    signals: [],
    deps: [],
    run: (deps, signal) => {
      adapter.calls += 1;
      adapter.signals.push(signal);
      adapter.deps.push(deps);
      return Promise.resolve(run(adapter.calls, signal, deps));
    },
  };
  return adapter;
}

const MODEL: InventoryModel = {
  id: "model-a",
  baseUrl: "https://example.test/v1",
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
};

const KEY: ProviderCredentials = { apiKey: "key-1", oauth: true };

const TRANSPORT: Transport = async () => ({ reason: "network" });

interface Harness {
  time: FakeTime;
  refresher: Refresher;
  adapter: TestAdapter;
  changes: string[];
  live: { value: boolean };
  config: LoadedConfiguration;
  /** The allowlists `transportFor` was called with. */
  allowlists: (readonly string[])[];
  request(
    mode: RefreshMode,
    options?: { signal?: AbortSignal; bypass?: boolean },
  ): Promise<ProviderEntry>;
}

function setup(
  run: RunFn,
  options: {
    freshnessSeconds?: number;
    provider?: ProviderConfig;
    offline?: boolean;
    inventory?: readonly InventoryModel[];
    exposedFacets?: readonly FacetName[];
    credentials?: (provider: string) => Promise<ProviderCredentials | undefined>;
    available?: readonly string[];
    configured?: Record<string, ProviderConfig>;
    inventoryOf?: (provider: string) => readonly InventoryModel[];
    onChanged?: (provider: string) => void;
    /** The adapter's credential variable, which makes it a tool provider. */
    toolVariable?: string;
    /** The environment the refresher reads; unset by default. */
    environment?: (variable: string) => string | undefined;
  } = {},
): Harness {
  const time = new FakeTime();
  const adapter = makeAdapter(
    run,
    options.freshnessSeconds,
    options.exposedFacets,
    options.toolVariable,
  );
  const changes: string[] = [];
  const live = { value: true };
  const allowlists: (readonly string[])[] = [];
  const config: LoadedConfiguration = {
    path: "/none",
    providers: {
      ...options.configured,
      ...(options.provider === undefined ? {} : { anthropic: options.provider }),
    },
    severity: { low: 75, critical: 90 },
    statusLine: true,
    offline: options.offline ?? false,
    diagnostics: [],
  };
  const refresher = createRefresher({
    adapters: new Map([["anthropic", adapter]]),
    clock: time.clock,
    timers: time.timerApi,
    configuration: config,
    host: () =>
      live.value
        ? {
            inventory:
              options.inventoryOf ??
              ((provider) => (provider === "anthropic" ? (options.inventory ?? [MODEL]) : [])),
            availableProviders: () => options.available ?? ["anthropic"],
            credentials: options.credentials ?? (async () => KEY),
          }
        : undefined,
    environment: options.environment ?? (() => undefined),
    transportFor: (allowlist) => {
      allowlists.push(allowlist);
      return TRANSPORT;
    },
    commandRunner: async () => ({ reason: "internal" }),
    onChanged:
      options.onChanged ??
      ((provider) => {
        changes.push(provider);
      }),
  });
  return {
    time,
    refresher,
    adapter,
    changes,
    live,
    config,
    allowlists,
    request: (mode, requestOptions) => refresher.request("anthropic", mode, requestOptions),
  };
}

/** Marks a promise's settlement without awaiting it. */
function track<T>(promise: Promise<T>): { settled: boolean; value?: T } {
  const state: { settled: boolean; value?: T } = { settled: false };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

// ---------------------------------------------------------------- modes and freshness

test("cached mode never runs the adapter and reports not-collected", async () => {
  const h = setup(() => ok());
  const entry = await h.request("cached");
  assert.equal(h.adapter.calls, 0);
  assert.equal(entry.status, "not-collected");
  assert.equal((await h.refresher.request("anthropic")).status, "not-collected");
  assert.equal(h.adapter.calls, 0);
});

test("auto without capture refreshes, serves the capture, emits one change", async () => {
  const h = setup(() => ok("max"));
  const entry = await h.request("auto");
  assert.equal(h.adapter.calls, 1);
  assert.equal(entry.status, "ok");
  assert.deepEqual(entry.plan, { state: "known", value: "max" });
  assert.equal(entry.capturedAt, START);
  assert.deepEqual(h.changes, ["anthropic"]);
  assert.equal(h.time.pending, 0);
});

test("capturedAt is the result's when given, else the completion time", async () => {
  const done = deferred<AdapterResult>();
  const h = setup(() => done.promise);
  const pending = h.request("auto");
  await h.time.advance(5 * SECOND);
  done.resolve(ok());
  assert.equal((await pending).capturedAt, START + 5 * SECOND);

  const h2 = setup(() => ok("pro", { capturedAt: START - 1000 }));
  assert.equal((await h2.request("auto")).capturedAt, START - 1000);
});

test("auto: fresh until exactly capturedAt + freshness period", async () => {
  const h = setup(() => ok(), { freshnessSeconds: 300 });
  await h.request("auto");
  await h.time.advance(300 * SECOND - 1);
  const fresh = await h.request("auto");
  assert.equal(h.adapter.calls, 1);
  assert.equal(fresh.stale, false);
  await h.time.advance(1);
  const entry = await h.request("auto");
  assert.equal(h.adapter.calls, 2);
  assert.equal(entry.capturedAt, START + 300 * SECOND);
});

test("ttlSeconds replaces the adapter's freshness period", async () => {
  const h = setup(() => ok(), { freshnessSeconds: 300, provider: { ttlSeconds: 100 } });
  await h.request("auto");
  await h.time.advance(100 * SECOND - 1);
  await h.request("auto");
  assert.equal(h.adapter.calls, 1);
  await h.time.advance(1);
  await h.request("auto");
  assert.equal(h.adapter.calls, 2);
});

test("a stale capture is served by cached mode with stale true", async () => {
  const h = setup(() => ok(), { freshnessSeconds: 60 });
  await h.request("auto");
  await h.time.advance(60 * SECOND);
  const entry = await h.request("cached");
  assert.equal(h.adapter.calls, 1);
  assert.equal(entry.status, "ok");
  assert.equal(entry.stale, true);
});

test("serving age: served below max(3600 s, freshness), not at it", async () => {
  const h = setup(() => ok(), { freshnessSeconds: 60 });
  await h.request("auto");
  await h.time.advance(3600 * SECOND - 1);
  assert.equal((await h.request("cached")).status, "ok");
  await h.time.advance(1);
  assert.equal((await h.request("cached")).status, "not-collected");

  const long = setup(() => ok(), { freshnessSeconds: 7200 });
  await long.request("auto");
  await long.time.advance(7200 * SECOND - 1);
  assert.equal((await long.request("cached")).status, "ok");
  await long.time.advance(1);
  assert.equal((await long.request("cached")).status, "not-collected");
});

test("refresh mode runs regardless of freshness", async () => {
  const h = setup(() => ok());
  await h.request("auto");
  await h.time.advance(MINIMUM_INTERVAL_MS);
  await h.request("refresh");
  assert.equal(h.adapter.calls, 2);
});

// ---------------------------------------------------------------- single-flight and abort

test("callers arriving during one run share it", async () => {
  const done = deferred<AdapterResult>();
  const h = setup(() => done.promise);
  const first = h.request("auto");
  const second = h.request("auto");
  const third = h.request("refresh", { bypass: true });
  await flush();
  assert.equal(h.adapter.calls, 1);
  done.resolve(ok("shared"));
  const entries = await Promise.all([first, second, third]);
  assert.equal(h.adapter.calls, 1);
  for (const entry of entries) assert.deepEqual(entry.plan, { state: "known", value: "shared" });
  assert.deepEqual(h.changes, ["anthropic"]);
  assert.notEqual(entries[0], entries[1]);
});

test("a caller whose signal aborts stops waiting; the shared run goes on", async () => {
  const done = deferred<AdapterResult>();
  const h = setup(() => done.promise);
  const controller = new AbortController();
  const aborting = h.request("auto", { signal: controller.signal });
  const staying = h.request("auto");
  const stayingState = track(staying);
  const abortingState = track(aborting);
  await flush();
  assert.equal(abortingState.settled, false);
  controller.abort();
  await flush();
  assert.equal(abortingState.settled, true);
  assert.equal(abortingState.value?.status, "not-collected");
  assert.equal(stayingState.settled, false);
  assert.equal(h.adapter.signals[0]?.aborted, false);
  done.resolve(ok());
  assert.equal((await staying).status, "ok");
  assert.equal(h.adapter.calls, 1);
  assert.equal(h.adapter.signals[0]?.aborted, false);
  assert.deepEqual(h.changes, ["anthropic"]);
});

test("the sole requester aborting does not cancel the run, which still records", async () => {
  const done = deferred<AdapterResult>();
  const h = setup(() => done.promise);
  const controller = new AbortController();
  const pending = h.request("auto", { signal: controller.signal });
  await flush();
  controller.abort();
  await pending;
  assert.equal(h.adapter.signals[0]?.aborted, false);
  done.resolve(ok());
  await flush();
  assert.equal((await h.request("cached")).status, "ok");
  assert.deepEqual(h.changes, ["anthropic"]);
});

test("a joiner that aborts leaves no listener behind after the run", async () => {
  const done = deferred<AdapterResult>();
  const h = setup(() => done.promise);
  const controller = new AbortController();
  const pending = h.request("auto", { signal: controller.signal });
  done.resolve(ok());
  assert.equal((await pending).status, "ok");
  controller.abort();
  await flush();
  assert.equal(h.adapter.calls, 1);
});

test("an already aborted signal starts nothing", async () => {
  const h = setup(() => ok());
  const entry = await h.request("refresh", { signal: AbortSignal.abort() });
  assert.equal(h.adapter.calls, 0);
  assert.equal(entry.status, "not-collected");
});

// ---------------------------------------------------------------- suppression

test("minimum interval: not-auto requests suppressed until exactly 30 s after start", async () => {
  const h = setup(() => ok());
  await h.request("refresh");
  await h.time.advance(MINIMUM_INTERVAL_MS - 1);
  const suppressed = await h.request("refresh");
  assert.equal(h.adapter.calls, 1);
  assert.equal(suppressed.status, "ok");
  assert.equal(h.changes.length, 1);
  await h.time.advance(1);
  await h.request("refresh");
  assert.equal(h.adapter.calls, 2);
});

test("minimum interval counts from the start, not the completion", async () => {
  const done = deferred<AdapterResult>();
  const h = setup((call) => (call === 1 ? done.promise : ok()));
  const first = h.request("refresh");
  await h.time.advance(10 * SECOND);
  done.resolve(ok());
  await first;
  await h.time.advance(MINIMUM_INTERVAL_MS - 10 * SECOND - 1);
  await h.request("refresh");
  assert.equal(h.adapter.calls, 1);
  await h.time.advance(1);
  await h.request("refresh");
  assert.equal(h.adapter.calls, 2);
});

test("auto ignores the minimum interval", async () => {
  const h = setup(() => ok(), { freshnessSeconds: 10 });
  await h.request("auto");
  await h.time.advance(10 * SECOND);
  await h.request("auto");
  assert.equal(h.adapter.calls, 2);
});

test("a bypassing refresh ignores the minimum interval and backoff", async () => {
  const h = setup((call) => (call === 1 ? fail("network") : ok()));
  await h.request("refresh");
  const entry = await h.request("refresh", { bypass: true });
  assert.equal(h.adapter.calls, 2);
  assert.equal(entry.status, "ok");
  assert.equal(entry.reason, null);
});

test("a suppressed request resolves at once with the current entry", async () => {
  const h = setup(() => fail("network"));
  await h.request("auto");
  const entry = await h.request("auto");
  assert.equal(h.adapter.calls, 1);
  assert.equal(entry.status, "unavailable");
  assert.equal(entry.reason, "network");
});

// ---------------------------------------------------------------- backoff

test("backoff doubles from 60 s up to the 3600 s cap, boundaries exact", async () => {
  const h = setup(() => fail("network"));
  const expected = [60, 120, 240, 480, 960, 1920, 3600, 3600];
  for (const [index, seconds] of expected.entries()) {
    await h.request("auto");
    assert.equal(h.adapter.calls, index + 1);
    await h.time.advance(seconds * SECOND - 1);
    await h.request("auto");
    assert.equal(h.adapter.calls, index + 1, `suppressed before backoff end, step ${index}`);
    await h.time.advance(1);
  }
  await h.request("auto");
  assert.equal(h.adapter.calls, expected.length + 1);
});

test("backoffSeconds: reasons, doubling, cap, retry-after clamp", () => {
  const long: ReasonCode[] = [
    "http-401",
    "http-403",
    "no-credentials",
    "unsupported-auth",
    "endpoint-mismatch",
    "gcloud-missing",
    "gcloud-unauthenticated",
    "project-unresolved",
  ];
  for (const reason of long) {
    assert.equal(backoffSeconds(reason, 1), 3600, reason);
    assert.equal(backoffSeconds(reason, 9), 3600, reason);
  }
  assert.equal(backoffSeconds("network", 1), 60);
  assert.equal(backoffSeconds("network", 2), 120);
  assert.equal(backoffSeconds("network", 7), 3600);
  assert.equal(backoffSeconds("network", 5000), BACKOFF_MAX_SECONDS);
  assert.equal(backoffSeconds("http-error", 3), 240);
  assert.equal(backoffSeconds("http-429", 4, 0), 60);
  assert.equal(backoffSeconds("http-429", 4, 59), 60);
  assert.equal(backoffSeconds("http-429", 4, 60), 60);
  assert.equal(backoffSeconds("http-429", 4, 61), 61);
  assert.equal(backoffSeconds("http-429", 4, 3600), 3600);
  assert.equal(backoffSeconds("http-429", 4, 3601), 3600);
  assert.equal(backoffSeconds("http-429", 1), 60);
  assert.equal(backoffSeconds("http-429", 3), 240);
  assert.equal(backoffSeconds("network", 2, 5), 120);
});

test("long-backoff reasons suppress for exactly 3600 s", async () => {
  const h = setup(() => fail("no-credentials"));
  await h.request("auto");
  await h.time.advance(3600 * SECOND - 1);
  await h.request("auto");
  assert.equal(h.adapter.calls, 1);
  await h.time.advance(1);
  await h.request("auto");
  assert.equal(h.adapter.calls, 2);
});

test("http-429 retry-after is clamped to 60–3600 s at both ends", async () => {
  const cases: [number | undefined, number][] = [
    [0, 60],
    [10, 60],
    [100, 100],
    [5000, 3600],
    [undefined, 60],
  ];
  for (const [retryAfter, seconds] of cases) {
    const h = setup(() => fail("http-429", retryAfter));
    await h.request("auto");
    await h.time.advance(seconds * SECOND - 1);
    await h.request("auto");
    assert.equal(h.adapter.calls, 1, `retryAfter ${retryAfter}`);
    await h.time.advance(1);
    await h.request("auto");
    assert.equal(h.adapter.calls, 2, `retryAfter ${retryAfter}`);
  }
});

test("a success resets failure, failure count, and backoff", async () => {
  const h = setup((call) => (call === 2 || call === 3 ? ok() : fail("network")));
  await h.request("auto"); // failure 1 → 60 s
  await h.time.advance(60 * SECOND);
  await h.request("auto"); // failure 2? no: call 2 is ok
  const entry = await h.request("cached");
  assert.equal(entry.status, "ok");
  assert.equal(entry.reason, null);
  await h.request("refresh", { bypass: true }); // call 3 ok
  assert.equal(h.adapter.calls, 3);
  await h.request("refresh", { bypass: true }); // call 4 fails: count restarts at 1 → 60 s
  assert.equal((await h.request("cached")).reason, "network");
  await h.time.advance(60 * SECOND - 1);
  await h.request("auto");
  assert.equal(h.adapter.calls, 4);
  await h.time.advance(1);
  await h.request("refresh");
  assert.equal(h.adapter.calls, 5);
});

test("failure after failure doubles; success in between restarts the sequence", async () => {
  const h = setup((call) => (call === 3 ? ok() : fail("network")));
  await h.request("auto"); // count 1 → 60
  await h.time.advance(60 * SECOND);
  await h.request("auto"); // count 2 → 120
  await h.time.advance(120 * SECOND - 1);
  await h.request("auto");
  assert.equal(h.adapter.calls, 2);
  await h.time.advance(1);
  await h.request("refresh", { bypass: true }); // call 3 success
  assert.equal((await h.request("cached")).reason, null);
  await h.request("refresh", { bypass: true }); // call 4 fail → 60
  await h.time.advance(60 * SECOND);
  await h.request("refresh");
  assert.equal(h.adapter.calls, 5);
});

test("a failure keeps the previous capture and records the failure", async () => {
  const h = setup((call) => (call === 1 ? ok("pro") : fail("http-error")), {
    freshnessSeconds: 60,
  });
  await h.request("auto");
  await h.time.advance(60 * SECOND);
  const entry = await h.request("auto");
  assert.equal(h.adapter.calls, 2);
  assert.equal(entry.status, "ok");
  assert.deepEqual(entry.plan, { state: "known", value: "pro" });
  assert.equal(entry.reason, "http-error");
  assert.equal(entry.capturedAt, START);
  assert.deepEqual(h.changes, ["anthropic", "anthropic"]);
});

// ---------------------------------------------------------------- outcome rules

test("a result with firstFailure and no known facet fails with firstFailure", async () => {
  const h = setup(() => ({
    facets: {},
    firstFailure: { reason: "http-429", retryAfter: 200 },
  }));
  const entry = await h.request("auto");
  assert.equal(entry.status, "unavailable");
  assert.equal(entry.reason, "http-429");
  await h.time.advance(200 * SECOND - 1);
  await h.request("auto");
  assert.equal(h.adapter.calls, 1);
  await h.time.advance(1);
  await h.request("auto");
  assert.equal(h.adapter.calls, 2);
});

test("a result without firstFailure and no known facet succeeds", async () => {
  const h = setup(() => ({ facets: { plan: { state: "unavailable", reason: "network" } } }));
  const entry = await h.request("auto");
  assert.equal(entry.status, "partial");
  assert.equal(entry.reason, "network");
  assert.equal(entry.capturedAt, START);
});

test("a result with firstFailure and a known facet succeeds and captures the facets", async () => {
  const h = setup(
    () => ({
      facets: {
        plan: { state: "known", value: "pro" },
        balance: { state: "unavailable", reason: "network" },
      },
      firstFailure: { reason: "network" },
    }),
    { exposedFacets: ["plan", "balance"] },
  );
  const entry = await h.request("auto");
  assert.equal(entry.status, "partial");
  assert.equal(entry.reason, "network");
  assert.deepEqual(entry.plan, { state: "known", value: "pro" });
  assert.deepEqual(entry.balance, { state: "unavailable", reason: "network" });
  assert.equal(entry.capturedAt, START);
});

test("a deepseek-style balance failure keeps limits known and balance unavailable", async () => {
  const h = setup(
    () => ({
      facets: {
        limits: { state: "known", value: [] },
        balance: { state: "unavailable", reason: "http-429" },
      },
      firstFailure: { reason: "http-429", retryAfter: 30 },
    }),
    { exposedFacets: ["limits", "balance"] },
  );
  const entry = await h.request("auto");
  assert.equal(entry.status, "partial");
  assert.equal(entry.reason, "http-429");
  assert.deepEqual(entry.limits, { state: "known", value: [] });
  assert.deepEqual(entry.balance, { state: "unavailable", reason: "http-429" });
  assert.equal(entry.capturedAt, START);
});

test("a success with capture reason records it and backs off by it", async () => {
  const h = setup(() => ok("pro", { captureReason: "http-401" }));
  const entry = await h.request("auto");
  assert.equal(entry.status, "ok");
  assert.equal(entry.reason, "http-401");
  await h.time.advance(3600 * SECOND - 1);
  await h.request("refresh");
  assert.equal(h.adapter.calls, 1);
  await h.time.advance(1);
  await h.request("refresh");
  assert.equal(h.adapter.calls, 2);
});

test("capture reasons count as failures for the doubling backoff", async () => {
  const h = setup(() => ok("pro", { captureReason: "network" }), { freshnessSeconds: 1 });
  await h.request("auto"); // 60
  await h.time.advance(60 * SECOND);
  await h.request("auto"); // 120
  await h.time.advance(120 * SECOND - 1);
  await h.request("auto");
  assert.equal(h.adapter.calls, 2);
  await h.time.advance(1);
  await h.request("auto");
  assert.equal(h.adapter.calls, 3);
});

test("a malformed result becomes internal", async () => {
  const results: unknown[] = [
    null,
    undefined,
    "x",
    42,
    {},
    { reason: "made-up" },
    { reason: 3 },
    { facets: {}, firstFailure: "x" },
    { facets: {}, captureReason: "made-up" },
    { facets: {}, firstFailure: { reason: "made-up" } },
  ];
  for (const result of results) {
    const h = setup(() => result as AdapterResult);
    const entry = await h.request("auto");
    assert.equal(entry.status, "unavailable", JSON.stringify(result));
    assert.equal(entry.reason, "internal", JSON.stringify(result));
  }
});

test("malformed facets fail the refresh with internal and are not cached", async () => {
  const h = setup(
    () =>
      ({
        facets: { limits: { state: "known", value: 5 }, plan: { state: "known", value: "p" } },
      }) as unknown as AdapterResult,
    { exposedFacets: ["plan", "limits"] },
  );
  const entry = await h.request("auto");
  assert.equal(entry.status, "unavailable");
  assert.equal(entry.reason, "internal");
  assert.equal(entry.capturedAt, null);
});

test("the adapter keeps no handle on cached data", async () => {
  const result = ok("pro") as { facets: { plan: { state: "known"; value: string } } };
  const h = setup(() => result as AdapterResult);
  await h.request("auto");
  result.facets.plan.value = "mutated";
  assert.deepEqual((await h.request("cached")).plan, { state: "known", value: "pro" });
});

// ---------------------------------------------------------------- untrusted adapters

test("an adapter that throws synchronously fails with internal", async () => {
  const h = setup(() => {
    throw new Error("secret-token");
  });
  const entry = await h.request("auto");
  assert.equal(entry.reason, "internal");
  assert.equal(JSON.stringify(entry).includes("secret-token"), false);
  assert.equal(h.time.pending, 0);
});

test("an adapter whose run throws before returning a promise fails with internal", async () => {
  const h = setup(() => ok());
  h.adapter.run = () => {
    throw new Error("boom");
  };
  assert.equal((await h.request("auto")).reason, "internal");
});

test("an adapter that rejects fails with internal", async () => {
  const h = setup(() => Promise.reject(new Error("nope")));
  const entry = await h.request("auto");
  assert.equal(entry.reason, "internal");
  assert.deepEqual(h.changes, ["anthropic"]);
});

test("an adapter that never settles fails with deadline at exactly 15 s", async () => {
  const h = setup(() => new Promise<AdapterResult>(() => {}));
  const pending = h.request("auto");
  const state = track(pending);
  await h.time.advance(REFRESH_DEADLINE_MS - 1);
  assert.equal(state.settled, false);
  assert.equal(h.adapter.signals[0]?.aborted, false);
  await h.time.advance(1);
  assert.equal(state.settled, true);
  assert.equal(state.value?.reason, "deadline");
  assert.equal(state.value?.status, "unavailable");
  assert.equal(h.adapter.signals[0]?.aborted, true);
  assert.equal(h.time.pending, 0);
  assert.deepEqual(h.changes, ["anthropic"]);
});

test("a result arriving after the deadline is ignored", async () => {
  const late = deferred<AdapterResult>();
  const h = setup(() => late.promise);
  const pending = h.request("auto");
  await h.time.advance(REFRESH_DEADLINE_MS);
  assert.equal((await pending).reason, "deadline");
  late.resolve(ok("late"));
  await flush();
  const entry = await h.request("cached");
  assert.equal(entry.reason, "deadline");
  assert.equal(entry.capturedAt, null);
  assert.equal(h.changes.length, 1);
});

test("a rejection after the deadline is swallowed", async () => {
  const late = deferred<AdapterResult>();
  const h = setup(() => late.promise);
  const pending = h.request("auto");
  await flush();
  await h.time.advance(REFRESH_DEADLINE_MS);
  await pending;
  late.reject(new Error("late"));
  await flush();
  assert.equal(h.changes.length, 1);
});

test("a result at the deadline boundary minus 1 ms is accepted", async () => {
  const done = deferred<AdapterResult>();
  const h = setup(() => done.promise);
  const pending = h.request("auto");
  await h.time.advance(REFRESH_DEADLINE_MS - 1);
  done.resolve(ok());
  assert.equal((await pending).status, "ok");
  assert.equal(h.time.pending, 0);
});

test("deadline failure backs off like other failures", async () => {
  const h = setup(() => new Promise<AdapterResult>(() => {}));
  const pending = h.request("auto");
  await flush();
  await h.time.advance(REFRESH_DEADLINE_MS);
  await pending;
  await h.time.advance(60 * SECOND - 1);
  await h.request("auto");
  assert.equal(h.adapter.calls, 1);
  await h.time.advance(1);
  const second = h.request("auto");
  await flush();
  assert.equal(h.adapter.calls, 2);
  await h.time.advance(REFRESH_DEADLINE_MS);
  await second;
});

test("the deadline is measured from each refresh's own start", async () => {
  const h = setup((call) => (call === 1 ? ok() : new Promise<AdapterResult>(() => {})), {
    freshnessSeconds: 1,
  });
  await h.request("auto");
  await h.time.advance(10 * SECOND);
  const pending = h.request("auto");
  const state = track(pending);
  await h.time.advance(REFRESH_DEADLINE_MS - 1);
  assert.equal(state.settled, false);
  await h.time.advance(1);
  assert.equal(state.settled, true);
});

test("waiters on a hung run all resolve at the deadline", async () => {
  const h = setup(() => new Promise<AdapterResult>(() => {}));
  const all = Promise.all([h.request("auto"), h.request("auto"), h.request("refresh")]);
  await flush();
  await h.time.advance(REFRESH_DEADLINE_MS);
  for (const entry of await all) assert.equal(entry.reason, "deadline");
  assert.equal(h.adapter.calls, 1);
});

// ---------------------------------------------------------------- offline

test("offline fails at once with offline, without running the adapter, no backoff", async () => {
  const h = setup(() => ok(), { offline: true });
  const entry = await h.request("auto");
  assert.equal(h.adapter.calls, 0);
  assert.equal(entry.status, "unavailable");
  assert.equal(entry.reason, "offline");
  assert.deepEqual(h.changes, ["anthropic"]);
  assert.equal(h.time.pending, 0);
  await h.request("auto");
  assert.equal(h.adapter.calls, 0);
  assert.equal(h.changes.length, 2);
});

test("offline applies to bypassing refreshes and keeps the previous capture", async () => {
  const h = setup(() => ok());
  await h.request("auto");
  h.config.offline = true;
  const entry = await h.request("refresh", { bypass: true });
  assert.equal(h.adapter.calls, 1);
  assert.equal(entry.reason, "offline");
  assert.equal(entry.status, "ok");
});

// ---------------------------------------------------------------- eligibility

test("providers without adapter, free, disabled, or without inventory never refresh", async () => {
  const none = setup(() => ok());
  const other = await none.refresher.request("other", "refresh");
  assert.equal(other.status, "unknown-provider");

  const free = setup(() => ok(), { provider: { free: true } });
  assert.equal((await free.request("refresh")).status, "free");
  assert.equal(free.adapter.calls, 0);

  const disabled = setup(() => ok(), { provider: { adapter: false } });
  assert.equal((await disabled.request("auto")).status, "no-adapter");
  assert.equal(disabled.adapter.calls, 0);

  const empty = setup(() => ok(), { inventory: [] });
  assert.equal((await empty.request("auto")).status, "unknown-provider");
  assert.equal(empty.adapter.calls, 0);
  assert.deepEqual([none.changes, free.changes, disabled.changes, empty.changes], [[], [], [], []]);
});

test("a tool provider refreshes without inventory models", async () => {
  const h = setup(() => ok(), {
    inventory: [],
    toolVariable: "PURSE_TEST_TOOL_KEY",
    environment: () => "tool-key",
  });
  const entry = await h.request("auto");
  assert.equal(h.adapter.calls, 1);
  assert.equal(entry.status, "ok");
  assert.deepEqual(entry.models, {});
  assert.deepEqual(h.changes, ["anthropic"]);
});

test("a tool provider without a credential value fails with no-credentials", async () => {
  for (const value of [undefined, ""]) {
    const h = setup(() => ok(), {
      inventory: [],
      toolVariable: "PURSE_TEST_TOOL_KEY",
      environment: () => value,
    });
    const entry = await h.request("auto");
    assert.equal(h.adapter.calls, 0);
    assert.equal(entry.status, "unavailable");
    assert.equal(entry.reason, "no-credentials");
  }
});

test("a tool provider skips the endpoint check", async () => {
  // The inventory model's origin is the non-tool adapter's, which a tool provider does not have.
  const h = setup(() => ok(), {
    inventory: [MODEL],
    toolVariable: "PURSE_TEST_TOOL_KEY",
    environment: () => "tool-key",
  });
  const entry = await h.request("auto");
  assert.equal(h.adapter.calls, 1);
  assert.equal(entry.status, "ok");
  assert.equal(entry.reason, null);
});

test("a tool provider's credentials are its variable's value, without oauth or baseUrl", async () => {
  const seen: unknown[] = [];
  const h = setup(
    async (_call, _signal, deps) => {
      seen.push(await deps.credentials());
      return ok();
    },
    {
      inventory: [],
      toolVariable: "PURSE_TEST_TOOL_KEY",
      environment: (variable) => (variable === "PURSE_TEST_TOOL_KEY" ? "tool-key" : undefined),
    },
  );
  await h.request("auto");
  assert.deepEqual(seen, [{ apiKey: "tool-key", oauth: false }]);
});

test("without live context no refresh starts and nothing is recorded", async () => {
  const h = setup(() => ok());
  h.live.value = false;
  const entry = await h.request("auto");
  assert.equal(h.adapter.calls, 0);
  assert.equal(entry.status, "unknown-provider");
  assert.equal(h.refresher.ready(), false);
  assert.deepEqual(h.refresher.knownProviders(), []);
  assert.deepEqual(h.changes, []);
  h.live.value = true;
  assert.equal(h.refresher.ready(), true);
  assert.equal((await h.request("refresh")).status, "ok");
  assert.equal(h.adapter.calls, 1);
});

test("a rejecting credential lookup fails the refresh with internal", async () => {
  const h = setup(() => ok(), {
    credentials: () => Promise.reject(new Error("context is stale")),
  });
  const entry = await h.request("auto");
  assert.equal(h.adapter.calls, 0);
  assert.equal(entry.reason, "internal");
});

test("a throwing change callback does not break the refresh", async () => {
  const h = setup(() => ok(), {
    onChanged: () => {
      throw new Error("listener");
    },
  });
  assert.equal((await h.request("auto")).status, "ok");
});

test("provider ids that are object prototype keys are unknown", async () => {
  const h = setup(() => ok());
  for (const id of ["constructor", "__proto__", "toString"]) {
    const entry = await h.refresher.request(id, "auto");
    assert.equal(entry.status, "unknown-provider");
  }
});

// ---------------------------------------------------------------- clear

test("clear discards the cache and the failure state", async () => {
  const h = setup((call) => (call === 1 ? fail("no-credentials") : ok()));
  await h.request("auto");
  h.refresher.clear();
  assert.equal((await h.request("cached")).status, "not-collected");
  assert.equal((await h.request("auto")).status, "ok");
  assert.equal(h.adapter.calls, 2);
});

test("clear aborts an in-flight run, releases waiters, records and emits nothing", async () => {
  const late = deferred<AdapterResult>();
  const h = setup(() => late.promise);
  const waiters = Promise.all([h.request("auto"), h.request("auto")]);
  await flush();
  h.refresher.clear();
  const entries = await waiters;
  for (const entry of entries) assert.equal(entry.status, "not-collected");
  assert.equal(h.adapter.signals[0]?.aborted, true);
  assert.equal(h.time.pending, 0);
  late.resolve(ok());
  await flush();
  assert.equal((await h.request("cached")).status, "not-collected");
  assert.deepEqual(h.changes, []);
});

test("a run started after clear is independent of the discarded one", async () => {
  const first = deferred<AdapterResult>();
  const h = setup((call) => (call === 1 ? first.promise : ok("second")));
  const old = h.request("auto");
  await flush();
  h.refresher.clear();
  await old;
  assert.deepEqual((await h.request("auto")).plan, { state: "known", value: "second" });
  first.resolve(ok("first"));
  await flush();
  assert.deepEqual((await h.request("cached")).plan, { state: "known", value: "second" });
  assert.equal(h.changes.length, 1);
});

// ---------------------------------------------------------------- entry

test("entry derives from the cache: severity override, models, no mutation sharing", async () => {
  const h = setup(() => ok());
  await h.request("auto");
  const a = h.refresher.entry("anthropic");
  const b = h.refresher.entry("anthropic");
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a.models), ["model-a"]);
  assert.equal(a.freshUntil, START + 300 * SECOND);
  assert.notEqual(a.models, b.models);
  assert.notEqual(a.plan, b.plan);
});

// ---------------------------------------------------------------- credential checks

const ORIGIN = "https://example.test";

test("checkCredentials: no-credentials for a missing or empty apiKey", () => {
  for (const credentials of [undefined, { oauth: true }, { apiKey: "", oauth: true }]) {
    assert.equal(checkCredentials(ORIGIN, credentials, [MODEL]), "no-credentials");
  }
});

test("checkCredentials: a present baseUrl alone decides the endpoint", () => {
  const mixed = [MODEL, { ...MODEL, id: "b", baseUrl: "https://other.test/v1" }];
  assert.deepEqual(checkCredentials(ORIGIN, { ...KEY, baseUrl: `${ORIGIN}/v2` }, mixed), {
    apiKey: "key-1",
    oauth: true,
  });
  assert.deepEqual(checkCredentials(ORIGIN, { ...KEY, baseUrl: "HTTPS://Example.Test." }, []), {
    apiKey: "key-1",
    oauth: true,
  });
  for (const baseUrl of [
    "",
    "not a url",
    "http://example.test",
    "https://example.test:8443",
    "https://user:pass@example.test",
    "https://example.test.evil.test",
  ]) {
    assert.equal(
      checkCredentials(ORIGIN, { ...KEY, baseUrl }, [MODEL]),
      "endpoint-mismatch",
      baseUrl,
    );
  }
});

test("checkCredentials: without baseUrl every inventory model has the provider origin", () => {
  assert.deepEqual(checkCredentials(ORIGIN, KEY, [MODEL, { ...MODEL, id: "b" }]), {
    apiKey: "key-1",
    oauth: true,
  });
  // An empty inventory has no model with a mismatched origin, so the check passes.
  assert.deepEqual(checkCredentials(ORIGIN, KEY, []), { apiKey: "key-1", oauth: true });
  assert.equal(
    checkCredentials(ORIGIN, KEY, [MODEL, { ...MODEL, baseUrl: "https://other.test" }]),
    "endpoint-mismatch",
  );
  assert.equal(
    checkCredentials(ORIGIN, KEY, [{ ...MODEL, baseUrl: "not a url" }]),
    "endpoint-mismatch",
  );
});

test("checkCredentials: a tool provider's absent provider origin skips the endpoint check", () => {
  assert.deepEqual(checkCredentials(undefined, { apiKey: "key-1", oauth: false }, [MODEL]), {
    apiKey: "key-1",
    oauth: false,
  });
  assert.deepEqual(
    checkCredentials(undefined, { apiKey: "key-1", oauth: false }, [
      { ...MODEL, baseUrl: "https://other.test" },
    ]),
    { apiKey: "key-1", oauth: false },
  );
  assert.equal(checkCredentials(undefined, { oauth: false }, [MODEL]), "no-credentials");
  assert.equal(checkCredentials(undefined, undefined, []), "no-credentials");
});

test("a failed check fails the refresh without running the adapter", async () => {
  const mismatch = setup(() => ok(), {
    credentials: async () => ({ ...KEY, baseUrl: "https://other.test" }),
  });
  const entry = await mismatch.request("auto");
  assert.equal(mismatch.adapter.calls, 0);
  assert.equal(entry.status, "unavailable");
  assert.equal(entry.reason, "endpoint-mismatch");
  await mismatch.time.advance(3600 * SECOND - 1);
  await mismatch.request("auto");
  assert.equal(mismatch.adapter.calls, 0);

  const missing = setup(() => ok(), { credentials: async () => ({ apiKey: "", oauth: false }) });
  assert.equal((await missing.request("auto")).reason, "no-credentials");
  assert.equal(missing.adapter.calls, 0);
});

// ---------------------------------------------------------------- dependencies

test("the adapter gets a transport bound once to its host allowlist", async () => {
  const h = setup(() => ok());
  await h.request("auto");
  await h.request("refresh", { bypass: true });
  assert.deepEqual(h.allowlists, [["https://example.test"]]);
  assert.equal(h.adapter.deps[0]?.transport, TRANSPORT);
  assert.equal(h.adapter.deps[1]?.transport, TRANSPORT);
});

test("credentials: the first call returns the checked ones, later calls check afresh", async () => {
  let answer: ProviderCredentials | undefined = KEY;
  const seen: unknown[] = [];
  const h = setup(
    async (_call, _signal, deps) => {
      seen.push(await deps.credentials());
      answer = { apiKey: "key-2", oauth: true };
      seen.push(await deps.credentials());
      answer = { ...KEY, baseUrl: "https://other.test" };
      seen.push(await deps.credentials());
      return ok();
    },
    { credentials: async () => answer },
  );
  await h.request("auto");
  assert.deepEqual(seen, [
    { apiKey: "key-1", oauth: true },
    { apiKey: "key-2", oauth: true },
    undefined,
  ]);
});

test("the store persists across refreshes, expires, and is discarded by clear", async () => {
  const reads: unknown[] = [];
  const h = setup((call, _signal, deps) => {
    reads.push(deps.store.get("k"), deps.store.get("t"));
    if (call === 1) {
      deps.store.set("k", "kept");
      deps.store.set("t", "short", 10);
    }
    return ok();
  });
  await h.request("auto");
  await h.time.advance(MINIMUM_INTERVAL_MS);
  await h.request("refresh");
  await h.time.advance(MINIMUM_INTERVAL_MS);
  h.refresher.clear();
  await h.request("refresh");
  assert.deepEqual(reads, [undefined, undefined, "kept", undefined, undefined, undefined]);
});

test("recorded header observations reach their provider's adapter only", async () => {
  const seen: unknown[] = [];
  const h = setup((_call, _signal, deps) => {
    seen.push(deps.observations.latest());
    return ok();
  });
  const observation = {
    observedAt: START,
    fiveHour: { percent: 5, resetsAt: null },
    weekly: { percent: null, resetsAt: null },
  };
  h.refresher.recordObservation("other", observation);
  await h.request("auto");
  h.refresher.recordObservation("anthropic", observation);
  await h.time.advance(MINIMUM_INTERVAL_MS);
  await h.request("refresh");
  h.refresher.clear();
  await h.request("refresh");
  assert.deepEqual(seen, [undefined, observation, undefined]);
  assert.deepEqual(h.changes, ["anthropic", "anthropic", "anthropic"]);
});

test("a header observation recorded after last start makes the capture not fresh", async () => {
  let runs = 0;
  const h = setup(() => {
    runs += 1;
    return ok();
  });
  await h.request("auto");
  await h.time.advance(1000);
  await h.request("auto");
  assert.equal(runs, 1);
  h.refresher.recordObservation("anthropic", {});
  await h.time.advance(1000);
  await h.request("auto");
  assert.equal(runs, 2);
  await h.time.advance(1000);
  await h.request("auto");
  assert.equal(runs, 2);
});

test("knownProviders: available providers plus free ones with models, sorted", () => {
  const h = setup(() => ok(), {
    available: ["zai", "anthropic", "zai", "Zeta"],
    configured: { local: { free: true }, ghost: { free: true }, deepseek: { lowBalance: 1 } },
    inventoryOf: (provider) => (provider === "local" || provider === "anthropic" ? [MODEL] : []),
  });
  assert.deepEqual(h.refresher.knownProviders(), ["Zeta", "anthropic", "local", "zai"]);
});

test("knownProviders: a tool provider whose credential variable is non-empty, read each use", () => {
  const values = new Map<string, string | undefined>();
  const h = setup(() => ok(), {
    available: [],
    toolVariable: "PURSE_TEST_TOOL_KEY",
    environment: (variable) => values.get(variable),
  });
  assert.deepEqual(h.refresher.knownProviders(), [], "an unset variable names no provider");

  values.set("PURSE_TEST_TOOL_KEY", "");
  assert.deepEqual(h.refresher.knownProviders(), [], "an empty variable names no provider");

  values.set("PURSE_TEST_TOOL_KEY", "tool-key");
  assert.deepEqual(h.refresher.knownProviders(), ["anthropic"]);

  h.live.value = false;
  assert.deepEqual(h.refresher.knownProviders(), [], "no live context, no known providers");
});

// ---------------------------------------------------------------- capture reasons

test("a success with a capture reason replaces an older recorded failure", async () => {
  const h = setup((call) =>
    call === 1 ? fail("network") : ok("pro", { captureReason: "http-401" }),
  );
  assert.equal((await h.request("auto")).reason, "network");
  await h.time.advance(60 * SECOND);
  const entry = await h.request("auto");
  assert.equal(entry.status, "ok");
  assert.equal(entry.reason, "http-401");
});

test("a capture reason that is the first failure takes its retryAfter", async () => {
  const h = setup(() =>
    ok("pro", {
      firstFailure: { reason: "http-429", retryAfter: 600 },
      captureReason: "http-429",
    }),
  );
  await h.request("auto");
  await h.time.advance(600 * SECOND - 1);
  await h.request("refresh");
  assert.equal(h.adapter.calls, 1);
  await h.time.advance(1);
  await h.request("refresh");
  assert.equal(h.adapter.calls, 2);
});

// ---------------------------------------------------------------- offline failure accounting

test("an offline failure records the failure but leaves count and backoff untouched", async () => {
  const h = setup(() => fail("network"));
  await h.request("auto"); // count 1, backoff 60 s
  await h.time.advance(60 * SECOND);
  await h.request("auto"); // count 2, backoff 120 s
  h.config.offline = true;
  const offline = await h.request("auto", { bypass: true });
  assert.equal(offline.reason, "offline");
  h.config.offline = false;
  // Backoff end unchanged: still in the future, so the request is suppressed.
  await h.request("auto");
  assert.equal(h.adapter.calls, 2, "still in backoff from the second failure");
  // Failure count unchanged: the next network failure backs off 240 s (count 3), not 480 s.
  await h.time.advance(120 * SECOND);
  await h.request("auto"); // count 3, backoff 240 s
  await h.time.advance(240 * SECOND - 1);
  await h.request("auto");
  assert.equal(h.adapter.calls, 3, "suppressed before the 240 s backoff end");
  await h.time.advance(1);
  await h.request("auto");
  assert.equal(h.adapter.calls, 4);
});
