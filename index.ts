/**
 * purse - per-vendor LLM billing state for pi; see specs/.
 *
 * Wiring only: every building block lives in lib/ (docs/development.md, Wiring).
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Adapter, InventoryModel } from "./lib/adapter.ts";
import { ADAPTERS } from "./lib/adapters/index.ts";
import { observeAmdHeaders } from "./lib/adapters/amd.ts";
import { observeHeaders } from "./lib/adapters/anthropic.ts";
import { loadConfiguration, parseConfiguration, type LoadedConfiguration } from "./lib/config.ts";
import { guidedModels } from "./lib/guidance.ts";
import { QUERY_CHANNEL, createQueryHandler } from "./lib/protocol.ts";
import {
  createRefresher,
  type RefreshHost,
  type Refresher,
  type RefreshMode,
} from "./lib/refresh.ts";
import { createCommandRunner, createTransport, type FetchFunction } from "./lib/transport.ts";
import {
  PURSE_COMMAND_NAME,
  PURSE_MESSAGE_TYPE,
  createPurseCommand,
  createStatusLineUpdater,
  statusLineActive,
  type StatusLineUpdater,
} from "./lib/ui.ts";

/** The bus channel announcing a changed provider entry. */
export const CHANGED_CHANNEL = "purse:changed:v1";
export const OBSERVE_CHANNEL = "purse:observe:v1";

/** Replaceable dependencies; every field defaults to production. */
export interface WiringDependencies {
  adapters?: ReadonlyMap<string, Adapter>;
  clock?: () => number;
  fetch?: FetchFunction;
  loadConfiguration?: () => LoadedConfiguration;
  /**
   * A variable of the pi process's environment, read at each use; defaults to `process.env`.
   * Only tool providers' credential variables are read (adapter-contract.md Section 3).
   */
  environment?: (variable: string) => string | undefined;
  /** Where the boot window lives; a fresh one by default. */
  boot?: Boot;
}

/** What exists once per boot window. */
interface Window {
  configuration: LoadedConfiguration;
  refresher: Refresher;
  updateStatus: StatusLineUpdater;
}

/**
 * State outliving one `wire` call. The host calls the extension factory again, with a new `pi`
 * and bus, on session replacement; the boot window survives it (specs/refresh.md Section 1).
 */
export interface Boot {
  pi: ExtensionAPI | undefined;
  live: ExtensionContext | undefined;
  window: Window | undefined;
}

export function createBoot(): Boot {
  return { pi: undefined, live: undefined, window: undefined };
}

const processBoot = createBoot();

/** The RefreshHost over a live context's model registry (docs/development.md, Wiring). */
function hostOver(ctx: ExtensionContext): RefreshHost {
  const registry = ctx.modelRegistry;
  const inventory = (provider: string): InventoryModel[] =>
    registry
      .getAll()
      .filter((model) => model.provider === provider)
      .map(({ id, baseUrl, cost }) => ({
        id,
        baseUrl,
        cost: {
          input: cost.input,
          output: cost.output,
          cacheRead: cost.cacheRead,
          cacheWrite: cost.cacheWrite,
          ...(cost.tiers === undefined ? {} : { tiers: cost.tiers }),
        },
      }));
  return {
    inventory,
    availableProviders: () => registry.getAvailable().map((model) => model.provider),
    async credentials(provider) {
      const result = await registry.getProviderAuth(provider);
      const first = registry.getAll().find((model) => model.provider === provider);
      if (result === undefined || first === undefined) return;
      const { apiKey, baseUrl } = result.auth;
      return {
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        oauth: registry.isUsingOAuth(first),
      };
    },
  };
}

