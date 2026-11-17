import assert from "node:assert/strict";
import { test } from "node:test";
import {
  QUERY_CHANNEL,
  createQueryHandler,
  type QueryHandler,
  type QueryReply,
} from "../lib/protocol.ts";
import type { Refresher, RefreshMode, RequestOptions, Timers } from "../lib/refresh.ts";
import type { Price, ProviderEntry } from "../lib/state.ts";

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

const PRICE: Price = {
  rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  tiers: [],
  source: "inventory",
  schedule: null,
};

function makeEntry(provider: string, plan = "pro"): ProviderEntry {
  return {
    provider,
    status: "ok",
    reason: null,
    adapter: provider,
    capturedAt: START,
    freshUntil: START + 300 * SECOND,
    stale: false,
    severity: "ok",
    plan: { state: "known", value: plan },
    balance: { state: "not-exposed" },
    limits: { state: "not-exposed" },
    models: { [provider + "-model"]: { price: PRICE, severity: "ok" } },
  };
}

interface Call {
  provider: string;
  mode: RefreshMode | undefined;
  signal: AbortSignal | undefined;
  bypass: boolean | undefined;
}

/** A refresher whose `request` either answers at once or waits for the test. */
class FakeRefresher implements Refresher {
  readyValue = true;
  providers: string[] = ["alpha", "beta"];
  entries = new Map<string, ProviderEntry>();
  calls: Call[] = [];
  entryCalls: string[] = [];
  /** When set, `request` stays pending until the test settles it. */
  hold = false;
  pending: { provider: string; deferred: Deferred<ProviderEntry> }[] = [];

  ready(): boolean {
    return this.readyValue;
  }

  knownProviders(): string[] {
    return [...this.providers];
  }

  recordObservation(_provider: string, _observation: unknown): void {}

  entry(provider: string): ProviderEntry {
    this.entryCalls.push(provider);
    return this.entries.get(provider) ?? makeEntry(provider);
  }

  request(provider: string, mode?: RefreshMode, options?: RequestOptions): Promise<ProviderEntry> {
    this.calls.push({
      provider,
      mode,
      signal: options?.signal,
      bypass: options?.bypass,
    });
    if (!this.hold) return Promise.resolve(this.entry(provider));
    const waiting = deferred<ProviderEntry>();
    this.pending.push({ provider, deferred: waiting });
    return waiting.promise;
  }

  clear(): void {}

  settle(provider: string, value?: ProviderEntry): void {
    const index = this.pending.findIndex((item) => item.provider === provider);
    assert.notEqual(index, -1, `no pending request for ${provider}`);
    const [item] = this.pending.splice(index, 1);
    assert.ok(item !== undefined);
    item.deferred.resolve(value ?? this.entries.get(provider) ?? makeEntry(provider));
  }

  settleAll(): void {
    for (const item of this.pending.splice(0)) {
      item.deferred.resolve(this.entries.get(item.provider) ?? makeEntry(item.provider));
    }
  }

  fail(provider: string, error: unknown): void {
    const index = this.pending.findIndex((item) => item.provider === provider);
    const [item] = this.pending.splice(index, 1);
    assert.ok(item !== undefined);
    item.deferred.reject(error);
  }
}

/** One consumer's view of the offer: call count, the promise it took, and its outcome. */
class Session {
  calls = 0;
  offered: Promise<QueryReply> | null = null;
  settled = false;
  value: QueryReply | null = null;
  rejected = false;
  readonly respond = (reply: Promise<QueryReply>): boolean => {
    this.calls += 1;
    if (this.offered !== null) return false;
    this.offered = reply;
    void reply.then(
      (value) => {
        this.settled = true;
        this.value = value;
      },
      () => {
        this.settled = true;
        this.rejected = true;
      },
    );
    return true;
  };
  get reply(): QueryReply {
    assert.ok(this.value !== null);
    return this.value;
  }
}

