import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Adapter, AdapterDependencies } from "../lib/adapter.ts";
import type { LoadedConfiguration } from "../lib/config.ts";
import { QUERY_CHANNEL, type QueryReply } from "../lib/protocol.ts";
import { CHANGED_CHANNEL, OBSERVE_CHANNEL, createBoot, wire, type Boot } from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type BusListener = (data: unknown) => void;

interface Command {
  description: string;
  handler(args: string, ctx: unknown): Promise<void>;
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A fake `pi`: records subscriptions and runs the bus synchronously, like the host. */
class FakePi {
  readonly handlers = new Map<string, Handler[]>();
  readonly listeners = new Map<string, BusListener[]>();
  readonly commands = new Map<string, Command>();
  readonly messages: {
    customType: string;
    content: unknown;
    display: boolean | undefined;
    details: unknown;
  }[] = [];
  readonly emitted: { channel: string; data: unknown }[] = [];
  readonly events = {
    on: (channel: string, listener: BusListener): (() => void) => {
      this.listeners.set(channel, [...(this.listeners.get(channel) ?? []), listener]);
      return () => {};
    },
    emit: (channel: string, data: unknown): void => {
      this.emitted.push({ channel, data });
      for (const listener of this.listeners.get(channel) ?? []) listener(data);
    },
  };
  on(event: string, handler: Handler): () => void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return () => {};
  }
  registerCommand(name: string, command: Command): void {
    this.commands.set(name, command);
  }
  sendMessage(message: {
    customType: string;
    content: unknown;
    display?: boolean;
    details?: unknown;
  }): void {
    this.messages.push({
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
    });
  }
  exec(): Promise<never> {
    throw new Error("exec must not run in tests");
  }
  fire(event: string, payload: object, ctx: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      void handler({ type: event, ...payload }, ctx);
    }
  }
  /** Sends a query; `undefined` when nobody answered. */
  query(request: object = {}): Promise<QueryReply> | undefined {
    let reply: Promise<QueryReply> | undefined;
    this.events.emit(QUERY_CHANNEL, {
      ...request,
      respond: (promise: Promise<QueryReply>) => {
        reply = promise;
        return true;
      },
    });
    return reply;
  }
}

const MODEL = {
  id: "model-a",
  provider: "anthropic",
  baseUrl: "https://example.test/v1",
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
};

interface Context {
  hasUI: boolean;
  mode: "tui" | "print";
  sessionManager: { getBranch(): object[] };
  model: { provider: string; id: string } | undefined;
  modelRegistry: object;
  ui: {
    notify(message: string, type?: string): void;
    setStatus(key: string, text: string | undefined): void;
  };
  notifications: { message: string; type: string | undefined }[];
  statuses: (string | undefined)[];
}

function makeContext(options: { hasUI?: boolean; guidance?: string } = {}): Context {
  const notifications: Context["notifications"] = [];
  const statuses: Context["statuses"] = [];
  const branch: object[] =
    options.guidance === undefined
      ? []
      : [{ type: "custom_message", customType: "test-guidance", content: options.guidance }];
  return {
    hasUI: options.hasUI ?? true,
    mode: "tui",
    sessionManager: { getBranch: () => branch },
    model: { provider: "anthropic", id: MODEL.id },
    modelRegistry: {
      getAll: () => [MODEL],
      getAvailable: () => [MODEL],
      getProviderAuth: async () => ({ auth: { apiKey: "test-key" } }),
      isUsingOAuth: () => true,
    },
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
      setStatus: (_key, text) => statuses.push(text),
    },
    notifications,
    statuses,
  };
}

const CONFIGURATION: LoadedConfiguration = {
  path: "/none",
  providers: {},
  severity: { low: 75, critical: 90 },
  statusLine: true,
  offline: false,
  diagnostics: [],
};

interface Harness {
  pi: FakePi;
  loads: number;
  runs: AdapterDependencies[];
  observed: unknown[];
  /** Moves the fake clock past the minimum refresh interval. */
  advance(): void;
}

