# Adapter contract specification

This document specifies what every adapter shares: its definition, its injectable boundary,
and the security envelope around credentials, requests, and commands. Each
`adapter-<provider>.md` spec supplies the constants and mapping for one provider. Results feed
the cache per [refresh.md](refresh.md); facet values follow [billing-state.md](billing-state.md).

## 1. Adapters

| Adapter                                            | Provider       |
| -------------------------------------------------- | -------------- |
| [adapter-anthropic.md](adapter-anthropic.md)       | `anthropic`    |
| [adapter-zai.md](adapter-zai.md)                   | `zai`          |
| [adapter-deepseek.md](adapter-deepseek.md)         | `deepseek`     |
| [adapter-google.md](adapter-google.md)             | `google`       |
| [adapter-openai-codex.md](adapter-openai-codex.md) | `openai-codex` |
| [adapter-exa.md](adapter-exa.md)                   | `exa`          |
| [adapter-amd.md](adapter-amd.md)                   | `amd`          |

An adapter's id is its provider id. Every other provider has no adapter. A tool provider is a
provider whose adapter spec fixes a credential variable; it has no provider origin and needs
no inventory model. Each adapter spec fixes:

| Constant            | Contract                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| provider origin     | The https origin the host sends the provider's inference requests to; none for a tool provider.         |
| credential variable | Tool providers only: the environment variable holding the credential (Section 3).                       |
| host allowlist      | The https origins the adapter contacts; no other.                                                       |
| freshness period    | Default seconds a capture stays fresh.                                                                  |
| body cap            | Maximum bytes (1 KiB = 1024 bytes) of one 2xx body, per endpoint where stated; the request's `bodyCap`. |
| exposed facets      | Facets the adapter reports; the others are always `not-exposed`.                                        |

## 2. Boundary

An adapter is an object holding its constants (Section 1) — `id`, `providerOrigin`,
`hostAllowlist`, `exposedFacets`, `freshnessSeconds`, and for a tool provider
`credentialVariable` — and the method
`run(dependencies, signal)`, which returns a promise of the adapter result. The refresh layer
([refresh.md](refresh.md), Section 3) calls `run` only after the checks of Section 3 passed,
and builds the dependencies; `signal` aborts at the refresh deadline. An adapter MUST reach the
network, the host, commands, the clock, and any state that outlives one run only through these
dependencies:

| Dependency      | Contract                                                                                                                                                                                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport`     | `(request) => Promise<outcome>`: performs one request under Section 4, bound to the adapter's host allowlist.                                                                                                                                                                                                                                         |
| `commandRunner` | `(request) => Promise<outcome>`: runs one command under Section 5.                                                                                                                                                                                                                                                                                    |
| `credentials`   | `() => Promise<{ apiKey, oauth } \| undefined>`: the first call returns the credentials Section 3 checked; each later call resolves and checks them afresh, `undefined` when a check fails. `apiKey` is a non-empty string.                                                                                                                           |
| `inventory`     | The inventory models of the provider (Section 2.1), read when the refresh starts.                                                                                                                                                                                                                                                                     |
| `clock`         | `() => number`: current epoch milliseconds.                                                                                                                                                                                                                                                                                                           |
| `configuration` | The provider's configuration entry ([config-file.md](config-file.md), Section 2).                                                                                                                                                                                                                                                                     |
| `store`         | The adapter's private store (below).                                                                                                                                                                                                                                                                                                                  |
| `observations`  | `latest()`: the latest header observation (limit values pi-dent-purse read from response headers of the provider's inference requests the host made) recorded for the adapter's provider, in the shape its adapter spec fixes ([adapter-anthropic.md](adapter-anthropic.md), Section 4; [adapter-amd.md](adapter-amd.md), Section 2), or `undefined`. |

`transport` and `commandRunner` MUST NOT reject. An outcome is a success or a failure; a failure
is the outcome that has a `reason` field:

| Outcome         | Fields                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------- |
| Request         | `url`, `headers?`, `bodyCap` (bytes), `signal`.                                              |
| Request success | `status`, `headers` (lowercase keys), `body` (text).                                         |
| Request failure | `reason`, `status?` (present when a response arrived), `retryAfter?` (seconds).              |
| Command         | `command`, `args`, `deadlineMs`, `outputCap` (bytes), `signal`.                              |
| Command success | `code`, `stdout`, `stderr`: the command ran to exit, whatever its code.                      |
| Command failure | `reason`: `timeout`, `deadline`, `response-too-large`, or `internal` (the host exec failed). |

An adapter MUST pass the refresh's `signal` on every request and command.

The store is synchronous and private to one adapter: `get(key)` returns the value, or
`undefined` when absent or expired; `set(key, value, ttlSeconds?)` stores a value that expires
`ttlSeconds` after it is set, or does not expire without it. It lives as long as the cache
([refresh.md](refresh.md), Section 1).

The adapter result is either a whole failure `{ reason, retryAfter? }`, or:

| Field           | Contract                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `facets`        | A facet value for each exposed facet.                                                                     |
| `firstFailure`  | `{ reason, retryAfter? }` of the first failed request or command in issue order; absent when none failed. |
| `capturedAt`    | Epoch milliseconds, only where an adapter spec assigns it.                                                |
| `captureReason` | A reason code, only where an adapter spec assigns it.                                                     |

A request fails when its outcome is a failure, or when its body is `bad-response` or
`vendor-error` per its adapter spec; its reason is then that reason. A command fails when its
outcome is a failure, or when its adapter spec makes its result a whole failure. Issue order
is the order in which the adapter called `transport` or `commandRunner`.

`run` MUST NOT reject; an unexpected exception is a whole failure with `internal`. With
recorded outcomes for `transport` and `commandRunner`, an adapter MUST run without network or
commands.

### 2.1 Inventory model

An inventory model is `{ id, baseUrl, cost }`, with `cost` `{ input, output, cacheRead,
cacheWrite, tiers? }` and each tier `{ inputTokensAbove, input, output, cacheRead, cacheWrite }`,
every rate a finite number in USD per million tokens, as the host's model registry gives them.
The same shape serves price derivation ([prices.md](prices.md), Section 2).

## 3. Credentials and checks

- Credentials come only from the model registry of the live context: `apiKey` and `baseUrl`
  from `getProviderAuth(<provider>)` (`auth.apiKey`, `auth.baseUrl`); `oauth` is
  `isUsingOAuth(<first inventory model of the provider>)`. The exceptions are the Google access
  token ([adapter-google.md](adapter-google.md)) and a tool provider's credentials: `apiKey` is
  the value of its credential variable in the environment of the pi process, absent when unset,
  `oauth` is `false`, and there is no `baseUrl`. pi-dent-purse MUST NOT read credential files,
  keychains, other environment variables, or vendor command-line tool stores itself.
- Credentials MUST be resolved inside a refresh and MUST NOT outlive it.
- The refresh layer, not the adapter, MUST run these checks once per refresh, after resolving
  the credentials and before calling `run`; the first that fails is the refresh's whole
  failure, and `run` is not called:
  1. `no-credentials`: no credentials, or an `apiKey` that is absent or the empty string;
  2. `endpoint-mismatch`, except for a tool provider: when `baseUrl` is present (the empty string included), its origin
     differs from the provider origin; when it is absent, any inventory model's `baseUrl` has an
     origin other than the provider origin.
- Origins compare after normalization: an origin is that of an `https:` URL without userinfo,
  with the host lowercased and trailing dots removed and the default port omitted; a value that
  does not parse as such a URL has no origin and matches nothing.
- An adapter's own credential checks run inside `run`, after these.
- An adapter MUST NOT forward credential headers resolved by the host; it sends only the
  headers its spec lists.
- A credential MUST NOT appear anywhere except the request header, or URL query parameter, its
  adapter spec names; in particular not in a reply, a provider entry, a diagnostic, a
  notification, the user interface, a reason code, a thrown error message, or a log. pi-dent-purse MUST
  NOT write logs.

> Note (non-normative): a present `baseUrl` is where the host sends every request of the
> provider, so the inventory's own base URLs do not matter then.

## 4. Transport

The transport is created for one adapter with its host allowlist. It MUST, for every request:

- use method `GET`, and refuse before connecting, with `internal`, a URL that has no origin
  (Section 3: not `https:`, unparsable, or carrying userinfo) or whose origin is not in the
  host allowlist, and a request whose headers are not valid HTTP header names and values;
- send the request's `headers`, then `accept: application/json` and `user-agent: pi-dent-purse`,
  each replacing a request header of the same name in any letter case;
- refuse redirects: a 3xx response fails with `redirect`, unfollowed;
- stop after 8 seconds with `timeout`, and when `signal` aborts with `deadline`;
- for a 2xx response, read at most `bodyCap` bytes of the body; more fails with
  `response-too-large`; a body that errors before it ends fails with `network`;
- for any other response, not read the body;
- map status: 2xx → success; 401 → `http-401`; 403 → `http-403`; 429 → `http-429`, with
  `retryAfter` the `retry-after` header value when, trimmed, it is one or more decimal digits
  forming a safe integer; other → `http-error`; no response → `network`.

An adapter MUST call only the endpoints its spec lists, and none that consumes vendor quota or
balance. Response bodies are parsed as JSON (failure → `bad-response`); only fields an adapter
spec names are read; other keys are ignored. Response text and headers other than
`retry-after` MUST NOT leave the adapter.

## 5. Command runner

The command runner MUST run every command through the host exec API (`pi.exec`), without a
shell, in the user's home directory. It MUST fail a command whose output exceeded `outputCap`
bytes with `response-too-large`; else a command stopped after `deadlineMs` with `timeout`, or
because `signal` aborted with `deadline`; and a host exec call that throws with `internal`, or
`deadline` when `signal` had aborted. A missing executable is a command success with code 1 and
`ENOENT` in `stderr`. An adapter MUST use `stderr` only for the classification its spec states
and MUST NOT let it leave the adapter.

## 6. Specification gaps

None.