/** Captures the offered promise from outside the reply's lifetime. */
class Offer {
  current: Promise<QueryReply> | null = null;
  readonly respond = (reply: Promise<QueryReply>): boolean => {
    this.current = reply;
    return true;
  };
  async reply(): Promise<QueryReply> {
    const offered = this.current;
    assert.ok(offered !== null);
    return await offered;
  }
}

interface Harness {
  refresher: FakeRefresher;
  time: FakeTime;
  handler: QueryHandler;
}

function setup(options: { hold?: boolean; providers?: string[]; ready?: boolean } = {}): Harness {
  const time = new FakeTime();
  const refresher = new FakeRefresher();
  if (options.hold === true) refresher.hold = true;
  if (options.providers !== undefined) refresher.providers = [...options.providers];
  if (options.ready !== undefined) refresher.readyValue = options.ready;
  const handler = createQueryHandler({ refresher, clock: time.clock, timers: time.timerApi });
  return { refresher, time, handler };
}

test("the channel is the spec's", () => {
  assert.equal(QUERY_CHANNEL, "purse:query:v1");
});

test("a payload that is not an object is ignored", async () => {
  const payloads: unknown[] = [
    undefined,
    null,
    0,
    1.5,
    "",
    "purse:query:v1",
    true,
    Symbol("request"),
    [],
    {},
  ];
  for (const payload of payloads) {
    const { handler, refresher, time } = setup();
    assert.doesNotThrow(() => handler(payload));
    await flush();
    assert.equal(refresher.calls.length, 0);
    assert.equal(time.pending, 0);
  }
});

test("a payload whose respond is not a function is ignored", async () => {
  const payloads: unknown[] = [
    { respond: 1 },
    { respond: "respond" },
    { respond: null },
    { respond: {} },
    { providers: ["alpha"] },
    { providers: ["alpha"], mode: "auto" },
  ];
  for (const payload of payloads) {
    const { handler, refresher, time } = setup();
    assert.doesNotThrow(() => handler(payload));
    await flush();
    assert.equal(refresher.calls.length, 0);
    assert.equal(time.pending, 0);
  }
});

test("a payload whose respond getter throws is ignored", async () => {
  const { handler, refresher } = setup();
  const payload = new Proxy(
    {},
    {
      get(target, key, receiver) {
        if (key === "respond") throw new Error("hostile getter");
        return Reflect.get(target, key, receiver);
      },
    },
  );
  assert.doesNotThrow(() => handler(payload));
  await flush();
  assert.equal(refresher.calls.length, 0);
});

test("the offer is one synchronous call with the reply promise", async () => {
  const { handler, refresher } = setup();
  const session = new Session();
  handler({ providers: ["alpha"], respond: session.respond });
  assert.equal(session.calls, 1);
  assert.ok(session.offered instanceof Promise);
  assert.equal(session.settled, false);
  await flush();
  assert.equal(session.settled, true);
  assert.equal(session.rejected, false);
  assert.equal(session.value?.status, "ok");
  assert.equal(session.calls, 1);
  assert.equal(refresher.calls.length, 1);
  assert.equal(refresher.calls[0]?.mode, "cached");
});

test("the reply is a fresh JSON-compatible object", async () => {
  const { handler, time } = setup();
  const session = new Session();
  handler({ providers: ["alpha", "beta"], respond: session.respond });
  await flush();
  const reply = session.reply;
  assert.equal(reply.protocol, 1);
  assert.equal(reply.generatedAt, time.now);
  assert.equal(Object.getPrototypeOf(reply.providers), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(reply)), reply);
  assert.deepEqual(Object.keys(reply.providers).toSorted(), ["alpha", "beta"]);
});