function harness(
  configuration: LoadedConfiguration = CONFIGURATION,
  boot?: Boot,
  options: {
    adapters?: ReadonlyMap<string, Adapter>;
    environment?: (variable: string) => string | undefined;
  } = {},
): Harness {
  const pi = new FakePi();
  let now = 1_000_000_000_000;
  const state: Harness = {
    pi,
    loads: 0,
    runs: [],
    observed: [],
    advance: () => {
      now += 120_000;
    },
  };
  const adapter: Adapter = {
    id: "anthropic",
    providerOrigin: "https://example.test",
    hostAllowlist: ["https://example.test"],
    exposedFacets: ["plan"],
    freshnessSeconds: 300,
    run: async (deps) => {
      state.runs.push(deps);
      state.observed.push(deps.observations.latest());
      return { facets: { plan: { state: "known", value: "pro" } } };
    },
  };
  wire(pi as unknown as ExtensionAPI, {
    ...(boot === undefined ? {} : { boot }),
    adapters: options.adapters ?? new Map([["anthropic", adapter]]),
    clock: () => now,
    fetch: async () => {
      throw new Error("network must not be used in tests");
    },
    loadConfiguration: () => {
      state.loads += 1;
      return configuration;
    },
    environment: options.environment ?? (() => undefined),
  });
  return state;
}

const HEADERS = { "anthropic-ratelimit-unified-5h-utilization": "0.5" };

const AMD_MODEL = {
  id: "amd-model",
  provider: "amd",
  baseUrl: "https://api.tokenlab.amd.com",
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
};

const AMD_HEADERS = {
  "x-ratelimit-limit-user-budget-usd": "20",
  "x-ratelimit-used-user-budget-usd": "5",
  "x-ratelimit-limit-user-rpm": "60",
  "x-ratelimit-remaining-user-rpm": "55",
};

test("registers the command, the bus listeners, and the host handlers", () => {
  const { pi } = harness();
  assert.equal(pi.commands.get("purse")?.description.startsWith("Show billing state"), true);
  assert.equal(pi.listeners.get(QUERY_CHANNEL)?.length, 1);
  assert.equal(pi.listeners.get(CHANGED_CHANNEL)?.length, 1);
  assert.equal(pi.listeners.get(OBSERVE_CHANNEL)?.length, 1);
  for (const event of [
    "session_start",
    "session_shutdown",
    "model_select",
    "agent_settled",
    "after_provider_response",
  ]) {
    assert.equal(pi.handlers.get(event)?.length, 1, event);
  }
});

test("a query before the first session_start and after shutdown answers not-ready", async () => {
  const { pi } = harness();
  const ctx = makeContext();

  const before = pi.query();
  assert.ok(before);
  assert.equal((await before).status, "not-ready");

  pi.fire("session_start", { reason: "startup" }, ctx);
  const during = pi.query();
  assert.ok(during);
  assert.equal((await during).status, "ok");

  pi.fire("session_shutdown", { reason: "quit" }, ctx);
  const after = pi.query();
  assert.ok(after);
  assert.equal((await after).status, "not-ready");
});

test("the configuration is loaded once per boot window and survives session replacement", async () => {
  const state = harness();
  const { pi } = state;
  const ctx = makeContext();

  pi.fire("session_start", { reason: "startup" }, ctx);
  assert.equal(state.loads, 1);

  for (const reason of ["new", "resume", "fork"]) {
    pi.fire("session_shutdown", { reason }, ctx);
    const gap = pi.query();
    assert.ok(gap);
    assert.equal((await gap).status, "not-ready", `no live context after ${reason}`);
    pi.fire("session_start", { reason }, ctx);
  }
  assert.equal(state.loads, 1);

  for (const reason of ["reload", "quit"]) {
    pi.fire("session_shutdown", { reason }, ctx);
    pi.fire("session_start", { reason: "startup" }, ctx);
  }
  assert.equal(state.loads, 3);
});

test("observations and cache survive replacement and are discarded on reload", async () => {
  const state = harness();
  const { pi } = state;
  const ctx = makeContext();
  const ask = async (): Promise<void> => {
    const reply = pi.query({ providers: ["anthropic"], mode: "refresh" });
    assert.ok(reply);
    assert.equal((await reply).status, "ok");
  };

  pi.fire("session_start", { reason: "startup" }, ctx);
  pi.fire("after_provider_response", { status: 200, headers: HEADERS }, ctx);
  await ask();
  assert.notEqual(state.observed[0], undefined);

  pi.fire("session_shutdown", { reason: "new" }, ctx);
  pi.fire("session_start", { reason: "new" }, ctx);
  state.advance();
  await ask();
  assert.notEqual(state.observed[1], undefined);

  pi.fire("session_shutdown", { reason: "reload" }, ctx);
  pi.fire("session_start", { reason: "reload" }, ctx);
  state.advance();
  await ask();
  assert.equal(state.observed[2], undefined);
});

