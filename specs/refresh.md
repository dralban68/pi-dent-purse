# Refresh specification

This document specifies when pi-dent-purse runs adapters, how their results are cached, and how
failures back off. Adapter behavior is owned by [adapter-contract.md](adapter-contract.md); the
entry shape by [billing-state.md](billing-state.md).

## 1. Live context and host data

- The live context is the context of the latest `session_start` event or `/purse` command
  handler; `session_shutdown` clears it. Without a live context no refresh starts.
- Each `session_start`, once the live context is set and the configuration is read, emits one
  `purse:changed:v1` ([query-protocol.md](query-protocol.md), Section 5) naming every known
  provider, possibly none.
- From the live context pi-dent-purse reads, at each use: the inventory, which is
  `modelRegistry.getAll()` mapped to inventory models
  ([adapter-contract.md](adapter-contract.md), Section 2.1); the providers of
  `modelRegistry.getAvailable()`; and a provider's credentials per
  [adapter-contract.md](adapter-contract.md), Section 3. Without a live context the inventory
  is empty and there are no known providers.
- The known providers are the providers of `modelRegistry.getAvailable()` plus every free
  provider with an inventory model plus every tool provider
  ([adapter-contract.md](adapter-contract.md), Section 1) whose credential variable is set to a
  non-empty value, read at each use, without duplicates, in ascending order of UTF-16 code
  units.
- The cache (Section 2), one store per adapter ([adapter-contract.md](adapter-contract.md),
  Section 2), and one header observation per provider
  ([adapter-anthropic.md](adapter-anthropic.md), Section 4) exist once per boot window: they are
  created empty at its first `session_start`, survive session replacement (`session_shutdown`
  with reason `new`, `resume`, or `fork`), and are discarded on `session_shutdown` with reason
  `reload` or `quit`.

> Note (non-normative): on session replacement the host calls the extension factory again with
> a new `pi` and a new bus, without loading the module again, so this state lives outside the
> factory call; events of the boot window go to the latest bus.

## 2. Cache

A cache entry exists per provider served by an adapter and holds:

| Item              | Contract                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------- |
| capture           | The latest capture: facet values, `capturedAt`, capture reason; absent before the first. |
| failure           | The latest failed refresh's reason and time; cleared by every success.                   |
| failure count     | Consecutive refreshes that failed or succeeded with a capture reason.                    |
| backoff end       | Time before which no refresh starts.                                                     |
| last start        | Time the latest refresh started.                                                         |
| in-flight refresh | The running refresh, if any.                                                             |

- The freshness period is the adapter spec's value, replaced by the provider's `ttlSeconds`
  configuration ([config-file.md](config-file.md)). A capture is fresh while
  `now < capturedAt + freshness period`, and no header observation for the provider was
  recorded after last start.
- The serving age is `max(3600 seconds, freshness period)`.
- Provider entries are derived from the cache entry, configuration, and inventory at reply or
  render time ([billing-state.md](billing-state.md), Section 2); `models` and prices MUST NOT be
  cached, nor are severities other than adapter-spec overrides.

## 3. Refresh

A refresh runs the provider's adapter once and updates the cache entry.

A refresh is requested in a mode:

| `mode`    | What the refresh layer does               |
| --------- | ----------------------------------------- |
| `cached`  | Requests no refresh.                      |
| `auto`    | Requests one when the entry is not fresh. |
| `refresh` | Requests one regardless of freshness.     |

- Triggers: a query in `auto` or `refresh` mode, the
  `/purse` command, and the status line ([user-interface.md](user-interface.md)). pi-dent-purse MUST
  NOT refresh, issue a request, or run a command from the extension factory, from
  `session_shutdown` handlers, or on a timer, nor from `session_start` handlers except the
  status line's `auto` request.
- Eligibility: no refresh starts for a provider without an adapter, a free provider, a
  provider whose `adapter` configuration is `false`, a provider other than a tool provider
  without an inventory model, or
  a requester whose abort signal is already aborted; the requester receives the current entry
  at once.
- Single-flight: a refresh requested while one is in flight for the provider joins it. A
  requester's abort MUST NOT abort a refresh; the aborting requester receives the current entry
  at once.
- Suppression: a requested refresh does not start, and the requester receives the current
  entry at once, when `now` < backoff end, or when the request is not `auto` and less than the
  minimum interval of 30 seconds has passed since last start. A bypassing refresh ignores
  suppression.
- Start: a started refresh sets last start. With `PURSE_OFFLINE` it then fails at once with
  `offline`. Otherwise it resolves the credentials and runs the checks of
  [adapter-contract.md](adapter-contract.md), Section 3 (a check failing, or credential
  resolution throwing, is the refresh's failure with that reason, or `internal`), then calls
  `run` with the dependencies of [adapter-contract.md](adapter-contract.md), Section 2.
- Deadline: a refresh MUST settle within 15 seconds of its start, credential resolution
  included; on expiry the adapter's signal aborts and the refresh fails with `deadline`. A
  result arriving later is ignored.
- Outcome: a refresh fails when the adapter returns a whole failure, with its reason and
  `retryAfter`, or when the result has `firstFailure`, no facet of its `facets` with state
  `known`, and no `captureReason`, with `firstFailure`. Otherwise it
  succeeds: the result's facets become the capture, with `capturedAt` the result's or else the
  completion time, and capture reason the result's `captureReason`.
- A failure keeps the previous capture and records the failure. A failure with `offline` is
  recorded but changes neither the failure count nor the backoff end. A failure, or a success
  with a capture reason, increments the failure count and sets backoff end = completion time +
  the backoff of its reason; for a success that is the capture reason, with the `retryAfter` of
  `firstFailure` when `firstFailure.reason` equals the capture reason:

| Reason                                                                                                                                              | Backoff                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `http-401`, `http-403`, `no-credentials`, `unsupported-auth`, `endpoint-mismatch`, `gcloud-missing`, `gcloud-unauthenticated`, `project-unresolved` | 3600 seconds                                                           |
| `http-429`                                                                                                                                          | `retryAfter` seconds clamped to 60–3600; without it, as other reasons. |
| other                                                                                                                                               | `min(60 × 2^(failure count − 1), 3600)` seconds.                       |

- Every success clears the recorded failure; a success without capture reason also clears the
  failure count and backoff end.
- Every completed refresh emits `purse:changed:v1` ([query-protocol.md](query-protocol.md),
  Section 5) for its provider.

## 4. Specification gaps

- `decision`: whether captures are shared between concurrent pi processes.