test("bad-request: a field violates Section 2", async () => {
  const invalid: { name: string; fields: Record<string, unknown> }[] = [
    { name: "providers is a string", fields: { providers: "alpha" } },
    { name: "providers is a number", fields: { providers: 1 } },
    { name: "providers is null", fields: { providers: null } },
    { name: "providers is an object", fields: { providers: { alpha: true } } },
    { name: "providers holds a number", fields: { providers: ["alpha", 1] } },
    { name: "providers holds null", fields: { providers: [null] } },
    { name: "providers holds undefined", fields: { providers: [undefined] } },
    { name: "maxWaitMs is a string", fields: { maxWaitMs: "10" } },
    { name: "maxWaitMs is null", fields: { maxWaitMs: null } },
    { name: "maxWaitMs is negative", fields: { maxWaitMs: -1 } },
    { name: "maxWaitMs is NaN", fields: { maxWaitMs: Number.NaN } },
    { name: "maxWaitMs is infinite", fields: { maxWaitMs: Number.POSITIVE_INFINITY } },
    { name: "mode is uppercase", fields: { mode: "CACHED" } },
    { name: "mode is empty", fields: { mode: "" } },
    { name: "mode is null", fields: { mode: null } },
    { name: "mode is a number", fields: { mode: 1 } },
    { name: "mode is a boolean", fields: { mode: true } },
    { name: "mode is an array", fields: { mode: ["cached"] } },
    { name: "signal is a string", fields: { signal: "signal" } },
    { name: "signal is a number", fields: { signal: 1 } },
    { name: "signal is null", fields: { signal: null } },
    { name: "signal has no listeners", fields: { signal: { aborted: false } } },
    {
      name: "signal has a non-boolean aborted",
      fields: {
        signal: { aborted: "no", addEventListener() {}, removeEventListener() {} },
      },
    },
  ];
  for (const item of invalid) {
    const { handler, refresher, time } = setup();
    const session = new Session();
    handler({ ...item.fields, respond: session.respond });
    assert.equal(session.calls, 1, item.name);
    await flush();
    assert.equal(session.rejected, false, item.name);
    assert.equal(session.value?.status, "bad-request", item.name);
    assert.deepEqual(session.value?.providers, {}, item.name);
    assert.equal(session.value?.generatedAt, time.now, item.name);
    assert.equal(refresher.calls.length, 0, item.name);
    assert.equal(refresher.entryCalls.length, 0, item.name);
    assert.equal(time.pending, 0, item.name);
  }
});

test("a provider id at the length and character boundaries is accepted", async () => {
  const { handler } = setup();
  const ids = ["a", "A", "0", "a.b_c-d~9", "Z" + "x".repeat(127)];
  const session = new Session();
  handler({ providers: ids, respond: session.respond });
  await flush();
  assert.equal(session.value?.status, "ok");
  assert.deepEqual(Object.keys(session.reply.providers).toSorted(), [...ids].toSorted());
  assert.equal(Object.keys(session.reply.providers).length, ids.length);
});

test("unknown request fields are ignored", async () => {
  const { handler } = setup();
  const session = new Session();
  handler({ providers: ["alpha"], extra: 42, nested: { mode: "bogus" }, respond: session.respond });
  await flush();
  assert.equal(session.value?.status, "ok");
});

test("bad-request comes before not-ready and before cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const { handler, refresher } = setup({ ready: false });
  const session = new Session();
  handler({
    providers: ["alpha"],
    mode: "bogus",
    signal: controller.signal,
    respond: session.respond,
  });
  await flush();
  assert.equal(session.value?.status, "bad-request");
  assert.equal(refresher.calls.length, 0);
});

test("not-ready: no live context", async () => {
  const { handler, refresher, time } = setup({ ready: false });
  for (const fields of [{}, { providers: ["alpha"] }, { providers: [] }]) {
    const session = new Session();
    handler({ ...fields, respond: session.respond });
    await flush();
    assert.equal(session.value?.status, "not-ready");
    assert.deepEqual(session.value?.providers, {});
    assert.equal(session.value?.generatedAt, time.now);
    assert.equal(refresher.calls.length, 0);
    assert.equal(time.pending, 0);
  }
});

test("not-ready comes before cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const { handler, refresher } = setup({ ready: false });
  const session = new Session();
  handler({ providers: ["alpha"], signal: controller.signal, respond: session.respond });
  await flush();
  assert.equal(session.value?.status, "not-ready");
  assert.equal(refresher.calls.length, 0);
});

