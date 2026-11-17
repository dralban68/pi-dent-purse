# Query protocol specification

This document specifies the versioned protocol through which other extensions read billing
state over the host's inter-extension event bus (`pi.events`). The provider entry shape is
owned by [billing-state.md](billing-state.md); refresh behavior by [refresh.md](refresh.md).

## 1. Channels

| Channel            | Direction           | Payload                           |
| ------------------ | ------------------- | --------------------------------- |
| `purse:query:v1`   | consumer → service  | A request (Section 2).            |
| `purse:changed:v1` | service → consumers | A notification (Section 5).       |
| `purse:observe:v1` | emitter → service   | A forwarded response (Section 7). |

The service is pi-dent-purse. The host bus delivers an event synchronously to every listener, in
registration order, during `emit`; a listener's code before its first `await` runs inside
`emit`.

## 2. Request

| Field       | Type                                   | Contract                                                          |
| ----------- | -------------------------------------- | ----------------------------------------------------------------- |
| `providers` | string[]?                              | Provider ids. Omitted: every known provider. Duplicates collapse. |
| `maxWaitMs` | number?                                | Finite and ≥ 0: caps the reply's settlement time (Section 3).     |
| `mode`      | `"cached"` \| `"auto"` \| `"refresh"`? | Default `cached`.                                                 |
| `signal`    | AbortSignal?                           | Abort cancels the request.                                        |
| `respond`   | `(reply: Promise<Reply>) => boolean`   | Required. The offer callback.                                     |

A provider id matches the [ECMAScript] pattern `^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$`; a
`providers` string that does not is not served and has no entry in the reply. A
`signal` MUST be an object whose `aborted` is a boolean and whose `addEventListener` and
`removeEventListener` are functions. A field whose value is `undefined` is omitted. Unknown
request fields are ignored.

`mode` is the mode of [refresh.md](refresh.md), Section 3, applied per served provider.

A requested refresh is subject to eligibility, single-flight, minimum interval, and backoff
([refresh.md](refresh.md), Section 3); a query never requests a bypassing refresh. With status
`ok`, a provider's entry is the one [refresh.md](refresh.md), Section 2 derives once that
provider's requested refresh, if any, settled, or, when that refresh has not settled by the time
Section 3 requires the reply to settle, the one derived at that time; the providers are served
concurrently.

## 3. Service obligations

- The service listener MUST ignore a payload that is not an object or whose `respond` is not a
  function.
- Otherwise it MUST call `respond` exactly once, synchronously inside `emit`, with a promise of
  the reply. When `respond` returns anything but `true`, the service MUST NOT request a
  refresh, call `respond` again, or call a method of `signal`.
- The reply promise MUST NOT reject. When `respond` returned `true` and the request carried
  `maxWaitMs`, it MUST settle no later than `maxWaitMs` milliseconds after the offer; a reply
  unsettled then settles `ok`, and its refreshes continue.
- `status` selection, first that applies:
  1. a field violates Section 2 → `bad-request`; a `providers` string outside the pattern is
     not a violation;
  2. no live context ([refresh.md](refresh.md), Section 1) → `not-ready`;
  3. `signal` is aborted while a provider entry is not ready (none is with no provider to
     serve) → `cancelled`, settled at abort;
  4. otherwise `ok`.
- Answering MUST have no side effect besides refreshes and their consequences
  ([refresh.md](refresh.md), [user-interface.md](user-interface.md)): no notification, no
  session entry or message.
- Each reply MUST be a new object that is a JSON-compatible value sharing no mutable state with
  pi-dent-purse or with other replies.

## 4. Reply

| Field         | Type                                                | Contract                                                                                                                       |
| ------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `protocol`    | `1`                                                 |                                                                                                                                |
| `status`      | `ok` \| `not-ready` \| `bad-request` \| `cancelled` | Section 3.                                                                                                                     |
| `generatedAt` | number                                              | Epoch milliseconds at settlement.                                                                                              |
| `providers`   | Record\<string, ProviderEntry>                      | With `ok`: one provider entry per served provider id (none for `providers: []`); key order is not significant. Otherwise `{}`. |

## 5. Change notification

A change notification is `{ "protocol": 1, "providers": [<provider id>, …] }`, emitted when
[refresh.md](refresh.md), Sections 1 and 3 require. It carries no billing data; consumers re-query,
`cached` mode sufficing.

## 6. Consumer obligations

- A consumer emits a request with a `respond` that accepts only its first call (returning
  `true`) and returns `false` afterwards.
- When `emit` returns and `respond` was never called, the outcome is `no-service`: pi-dent-purse is
  absent.
- A consumer applies its own deadline to an accepted reply: with `maxWaitMs` the bound is
  `maxWaitMs` milliseconds plus a margin; without it, the refresh deadline of 15 seconds
  ([refresh.md](refresh.md), Section 3) plus a margin. Expiry is the outcome `timeout`.
- `no-service` and `timeout` are consumer-local outcomes; the service MUST NOT send them.
- A consumer MUST ignore unknown fields. An unknown `status` of a provider entry is treated as
  `unavailable`; an unknown reason code, unit, source, or window id is kept opaque.

## 7. Forwarded response

A forwarded response is `{ "protocol": 1, "provider": <provider id>, "headers": { <name>: <value>, … } }`,
emitted by an extension for an inference response of provider `provider` that the host's
`after_provider_response` event does not reach pi-dent-purse with, such as one of a session the
extension created. `headers` holds the response headers, every value a string.

- pi-dent-purse MUST ignore a payload that is not an object, whose `protocol` is not `1`, whose
  `provider` is not a string, or whose `headers` is not an object with only string values.
- Otherwise, with a boot window ([refresh.md](refresh.md), Section 1), pi-dent-purse handles it as an
  `after_provider_response` event with those headers whose current model has provider
  `provider` ([adapter-anthropic.md](adapter-anthropic.md), Section 4;
  [adapter-amd.md](adapter-amd.md), Section 2). It sends no reply.
- An emitter MUST NOT forward a response the host event already reaches pi-dent-purse with, and MUST
  NOT fail its own work when `emit` throws.

## 8. Versioning

Within `v1`, only additions of optional fields, reason codes, units, sources, window ids, and
providers are allowed. Removing or renaming a field, changing a meaning, adding a required
request field, or adding a value to the reply `status`, provider entry `status`, `state`,
`mode`, or `Severity` enumerations requires new channels with suffix `v2`. Before the first
release, a change of meaning within `v1` is allowed by editing this specification.

## 9. Normative references

- [ECMAScript] ECMAScript 2023 Language Specification, ECMA-262 14th edition, clause 22.2
  (RegExp): the syntax and matching of the patterns in this specification, compiled with the
  `u` flag.

## 10. Specification gaps

None.