test("a refresh emits purse:changed:v1 and the status line re-renders", async () => {
  const { pi } = harness();
  const ctx = makeContext();
  pi.fire("session_start", { reason: "startup" }, ctx);
  const rendered = ctx.statuses.length;
  const changed = () => pi.emitted.filter((item) => item.channel === CHANGED_CHANNEL);
  // refresh.md Section 1: one notification at session_start names every known provider.
  assert.equal(changed().length, 1);
  const ready = changed()[0]?.data as { protocol: number; providers: string[] };
  assert.equal(ready.protocol, 1);
  assert.ok(ready.providers.includes("anthropic"));

  pi.fire("agent_settled", { aborted: false }, ctx);
  await flush();
  assert.deepEqual(changed().slice(1), [
    { channel: CHANGED_CHANNEL, data: { protocol: 1, providers: ["anthropic"] } },
  ]);
  assert.ok(ctx.statuses.length > rendered);
});

test("the command takes its guided models from the session branch", async () => {
  const guided = harness();
  const guide = (id: string) => `Model guidance:\n- anthropic/${id}: test guidance\n`;

  const guidedCtx = makeContext({ guidance: guide(MODEL.id) });
  guided.pi.fire("session_start", { reason: "startup" }, guidedCtx);
  await guided.pi.commands.get("purse")?.handler("", guidedCtx);
  assert.equal(guided.pi.messages.length, 1);
  assert.match(String(guided.pi.messages[0]?.content), /model-a/u);

  const unguided = harness();
  const unguidedCtx = makeContext({ guidance: guide("another-model") });
  unguided.pi.fire("session_start", { reason: "startup" }, unguidedCtx);
  await unguided.pi.commands.get("purse")?.handler("", unguidedCtx);
  assert.deepEqual(unguided.pi.messages, [], "no guided model, so nothing is shown");

  const full = harness();
  full.pi.fire("session_start", { reason: "startup" }, makeContext({ guidance: guide("x") }));
  const fullCtx = makeContext({ guidance: guide("x") });
  await full.pi.commands.get("purse")?.handler("all", fullCtx);
  assert.equal(full.pi.messages.length, 1, "all shows the full view");
});

test("model_select renders for the event's model and requests an auto refresh", async () => {
  const state = harness();
  const { pi } = state;
  const ctx = makeContext();
  pi.fire("session_start", { reason: "startup" }, ctx);
  const rendered = ctx.statuses.length;

  pi.fire("model_select", { model: MODEL, source: "set" }, ctx);
  await flush();
  assert.ok(ctx.statuses.length > rendered);
  assert.equal(state.runs.length, 1);
});

test("session_start requests an auto refresh of the current model's provider", async () => {
  const state = harness();
  const ctx = makeContext();
  state.pi.fire("session_start", { reason: "startup" }, ctx);
  await flush();
  assert.equal(state.runs.length, 1);

  const headless = harness();
  headless.pi.fire("session_start", { reason: "startup" }, makeContext({ hasUI: false }));
  await flush();
  assert.equal(headless.runs.length, 0, "no refresh while the status line is not active");
});

test("session_shutdown clears the status", () => {
  const { pi } = harness();
  const ctx = makeContext();
  pi.fire("session_start", { reason: "startup" }, ctx);
  pi.fire("session_shutdown", { reason: "quit" }, ctx);
  assert.equal(ctx.statuses.at(-1), undefined);
  assert.ok(ctx.statuses.length >= 2);
});

test("anthropic response headers are recorded; other providers and empty results are not", async () => {
  const state = harness();
  const { pi } = state;
  const ctx = makeContext();
  const other = { ...makeContext(), model: { provider: "deepseek", id: "x" } };
  const ask = async (): Promise<void> => {
    const reply = pi.query({ providers: ["anthropic"], mode: "refresh" });
    assert.ok(reply);
    await reply;
  };
  pi.fire("session_start", { reason: "startup" }, ctx);

  pi.fire("after_provider_response", { status: 200, headers: HEADERS }, other);
  pi.fire("after_provider_response", { status: 200, headers: {} }, ctx);
  await ask();
  assert.equal(state.observed[0], undefined);

  pi.fire("after_provider_response", { status: 200, headers: HEADERS }, ctx);
  state.advance();
  await ask();
  assert.notEqual(state.observed[1], undefined);
});