/** Wires purse to the host `pi`. */
export function wire(pi: ExtensionAPI, dependencies: WiringDependencies = {}): void {
  const clock = dependencies.clock ?? Date.now;
  const adapters = dependencies.adapters ?? ADAPTERS;
  const fetchFunction = dependencies.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const load = dependencies.loadConfiguration ?? (() => loadConfiguration());
  const environment = dependencies.environment ?? ((variable: string) => process.env[variable]);

  const boot = dependencies.boot ?? createBoot();
  boot.pi = pi;

  const newRefresher = (configuration: LoadedConfiguration): Refresher =>
    createRefresher({
      adapters,
      clock,
      configuration,
      host: () => (boot.live === undefined ? undefined : hostOver(boot.live)),
      environment,
      transportFor: (allowlist) => createTransport(fetchFunction, allowlist),
      commandRunner: createCommandRunner((command, args, options) =>
        (boot.pi ?? pi).exec(command, args, options),
      ),
      onChanged: (provider) =>
        (boot.pi ?? pi).events.emit(CHANGED_CHANNEL, { protocol: 1, providers: [provider] }),
    });

  // Before the first session_start and after a window ends, the query service and the command
  // face a refresher without a live context: `ready()` is false, so queries answer `not-ready`.
  const dormant = newRefresher(parseConfiguration(null, "", {}));
  const current = (): Refresher => boot.window?.refresher ?? dormant;
  const facade: Refresher = {
    ready: () => current().ready(),
    knownProviders: () => current().knownProviders(),
    recordObservation: (provider, observation) =>
      current().recordObservation(provider, observation),
    entry: (provider) => current().entry(provider),
    request: (provider, mode, options) => current().request(provider, mode, options),
    clear: () => current().clear(),
  };

  const request = (provider: string, mode: RefreshMode): void => {
    void boot.window?.refresher.request(provider, mode);
  };

  pi.events.on(QUERY_CHANNEL, createQueryHandler({ refresher: facade, clock }));

  const command = createPurseCommand({
    refresher: facade,
    clock,
    send: (message) => {
      (boot.pi ?? pi).sendMessage(
        { customType: PURSE_MESSAGE_TYPE, content: message.content, display: true },
        { triggerTurn: false },
      );
    },
  });
  pi.registerCommand(PURSE_COMMAND_NAME, {
    description: command.description,
    getArgumentCompletions: (prefix) => command.getArgumentCompletions(prefix),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      boot.live = ctx;
      await command.handler(args, {
        mode: ctx.mode,
        hasUI: ctx.hasUI,
        ui: {
          notify: (message, type) => ctx.ui.notify(message, type),
          setStatus: (key, text) => ctx.ui.setStatus(key, text),
        },
        guidance: guidedModels(ctx.sessionManager.getBranch()),
      });
    },
  });

  pi.on("session_start", (_event, ctx) => {
    boot.live = ctx;
    let window = boot.window;
    if (window === undefined) {
      const configuration = load();
      if (ctx.hasUI) {
        for (const diagnostic of configuration.diagnostics) {
          ctx.ui.notify("purse: " + diagnostic.message, "warning");
        }
      }
      const refresher = newRefresher(configuration);
      boot.window = window = {
        configuration,
        refresher,
        updateStatus: createStatusLineUpdater({
          refresher,
          statusLine: configuration.statusLine,
          clock,
        }),
      };
    }
    // refresh.md Section 1: purse is ready; consumers answered `not-ready` may ask again.
    // The status line renders through the `purse:changed:v1` listener below.
    (boot.pi ?? pi).events.emit(CHANGED_CHANNEL, {
      protocol: 1,
      providers: window.refresher.knownProviders(),
    });
    if (ctx.model !== undefined && statusLineActive(window.configuration.statusLine, ctx)) {
      request(ctx.model.provider, "auto");
    }
  });

  pi.on("session_shutdown", (event, ctx) => {
    boot.window?.updateStatus(ctx);
    boot.live = undefined;
    if (boot.window !== undefined && (event.reason === "reload" || event.reason === "quit")) {
      boot.window.refresher.clear();
      boot.window = undefined;
    }
  });

  pi.on("model_select", (event, ctx) => {
    if (boot.window === undefined) return;
    boot.window.updateStatus(ctx, event.model);
    if (statusLineActive(boot.window.configuration.statusLine, ctx)) {
      request(event.model.provider, "auto");
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (boot.window === undefined || ctx.model === undefined) return;
    if (statusLineActive(boot.window.configuration.statusLine, ctx)) {
      request(ctx.model.provider, "auto");
    }
  });

  pi.events.on(CHANGED_CHANNEL, () => {
    const { window, live } = boot;
    if (window !== undefined && live !== undefined) window.updateStatus(live, live.model);
  });

  /** Records a header observation of an inference response of `provider` (adapter specs). */
  const observe = (
    provider: string | undefined,
    headers: Readonly<Record<string, string>>,
  ): void => {
    const { window } = boot;
    if (window === undefined) return;
    const now = Date.now();
    if (provider === "anthropic") {
      const observation = observeHeaders(headers, now);
      if (observation !== undefined) window.refresher.recordObservation("anthropic", observation);
    } else if (provider === "amd") {
      const observation = observeAmdHeaders(headers, now);
      if (observation !== undefined) window.refresher.recordObservation("amd", observation);
    }
  };

  pi.on("after_provider_response", (event, ctx) => observe(ctx.model?.provider, event.headers));

  // A forwarded response (query-protocol.md Section 7).
  pi.events.on(OBSERVE_CHANNEL, (payload: unknown) => {
    const forwarded = forwardedResponse(payload);
    if (forwarded !== undefined) observe(forwarded.provider, forwarded.headers);
  });
}

/** The forwarded response a payload is, or `undefined` (query-protocol.md Section 7). */
function forwardedResponse(
  payload: unknown,
): { provider: string; headers: Record<string, string> } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const protocol: unknown = Reflect.get(payload, "protocol");
  const provider: unknown = Reflect.get(payload, "provider");
  const headers: unknown = Reflect.get(payload, "headers");
  if (protocol !== 1 || typeof provider !== "string") return undefined;
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return undefined;
  const record: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") return undefined;
    record[name] = value;
  }
  return { provider, headers: record };
}

export default function purse(pi: ExtensionAPI): void {
  wire(pi, { boot: processBoot });
}