test("ok: requested providers are served concurrently", async () => {
  const { handler, refresher } = setup();
  refresher.entries.set("alpha", makeEntry("alpha", "team"));
  const session = new Session();
  handler({ providers: ["beta", "alpha"], respond: session.respond });
  assert.deepEqual(
    refresher.calls.map((call) => call.provider),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    refresher.calls.map((call) => call.mode),
    ["cached", "cached"],
  );
  assert.deepEqual(
    refresher.calls.map((call) => call.bypass),
    [undefined, undefined],
  );
  await flush();
  assert.equal(session.value?.status, "ok");
  assert.deepEqual(Object.keys(session.reply.providers).toSorted(), ["alpha", "beta"]);
  assert.deepEqual(session.reply.providers.alpha, makeEntry("alpha", "team"));
});

test("ok: omitted providers are the known providers", async () => {
  const { handler, refresher } = setup({ providers: ["zeta", "alpha"] });
  const session = new Session();
  handler({ respond: session.respond });
  await flush();
  assert.equal(session.value?.status, "ok");
  assert.deepEqual(Object.keys(session.reply.providers).toSorted(), ["alpha", "zeta"]);
  assert.deepEqual(
    refresher.calls.map((call) => call.provider),
    ["alpha", "zeta"],
  );
});

test("ok: an empty provider list requests nothing", async () => {
  const { handler, refresher, time } = setup({ hold: true });
  const session = new Session();
  handler({ providers: [], respond: session.respond });
  await flush();
  assert.equal(session.value?.status, "ok");
  assert.deepEqual(session.value?.providers, {});
  assert.equal(refresher.calls.length, 0);
  assert.equal(refresher.entryCalls.length, 0);
  assert.equal(time.pending, 0);
});

test("ok: duplicates collapse", async () => {
  const { handler, refresher } = setup();
  const session = new Session();
  handler({ providers: ["beta", "alpha", "beta"], respond: session.respond });
  await flush();
  assert.deepEqual(Object.keys(session.reply.providers).toSorted(), ["alpha", "beta"]);
  assert.equal(refresher.calls.length, 2);
});

test("ok: a provider with no configured entry still gets an entry", async () => {
  const { handler } = setup({ providers: [] });
  const session = new Session();
  handler({ providers: ["ghost"], respond: session.respond });
  await flush();
  assert.equal(session.value?.status, "ok");
  assert.deepEqual(session.reply.providers.ghost, makeEntry("ghost"));
});

test("every mode is forwarded to the refresher", async () => {
  for (const mode of ["cached", "auto", "refresh"] as const) {
    const { handler, refresher } = setup();
    const session = new Session();
    handler({ providers: ["alpha"], mode, respond: session.respond });
    await flush();
    assert.equal(session.value?.status, "ok", mode);
    assert.equal(refresher.calls[0]?.mode, mode);
  }
});

test("cached is the default mode and bypass is never requested", async () => {
  const { handler, refresher } = setup();
  const session = new Session();
  handler({ providers: ["alpha"], respond: session.respond });
  await flush();
  assert.equal(refresher.calls[0]?.mode, "cached");
  assert.equal(refresher.calls[0]?.bypass, undefined);
});

test("the refresher gets purse's own signal, aborted with the request's", async () => {
  const { handler, refresher } = setup({ hold: true });
  const controller = new AbortController();
  const session = new Session();
  handler({ providers: ["alpha"], signal: controller.signal, respond: session.respond });
  const forwarded = refresher.calls[0]?.signal;
  assert.ok(forwarded instanceof AbortSignal);
  assert.notEqual(forwarded, controller.signal);
  assert.equal(forwarded.aborted, false);
  controller.abort();
  await flush();
  assert.equal(session.value?.status, "cancelled");
  assert.equal(forwarded.aborted, true);
});