test("amd response headers are recorded for provider amd only", async () => {
  const seen: unknown[] = [];
  const amdAdapter: Adapter = {
    id: "amd",
    providerOrigin: "https://api.tokenlab.amd.com",
    hostAllowlist: [],
    exposedFacets: ["limits"],
    freshnessSeconds: 60,
    run: async (deps) => {
      seen.push(deps.observations.latest());
      return { facets: { limits: { state: "unavailable", reason: "not-observed" } } };
    },
  };
  const state = harness({ ...CONFIGURATION, statusLine: false }, undefined, {
    adapters: new Map([["amd", amdAdapter]]),
  });
  const { pi } = state;
  const anthropicCtx = makeContext();
  const amdCtx = {
    ...makeContext(),
    model: { provider: "amd", id: AMD_MODEL.id },
    modelRegistry: {
      getAll: () => [AMD_MODEL],
      getAvailable: () => [AMD_MODEL],
      getProviderAuth: async () => ({ auth: { apiKey: "test-key" } }),
      isUsingOAuth: () => false,
    },
  };
  const ask = async (): Promise<void> => {
    const reply = pi.query({ providers: ["amd"], mode: "refresh" });
    assert.ok(reply);
    await reply;
  };

  pi.fire("session_start", { reason: "startup" }, amdCtx);
  pi.fire("after_provider_response", { status: 200, headers: AMD_HEADERS }, anthropicCtx);
  await ask();
  assert.equal(seen.length, 1, "the amd refresh ran");
  assert.equal(seen[0], undefined, "an anthropic response records nothing for amd");

  pi.fire("after_provider_response", { status: 200, headers: AMD_HEADERS }, amdCtx);
  state.advance();
  await ask();
  assert.notEqual(seen[1], undefined);
});

test("a forwarded response is recorded for its provider; malformed payloads are ignored", async () => {
  const seen: unknown[] = [];
  const amdAdapter: Adapter = {
    id: "amd",
    providerOrigin: "https://api.tokenlab.amd.com",
    hostAllowlist: [],
    exposedFacets: ["limits"],
    freshnessSeconds: 60,
    run: async (deps) => {
      seen.push(deps.observations.latest());
      return { facets: { limits: { state: "unavailable", reason: "not-observed" } } };
    },
  };
  const state = harness({ ...CONFIGURATION, statusLine: false }, undefined, {
    adapters: new Map([["amd", amdAdapter]]),
  });
  const { pi } = state;
  const amdCtx = {
    ...makeContext(),
    modelRegistry: {
      getAll: () => [AMD_MODEL],
      getAvailable: () => [AMD_MODEL],
      getProviderAuth: async () => ({ auth: { apiKey: "test-key" } }),
      isUsingOAuth: () => false,
    },
  };
  const ask = async (): Promise<void> => {
    const reply = pi.query({ providers: ["amd"], mode: "refresh" });
    assert.ok(reply);
    await reply;
  };

  pi.events.emit(OBSERVE_CHANNEL, { protocol: 1, provider: "amd", headers: AMD_HEADERS });
  pi.fire("session_start", { reason: "startup" }, amdCtx);
  for (const payload of [
    null,
    "x",
    { protocol: 2, provider: "amd", headers: AMD_HEADERS },
    { protocol: 1, provider: 7, headers: AMD_HEADERS },
    { protocol: 1, provider: "amd", headers: [] },
    { protocol: 1, provider: "amd", headers: { ...AMD_HEADERS, extra: 1 } },
    { protocol: 1, provider: "anthropic", headers: AMD_HEADERS },
  ]) {
    pi.events.emit(OBSERVE_CHANNEL, payload);
  }
  await ask();
  assert.equal(seen[0], undefined, "nothing before the boot window or from a malformed payload");

  pi.events.emit(OBSERVE_CHANNEL, { protocol: 1, provider: "amd", headers: AMD_HEADERS });
  state.advance();
  await ask();
  assert.notEqual(seen[1], undefined);
});

