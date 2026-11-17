# Development

## Host reference

pi 1.5.2 is installed under `~/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/`;
`package.json` links the pi packages from there. Docs: `pi-coding-agent/docs/` (`extensions.md`,
`tui.md`); types: `pi-coding-agent/dist/core/extensions/types.d.ts`,
`pi-coding-agent/dist/core/model-registry.d.ts`, `pi-ai/dist/auth/types.d.ts`.

Host APIs the specs rely on, checked against 1.5.2:

| Need             | API                                                                                                           | Notes                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Event bus        | `pi.events.emit(channel, data)`, `pi.events.on(channel, handler)`                                             | Node `EventEmitter`: listeners run synchronously in `emit`; each is wrapped in an async try/catch, so code before the first `await` runs inside `emit`. Handlers get no `ctx`. |
| Credentials      | `ctx.modelRegistry.getProviderAuth(provider)` → `{ auth: { apiKey?, headers?, baseUrl? }, source? }`          | Refreshes expiring OAuth tokens (anthropic: `apiKey` is the access token).                                                                                                     |
| OAuth or API key | `ctx.modelRegistry.isUsingOAuth(model)`                                                                       | True when the stored credential is `oauth`.                                                                                                                                    |
| Inventory        | `ctx.modelRegistry.getAll()`, `getAvailable()`                                                                | `Model.cost = { input, output, cacheRead, cacheWrite, tiers?: [{ inputTokensAbove, … }] }`, USD per million tokens.                                                            |
| Commands         | `pi.registerCommand(name, { description, getArgumentCompletions, handler(args, ctx) })`                       |                                                                                                                                                                                |
| Exec             | `pi.exec(command, args, { signal, timeout, cwd, maxBuffer })` → `{ stdout, stderr, code, killed, truncated }` | No shell. A missing executable yields `code` 1 and an `ENOENT` message in `stderr`; no env option.                                                                             |
| Message          | `pi.sendMessage({ customType, content, display }, { triggerTurn: false })`                                    | Appends to the session, and its LLM context, without starting a turn; while streaming it is deferred to the end of the turn.                                                   |
| Status line      | `ctx.ui.setStatus(key, text \| undefined)`                                                                    | Footer, below the model line.                                                                                                                                                  |
| Notification     | `ctx.ui.notify(message, "info" \| "warning" \| "error")`                                                      |                                                                                                                                                                                |
| Response headers | `pi.on("after_provider_response", (event, ctx) => …)`, `event.status`, `event.headers`                        | Header availability depends on the provider transport.                                                                                                                         |
| Lifecycle        | `session_start`, `session_shutdown` (`reason`), `model_select`, `agent_settled`                               | Guard UI with `ctx.hasUI` and `ctx.mode === "tui"`.                                                                                                                            |

## Loading

`pi -ne -e ./` loads only the extensions in `package.json` → `pi.extensions`. Restart pi (or
`/reload`) after changes.

## Layout

| Path                         | Holds                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `index.ts`                   | Wiring: host events, command, bus listener                                          |
| `lib/state.ts`               | Billing state types, severity, reason codes                                         |
| `lib/config.ts`              | Configuration file and environment                                                  |
| `lib/adapter.ts`             | Adapter contract types and constants                                                |
| `lib/transport.ts`           | Transport (bound to an allowlist) and command runner over `fetch` and `pi.exec`     |
| `lib/refresh.ts`             | Credential checks, adapter dependencies, cache, single-flight, suppression, backoff |
| `lib/prices.ts`              | Price derivation and schedules                                                      |
| `lib/protocol.ts`            | `purse:query:v1` service                                                            |
| `lib/adapters/<provider>.ts` | One adapter each, exported as a named `Adapter` const named after its provider id   |
| `lib/adapters/headers.ts`    | Header helpers shared by the adapters that observe inference-response headers       |
| `lib/adapters/index.ts`      | `ADAPTERS`, the adapters by provider id                                             |
| `lib/ui.ts`                  | Billing report message, command and status line                                     |
| `lib/guidance.ts`            | Guided models parsed from the session branch's model guidance                       |
| `test/<module>.test.ts`      | `node --test` suites                                                                |
| `test/fixtures/<provider>/`  | Redacted recorded responses and command outputs                                     |

## Wiring

One `Refresher` per boot window (specs/refresh.md Section 1), created with the boot window's
configuration at the first `session_start`, kept across session replacement, and `clear()`ed
and dropped on `session_shutdown` with reason `reload` or `quit`. On session replacement the
host calls the factory again with a new `pi` and bus (the module is not loaded again) and
delivers the new `session_start` twice, so the boot window lives in a module-level `Boot` that
`wire` rebinds to the latest `pi`:

```ts
createRefresher({
  adapters: ADAPTERS,
  clock: Date.now,
  configuration, // loadConfiguration()
  host: () => liveHost, // RefreshHost over the live ctx.modelRegistry, or undefined
  environment: (variable) => process.env[variable], // tool providers' credential variables
  transportFor: (allowlist) => createTransport(globalThis.fetch, allowlist),
  commandRunner: createCommandRunner(pi.exec),
  onChanged: (provider) =>
    pi.events.emit("purse:changed:v1", { protocol: 1, providers: [provider] }),
});
```

`RefreshHost` over a live context `ctx`:

- `inventory(p)`: `ctx.modelRegistry.getAll()` filtered to `provider === p`, mapped to
  `{ id, baseUrl, cost }`;
- `availableProviders()`: the `provider` of each `ctx.modelRegistry.getAvailable()` model;
- `credentials(p)`: `getProviderAuth(p)` → `{ apiKey: auth.apiKey, baseUrl: auth.baseUrl,
  oauth: isUsingOAuth(first inventory model) }`, or `undefined` without a result or model.

The environment is separate from the host: `environment(variable)` reads the pi process's
`process.env` at each use. Only a tool provider's credential variable is read; its credentials
are that value, with `oauth` `false` and no `baseUrl`, and its adapter has no provider origin.

Header observations: on `after_provider_response`, when `ctx.model?.provider === "anthropic"`,
`observeHeaders(event.headers, Date.now())` from `lib/adapters/anthropic.ts`; when it is `"amd"`,
`observeAmdHeaders(event.headers, Date.now())` from `lib/adapters/amd.ts`. Record a defined
result with `refresher.recordObservation(<provider>, observation)`; each adapter reads it through
`deps.observations.latest()` and narrows it to its own shape. A `purse:observe:v1` payload
(specs/query-protocol.md Section 7) takes the same path with its `provider` and `headers`; it
covers sessions that load no extensions, such as pi-dent's Agent children.