test("a structural signal object never reaches the refresher", async () => {
  const { handler, refresher } = setup({ hold: true });
  let listener: (() => void) | null = null;
  const signal = {
    aborted: false,
    addEventListener(_type: string, callback: () => void) {
      listener = callback;
    },
    removeEventListener() {},
  };
  const session = new Session();
  handler({ providers: ["alpha"], signal, respond: session.respond });
  assert.ok(refresher.calls[0]?.signal instanceof AbortSignal);
  assert.ok(listener !== null);
  (listener as () => void)();
  await flush();
  assert.equal(session.value?.status, "cancelled");
});

test("a field whose value is undefined is omitted", async () => {
  const { handler, refresher } = setup();
  const session = new Session();
  handler({ providers: undefined, mode: undefined, signal: undefined, respond: session.respond });
  await flush();
  assert.equal(session.value?.status, "ok");
  assert.deepEqual(Object.keys(session.reply.providers).toSorted(), ["alpha", "beta"]);
  assert.deepEqual(
    refresher.calls.map((call) => [call.mode, call.signal]),
    [
      ["cached", undefined],
      ["cached", undefined],
    ],
  );
});

test("a non-accepting offer calls no method of the signal", async () => {
  const { handler, refresher, time } = setup({ hold: true });
  const methodCalls: string[] = [];
  const signal = {
    aborted: false,
    addEventListener() {
      methodCalls.push("add");
    },
    removeEventListener() {
      methodCalls.push("remove");
    },
  };
  const offer = new Offer();
  handler({
    providers: ["alpha"],
    mode: "refresh",
    signal,
    respond: (reply: Promise<QueryReply>) => {
      offer.respond(reply);
      return false;
    },
  });
  await flush();
  assert.deepEqual(methodCalls, []);
  assert.equal(refresher.calls.length, 0);
  assert.equal(time.pending, 0);
  assert.equal((await offer.reply()).status, "ok");
});

test("entries are cloned: a reply shares no state with the refresher", async () => {
  const { handler, refresher } = setup();
  const entry = makeEntry("alpha", "team");
  refresher.entries.set("alpha", entry);
  const session = new Session();
  handler({ providers: ["alpha"], respond: session.respond });
  await flush();
  const served = session.reply.providers.alpha;
  assert.deepEqual(served, entry);
  assert.notEqual(served, entry);
  assert.ok(served !== undefined && served.plan.state === "known");
  assert.ok(served.plan.value === "team");
  assert.notEqual(served.plan, entry.plan);
  served.plan.value = "mutated";
  served.models = {};
  assert.deepEqual(entry.plan, { state: "known", value: "team" });
  assert.deepEqual(Object.keys(entry.models), ["alpha-model"]);
  assert.equal(entry.provider, "alpha");
});

test("entries are cloned: two replies share no state", async () => {
  const { handler } = setup();
  const first = new Session();
  handler({ providers: ["alpha"], respond: first.respond });
  const second = new Session();
  handler({ providers: ["alpha"], respond: second.respond });
  await flush();
  const left = first.reply.providers.alpha;
  const right = second.reply.providers.alpha;
  assert.ok(left !== undefined && right !== undefined);
  assert.notEqual(left, right);
  assert.notEqual(left.plan, right.plan);
  left.plan = { state: "not-exposed" };
  assert.deepEqual(right.plan, { state: "known", value: "pro" });
});

test("generatedAt is the clock at settlement", async () => {
  const { handler, refresher, time } = setup({ hold: true });
  const session = new Session();
  handler({ providers: ["alpha"], respond: session.respond });
  await flush();
  await time.advance(7 * SECOND);
  refresher.settle("alpha");
  await flush();
  assert.equal(session.value?.status, "ok");
  assert.equal(session.value?.generatedAt, START + 7 * SECOND);
});

test("without maxWaitMs no deadline timer is armed and the reply settles when the refresh settles", async () => {
  const { handler, refresher, time } = setup({ hold: true });
  const session = new Session();
  handler({ providers: ["alpha", "beta"], mode: "refresh", respond: session.respond });
  await flush();
  assert.equal(session.settled, false);
  assert.equal(time.pending, 0);
  await time.advance(60 * SECOND);
  assert.equal(session.settled, false);
  refresher.settleAll();
  await flush();
  assert.equal(session.rejected, false);
  assert.equal(session.value?.status, "ok");
  assert.deepEqual(Object.keys(session.reply.providers).toSorted(), ["alpha", "beta"]);
  assert.deepEqual(session.reply.providers.alpha, makeEntry("alpha"));
  assert.equal(session.value?.generatedAt, START + 60 * SECOND);
  assert.equal(time.pending, 0);
});