test("configuration diagnostics are notified as warnings, once per window, only with a UI", () => {
  const configuration: LoadedConfiguration = {
    ...CONFIGURATION,
    diagnostics: [{ file: "/none", keyPath: "a", message: "first" }],
  };
  const { pi } = harness(configuration);
  const ctx = makeContext();
  const headless = makeContext({ hasUI: false });

  pi.fire("session_start", { reason: "startup" }, ctx);
  assert.deepEqual(ctx.notifications, [{ message: "purse: first", type: "warning" }]);

  pi.fire("session_shutdown", { reason: "new" }, ctx);
  pi.fire("session_start", { reason: "new" }, ctx);
  assert.equal(ctx.notifications.length, 1);

  pi.fire("session_shutdown", { reason: "quit" }, ctx);
  pi.fire("session_start", { reason: "startup" }, headless);
  assert.deepEqual(headless.notifications, []);
});

test("the boot window survives the host calling the factory again with a new pi", async () => {
  const boot = createBoot();
  const first = harness(CONFIGURATION, boot);
  const ctx = makeContext();
  first.pi.fire("session_start", { reason: "startup" }, ctx);
  first.pi.fire("after_provider_response", { status: 200, headers: HEADERS }, ctx);
  const reply = first.pi.query({ providers: ["anthropic"], mode: "refresh" });
  assert.ok(reply);
  const captured = (await reply).providers?.["anthropic"]?.capturedAt;
  assert.equal(typeof captured, "number");
  first.pi.fire("session_shutdown", { reason: "new" }, ctx);

  const second = harness(CONFIGURATION, boot);
  // The host delivers the replacement session_start twice.
  second.pi.fire("session_start", { reason: "new" }, ctx);
  second.pi.fire("session_start", { reason: "new" }, ctx);
  assert.equal(first.loads + second.loads, 1);
  const cached = second.pi.query({ providers: ["anthropic"], mode: "cached" });
  assert.ok(cached);
  assert.equal((await cached).providers?.["anthropic"]?.capturedAt, captured);

  // A later refresh announces on the new bus, not the old one.
  const before = first.pi.emitted.length;
  first.advance();
  const again = second.pi.query({ providers: ["anthropic"], mode: "refresh" });
  assert.ok(again);
  await again;
  await flush();
  assert.equal(first.pi.emitted.length, before);
  assert.equal(
    second.pi.emitted.some((e) => e.channel === CHANGED_CHANNEL),
    true,
  );

  second.pi.fire("session_shutdown", { reason: "quit" }, ctx);
  assert.equal(boot.window, undefined);
});

test("a tool provider is known by its non-empty credential variable and refreshes", async () => {
  const keys: string[] = [];
  const tool: Adapter = {
    id: "exa",
    credentialVariable: "PURSE_TEST_TOOL_KEY",
    hostAllowlist: ["https://example.test"],
    exposedFacets: ["balance"],
    freshnessSeconds: 900,
    run: async (deps) => {
      keys.push((await deps.credentials())?.apiKey ?? "");
      return {
        facets: {
          balance: {
            state: "known",
            value: [{ amount: 2.5, currency: "USD", currencyAssumed: false, gatesUsage: true }],
          },
        },
      };
    },
  };
  const adapters = new Map([["exa", tool]]);
  const ctx = makeContext();
  const announced = (state: Harness): string[] | undefined => {
    const data = state.pi.emitted.find((item) => item.channel === CHANGED_CHANNEL)?.data as
      | { providers?: string[] }
      | undefined;
    return data?.providers;
  };

  const unset = harness(CONFIGURATION, undefined, { adapters });
  unset.pi.fire("session_start", { reason: "startup" }, ctx);
  assert.deepEqual(announced(unset), ["anthropic"], "an unset variable names no tool provider");

  const set = harness(CONFIGURATION, undefined, {
    adapters,
    environment: (variable) => (variable === "PURSE_TEST_TOOL_KEY" ? "tool-key" : undefined),
  });
  set.pi.fire("session_start", { reason: "startup" }, ctx);
  assert.deepEqual(announced(set), ["anthropic", "exa"]);

  const reply = set.pi.query({ providers: ["exa"], mode: "refresh" });
  assert.ok(reply);
  const answer = await reply;
  assert.equal(answer.status, "ok");
  assert.equal(answer.providers?.["exa"]?.status, "ok");
  assert.deepEqual(answer.providers?.["exa"]?.models, {});
  assert.deepEqual(keys, ["tool-key"]);
});
