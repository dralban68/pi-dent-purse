# Billing state specification

This document specifies the billing state: the normalized, per-provider record purse derives
from adapters, prices, and configuration, and serves through the
[query protocol](query-protocol.md) and the [user interface](user-interface.md). How captures
are made and cached is owned by [refresh.md](refresh.md); prices by [prices.md](prices.md).

## 1. Provider entry

A provider entry is a JSON-compatible object:

| Field        | Type                                   | Contract                                                                                                                                                                                                                                                                          |
| ------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`   | string                                 | The provider id.                                                                                                                                                                                                                                                                  |
| `status`     | Status                                 | Section 2.                                                                                                                                                                                                                                                                        |
| `reason`     | ReasonCode \| `null`                   | Section 6. First that applies: the recorded failure's reason; the served capture's capture reason ([refresh.md](refresh.md)); for `partial`, the reason of the first `unavailable` exposed facet in the order `limits`, `balance`, `plan`; as Section 2 states; otherwise `null`. |
| `adapter`    | string \| `null`                       | Section 2.                                                                                                                                                                                                                                                                        |
| `capturedAt` | number \| `null`                       | Epoch milliseconds of the served capture; `null` without one.                                                                                                                                                                                                                     |
| `freshUntil` | number \| `null`                       | `capturedAt` plus the freshness period; `null` without a capture.                                                                                                                                                                                                                 |
| `stale`      | boolean                                | `true` when a capture is served at or after `freshUntil`.                                                                                                                                                                                                                         |
| `severity`   | Severity                               | Provider severity (Section 5).                                                                                                                                                                                                                                                    |
| `plan`       | Facet\<string>                         | The plan name.                                                                                                                                                                                                                                                                    |
| `balance`    | Facet\<Balance[]>                      | Section 4.                                                                                                                                                                                                                                                                        |
| `limits`     | Facet\<LimitWindow[]>                  | Section 3.                                                                                                                                                                                                                                                                        |
| `models`     | Record\<string, `{ price, severity }`> | Keyed by inventory model id of the provider: `price` per [prices.md](prices.md), `severity` per Section 5.                                                                                                                                                                        |

A facet is `plan`, `balance`, or `limits`. A facet value is exactly one of:

| Shape                                                | Meaning                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `{ "state": "known", "value": <T> }`                 | The value was captured.                                                              |
| `{ "state": "not-exposed" }`                         | The facet is not an exposed facet of the provider's adapter, or there is no adapter. |
| `{ "state": "unavailable", "reason": <ReasonCode> }` | The adapter reports this facet but the served capture lacks it.                      |

- An unknown number MUST be `null` or its facet `unavailable`; it MUST NOT be `0`.
- A known `limits` or `balance` value MUST NOT be an empty array.

## 2. Status

The status is the first row whose condition holds:

| `status`           | Condition                                                                                                               | Facets                                                  | `models`         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------- |
| `unknown-provider` | The provider has no inventory model and is not a tool provider ([adapter-contract.md](adapter-contract.md), Section 1). | All `not-exposed`.                                      | `{}`             |
| `free`             | The provider is a free provider ([config-file.md](config-file.md)).                                                     | All `not-exposed`.                                      | Inventory models |
| `no-adapter`       | The provider has no adapter, or configuration disables it.                                                              | All `not-exposed`.                                      | Inventory models |
| `ok`               | A capture is served and no exposed facet is `unavailable`.                                                              | From the capture.                                       | Inventory models |
| `partial`          | A capture is served and an exposed facet is `unavailable`.                                                              | From the capture.                                       | Inventory models |
| `unavailable`      | A failure is recorded ([refresh.md](refresh.md), Section 2).                                                            | Exposed facets `unavailable` with the entry's `reason`. | Inventory models |
| `not-collected`    | Otherwise.                                                                                                              | Exposed facets `unavailable` with `not-collected`.      | Inventory models |

A capture is served when the cache entry holds one whose age (`now − capturedAt`) is less than
the serving age ([refresh.md](refresh.md), Section 2). An exposed facet that the served
capture lacks, or holds as `not-exposed`, is `unavailable` with `internal`; a capture's facet
that is not exposed is ignored. For `unknown-provider`, `free`, and `no-adapter`,
`reason`, `adapter`, `capturedAt`, and `freshUntil` are `null` and `stale` is `false`; otherwise
`adapter` is the provider id. For `not-collected`, `reason` is `not-collected`.

## 3. Limit window

| Field           | Type               | Contract                                                                                                 |
| --------------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `id`            | string             | Stable within the provider; values fixed by the adapter spec.                                            |
| `label`         | string             | Short display label fixed by the adapter spec.                                                           |
| `unit`          | Unit               | Unit of `used` and `limit`.                                                                              |
| `used`          | number \| `null`   | Amount consumed in the current window.                                                                   |
| `limit`         | number \| `null`   | Allowance of the window.                                                                                 |
| `percent`       | number \| `null`   | Share of the allowance consumed, 0 or greater; above 100 when over the allowance.                        |
| `resetsAt`      | number \| `null`   | Epoch milliseconds when the window resets.                                                               |
| `windowSeconds` | number \| `null`   | Window length; `null` for a static or unknown length.                                                    |
| `models`        | string[] \| `null` | Model ids the window applies to; `null` for the whole provider. An id need not be an inventory model id. |
| `currency`      | string?            | Present only when `unit` is `currency`: an uppercase [ISO 4217] code.                                    |
| `source`        | Source             | How the window was obtained.                                                                             |
| `severity`      | Severity           | Section 5.                                                                                               |

| Unit                  | Meaning                                                    |
| --------------------- | ---------------------------------------------------------- |
| `percent`             | Only `percent` is reported; `used` and `limit` are `null`. |
| `credits`             | Vendor plan credits.                                       |
| `tokens`              | Tokens.                                                    |
| `requests`            | Requests or tool calls.                                    |
| `concurrent-requests` | Requests in flight at one time.                            |
| `currency`            | Money in `currency`.                                       |

| Source       | Meaning                                                            |
| ------------ | ------------------------------------------------------------------ |
| `endpoint`   | Read from, or computed from, a vendor or cloud endpoint.           |
| `headers`    | Read from response headers of inference requests the host made.    |
| `documented` | A constant from the adapter spec; `used` and `percent` are `null`. |

A window whose `resetsAt` is at or before the derivation time is past its reset: its `used` and
`percent` are `null`, whatever was captured.

`percent` derivation, applied at the derivation time to a window that is not past its reset,
first rule that applies:

1. the captured `percent` is a finite number ≥ 0: that value;
2. `used` and `limit` are known and `limit` > 0: `used / limit × 100`, rounded to one decimal;
3. `used` is known and `limit` is `0`: `100`;
4. otherwise `null`.

## 4. Balance

| Field             | Type     | Contract                                                                                    |
| ----------------- | -------- | ------------------------------------------------------------------------------------------- |
| `amount`          | number   | Finite; negative when owed.                                                                 |
| `currency`        | string   | Uppercase [ISO 4217] code.                                                                  |
| `currencyAssumed` | boolean  | `true` when the vendor reports no currency and the adapter spec assigns it.                 |
| `gatesUsage`      | boolean  | `true` when an exhausted balance stops requests to the provider; fixed by the adapter spec. |
| `severity`        | Severity | Section 5.                                                                                  |

An adapter MUST NOT sum amounts across currencies; one item per currency.

## 5. Severity

`Severity` is one of `ok`, `low`, `critical`, `exhausted`, `unknown`; the order of gravity is
`ok` < `low` < `critical` < `exhausted`. `low` and `critical` thresholds are the configured
percentages ([config-file.md](config-file.md)).

- An adapter-spec override is the severity an adapter captures on a limit window or balance
  item; every other severity is derived at the derivation time.
- Limit window: past its reset (Section 3) → `unknown`; else an adapter-spec override applies;
  else `percent` `null` → `unknown`;
  `percent` ≥ 100 → `exhausted`; ≥ critical → `critical`; ≥ low → `low`; else `ok`.
- Balance item: an adapter-spec override applies first; else `amount` ≤ 0 → `exhausted`;
  `amount` below the provider's `lowBalance` ([config-file.md](config-file.md), Section 2), in
  the item's own currency → `low`; else `ok`. Without `lowBalance`, no item is `low`.
- Provider severity: the gravest severity among limit windows with `models` `null` and balance
  items with `gatesUsage` `true`, ignoring `unknown`; `unknown` when none remains. A `free`
  entry has `ok`; `no-adapter`, `unknown-provider`, `not-collected`, and `unavailable` entries
  have `unknown`.
- Model severity: as provider severity, additionally counting limit windows whose `models`
  contains the model id.

## 6. Reason codes

| `ReasonCode`             | Meaning                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `not-collected`          | No capture is served and no failure is recorded.                                   |
| `offline`                | Refreshes are disabled by `PURSE_OFFLINE` ([config-file.md](config-file.md)).      |
| `no-credentials`         | The host resolves no credential for the provider.                                  |
| `unsupported-auth`       | The provider's credential type is not one the adapter can use.                     |
| `endpoint-mismatch`      | A base URL the host uses for the provider is not on the adapter's provider origin. |
| `network`                | A request failed before a response arrived.                                        |
| `timeout`                | A request or command exceeded its own deadline.                                    |
| `deadline`               | The refresh exceeded its overall deadline.                                         |
| `redirect`               | A response was a redirect.                                                         |
| `response-too-large`     | A response body or command output exceeded its cap.                                |
| `http-401`               | A response had status 401.                                                         |
| `http-403`               | A response had status 403.                                                         |
| `http-429`               | A response had status 429.                                                         |
| `http-error`             | A response had another non-2xx status.                                             |
| `bad-response`           | A body is not JSON or violates the shape the adapter spec requires.                |
| `vendor-error`           | A well-formed body reports failure in its own envelope.                            |
| `empty-response`         | A well-formed body carries no data for the facet.                                  |
| `not-observed`           | No inference response of the provider has carried the headers the facet needs.     |
| `gcloud-missing`         | The `gcloud` executable was not found.                                             |
| `gcloud-unauthenticated` | `gcloud` has no usable account.                                                    |
| `gcloud-failed`          | `gcloud` failed otherwise or printed unusable output.                              |
| `project-unresolved`     | The cloud project owning the provider's API key could not be determined.           |
| `internal`               | An unexpected failure inside purse.                                                |

## 7. Content restrictions

- A field MUST NOT carry a credential, an account identifier (email, user, organization, workspace,
  customer, billing account, project, or key id or name), a URL, a response header value, or
  vendor response text other than the strings an adapter spec names.
- Every vendor string an adapter spec copies into a field MUST have control characters ([Unicode] general category `Cc`)
  removed, be trimmed, and be cut to 64 [Unicode] code points; an empty result is absent. The adapter
  applies this before returning its result.
- Number fields MUST be finite; a non-finite vendor number is absent.

## 8. Normative references

- [ISO 4217] ISO 4217:2015 Codes for the representation of currencies, alphabetic codes: the
  `currency` fields of Sections 3 and 4.
- [Unicode] The Unicode Standard, Version 15.0, clause 3.4 (code points) and clause 4.5
  (general category): vendor string cleaning in Section 7.

## 9. Specification gaps

None.