test("the reply settles at maxWaitMs with the entries as they stand", async () => {
  const { handler, refresher, time } = setup({ hold: true });
  const session = new Session();
  handler({
    providers: ["alpha", "beta"],
    mode: "refresh",
    maxWaitMs: 20 * SECOND,
    respond: session.respond,
  });
  await flush();
  assert.equal(session.settled, false);
  await time.advance(20 * SECOND - 1);
  assert.equal(session.settled, false);
  await time.advance(1);
  assert.equal(session.settled, true);
  assert.equal(session.rejected, false);
  assert.equal(session.value?.status, "ok");
  assert.deepEqual(Object.keys(session.reply.providers).toSorted(), ["alpha", "beta"]);
  assert.deepEqual(session.reply.providers.alpha, makeEntry("alpha"));
  assert.equal(session.value?.generatedAt, START + 20 * SECOND);
  assert.equal(time.pending, 0);
  assert.equal(refresher.pending.length, 2);
  const atDeadline = session.value;
  refresher.settleAll();
  await flush();
  assert.equal(session.value, atDeadline);
});

test("a provider id outside the pattern is not served and has no entry", async () => {
  const ids = ["", "-alpha", "alpha beta", "alpha/beta", "alpha:beta", "é", "a".repeat(129)];
  const { handler, refresher } = setup();
  const session = new Session();
  handler({ providers: ["alpha", ...ids, "__proto__"], respond: session.respond });
  await flush();
  assert.equal(session.value?.status, "ok");
  assert.deepEqual(Object.keys(session.reply.providers), ["alpha"]);
  assert.deepEqual(
    refresher.calls.map((call) => call.provider),
    ["alpha"],
  );
});

test("maxWaitMs settles the reply early and the refreshes continue", async () => {
  const { handler, refresher, time } = setup({ hold: true });
  const session = new Session();
  handler({ providers: ["alpha"], mode: "refresh", maxWaitMs: 500, respond: session.respond });
  await flush();
  await time.advance(499);
  assert.equal(session.settled, false);
  await time.advance(1);
  assert.equal(session.value?.status, "ok");
  assert.deepEqual(Object.keys(session.reply.providers), ["alpha"]);
  assert.equal(refresher.pending.length, 1);
});

test("with maxWaitMs larger than 20000 the timer uses that value", async () => {
  const { handler, time } = setup({ hold: true });
  const session = new Session();
  handler({ providers: ["alpha"], maxWaitMs: 30 * SECOND, respond: session.respond });
  await flush();
  assert.equal(session.settled, false);
  await time.advance(30 * SECOND - 1);
  assert.equal(session.settled, false);
  await time.advance(1);
  assert.equal(session.value?.status, "ok");
  assert.equal(session.value?.generatedAt, START + 30 * SECOND);
  assert.equal(time.pending, 0);
});

test("the deadline uses a resolved entry when one is ready", async () => {
  const { handler, refresher, time } = setup({ hold: true });
  refresher.entries.set("alpha", makeEntry("alpha", "served-now"));
  const session = new Session();
  handler({ providers: ["alpha", "beta"], maxWaitMs: 20 * SECOND, respond: session.respond });
  await flush();
  await time.advance(SECOND);
  refresher.settle("alpha", makeEntry("alpha", "from-refresh"));
  await flush();
  assert.equal(session.settled, false);
  await time.advance(20 * SECOND - SECOND);
  assert.equal(session.value?.status, "ok");
  assert.deepEqual(session.reply.providers.alpha?.plan, { state: "known", value: "from-refresh" });
  assert.deepEqual(session.reply.providers.beta, makeEntry("beta"));
  assert.equal(time.pending, 0);
});

test("cancelled: an already-aborted signal", async () => {
  const { handler, refresher, time } = setup();
  const controller = new AbortController();
  controller.abort();
  const session = new Session();
  handler({ providers: ["alpha"], signal: controller.signal, respond: session.respond });
  await flush();
  assert.equal(session.value?.status, "cancelled");
  assert.deepEqual(session.value?.providers, {});
  assert.equal(session.value?.generatedAt, time.now);
  assert.equal(refresher.calls.length, 0);
  assert.equal(time.pending, 0);
});

test("cancelled: abort settles at abort, the refreshes keep going", async () => {
  const { handler, refresher, time } = setup({ hold: true });
  const controller = new AbortController();
  const session = new Session();
  handler({ providers: ["alpha", "beta"], signal: controller.signal, respond: session.respond });
  await flush();
  await time.advance(5 * SECOND);
  controller.abort();
  await flush();
  assert.equal(session.settled, true);
  assert.equal(session.rejected, false);
  assert.equal(session.value?.status, "cancelled");
  assert.deepEqual(session.value?.providers, {});
  assert.equal(session.value?.generatedAt, START + 5 * SECOND);
  assert.equal(time.pending, 0);
  assert.equal(refresher.pending.length, 2);
  const atAbort = session.value;
  refresher.settleAll();
  await flush();
  assert.equal(session.value, atAbort);
});

test("cancelled: abort after only some entries are ready", async () => {
  const { handler, refresher } = setup({ hold: true });
  const controller = new AbortController();
  const session = new Session();
  handler({ providers: ["alpha", "beta"], signal: controller.signal, respond: session.respond });
  await flush();
  refresher.settle("alpha");
  await flush();
  assert.equal(session.settled, false);
  controller.abort();
  await flush();
  assert.equal(session.value?.status, "cancelled");
});

test("ok stands once every entry is ready, whatever the signal does later", async () => {
  const { handler, refresher, time } = setup({ hold: true });
  const controller = new AbortController();
  const session = new Session();
  handler({ providers: ["alpha"], signal: controller.signal, respond: session.respond });
  await flush();
  refresher.settle("alpha");
  await flush();
  assert.equal(session.value?.status, "ok");
  const atOk = session.value;
  controller.abort();
  await flush();
  assert.equal(session.value, atOk);
  assert.equal(session.value?.status, "ok");
  assert.equal(session.value?.generatedAt, START);
  assert.equal(time.pending, 0);
});

test("an empty provider list with an aborted signal is ok, not cancelled", async () => {
  const { handler, refresher } = setup();
  const controller = new AbortController();
  controller.abort();
  const session = new Session();
  handler({ providers: [], signal: controller.signal, respond: session.respond });
  await flush();
  assert.equal(session.value?.status, "ok");
  assert.deepEqual(session.value?.providers, {});
  assert.equal(refresher.calls.length, 0);
});

test("a signal whose aborted getter throws is bad-request", async () => {
  const { handler, refresher } = setup();
  const session = new Session();
  const signal = {
    get aborted(): boolean {
      throw new Error("hostile getter");
    },
    addEventListener() {},
    removeEventListener() {},
  };
  handler({ providers: ["alpha"], signal, respond: session.respond });
  await flush();
  assert.equal(session.value?.status, "bad-request");
  assert.equal(refresher.calls.length, 0);
});

test("a signal whose listeners throw cannot break the reply", async () => {
  const { handler, refresher, time } = setup({ hold: true });
  const session = new Session();
  const signal = {
    aborted: false,
    addEventListener() {
      throw new Error("hostile add");
    },
    removeEventListener() {
      throw new Error("hostile remove");
    },
  };
  handler({ providers: ["alpha"], signal, respond: session.respond });
  await flush();
  refresher.settle("alpha");
  await flush();
  assert.equal(session.value?.status, "ok");
  assert.equal(session.rejected, false);
  assert.equal(time.pending, 0);
});

test("a throwing entry getter on the payload is bad-request", async () => {
  const { handler, refresher } = setup();
  const session = new Session();
  const target = { respond: session.respond };
  const payload = new Proxy(target, {
    get(object, key, receiver) {
      if (key === "providers") throw new Error("hostile getter");
      return Reflect.get(object, key, receiver);
    },
  });
  handler(payload);
  await flush();
  assert.equal(session.value?.status, "bad-request");
  assert.equal(refresher.calls.length, 0);
});

test("a providers array with a throwing iterator is bad-request", async () => {
  const { handler } = setup();
  const session = new Session();
  const providers = new Proxy([] as unknown[], {
    get(target, key, receiver) {
      if (key === Symbol.iterator) throw new Error("hostile iterator");
      return Reflect.get(target, key, receiver);
    },
  });
  handler({ providers, respond: session.respond });
  await flush();
  assert.equal(session.value?.status, "bad-request");
});

test("a rejecting refresher request still settles the reply", async () => {
  const { handler, refresher } = setup({ hold: true });
  const session = new Session();
  handler({ providers: ["alpha"], mode: "refresh", respond: session.respond });
  await flush();
  refresher.fail("alpha", new Error("boom"));
  await flush();
  assert.equal(session.rejected, false);
  assert.equal(session.value?.status, "ok");
  assert.deepEqual(session.reply.providers.alpha, makeEntry("alpha"));
});

test("respond returning false stops the refreshes but settles the reply", async () => {
  const { handler, refresher, time } = setup({ hold: true });
  const offer = new Offer();
  handler({
    providers: ["alpha"],
    respond: (reply: Promise<QueryReply>) => {
      offer.respond(reply);
      return false;
    },
  });
  await flush();
  assert.equal(refresher.calls.length, 0);
  assert.equal(time.pending, 0);
  const reply = await offer.reply();
  assert.equal(reply.status, "ok");
  assert.deepEqual(Object.keys(reply.providers).toSorted(), ["alpha"]);
});

test("respond returning undefined stops the refreshes", async () => {
  const { handler, refresher } = setup({ hold: true });
  const session = new Session();
  handler({
    providers: ["alpha"],
    respond: (reply: Promise<QueryReply>) => {
      session.respond(reply);
      return undefined;
    },
  });
  await flush();
  assert.equal(refresher.calls.length, 0);
  assert.equal(session.value?.status, "ok");
});

test("respond throwing stops the refreshes and the handler does not throw", async () => {
  const { handler, refresher, time } = setup({ hold: true });
  const offer = new Offer();
  assert.doesNotThrow(() =>
    handler({
      providers: ["alpha", "beta"],
      mode: "refresh",
      respond: (reply: Promise<QueryReply>) => {
        offer.respond(reply);
        throw new Error("hostile respond");
      },
    }),
  );
  await flush();
  assert.equal(refresher.calls.length, 0);
  assert.equal(time.pending, 0);
  const reply = await offer.reply();
  assert.equal(reply.status, "ok");
  assert.deepEqual(Object.keys(reply.providers).toSorted(), ["alpha", "beta"]);
});

test("a bad-request reply is still offered when respond does not accept", async () => {
  const { handler, refresher } = setup();
  const offer = new Offer();
  handler({
    providers: "alpha",
    respond: (reply: Promise<QueryReply>) => {
      offer.respond(reply);
      return false;
    },
  });
  await flush();
  assert.equal(refresher.calls.length, 0);
  assert.equal((await offer.reply()).status, "bad-request");
});

test("no reply promise rejects", async () => {
  const hostile: unknown[] = [
    { respond: () => false },
    { mode: 1, respond: () => true },
    { providers: ["alpha"], respond: () => true },
  ];
  for (const payload of hostile) {
    const { handler } = setup({ hold: true });
    const offer = new Offer();
    const session = new Session();
    handler({
      ...(payload as object),
      respond: (reply: Promise<QueryReply>) => {
        offer.respond(reply);
        session.respond(reply);
        return false;
      },
    });
    await flush();
    const reply = await offer.reply();
    assert.equal(typeof reply.protocol, "number");
    assert.equal(session.rejected, false);
  }
});
