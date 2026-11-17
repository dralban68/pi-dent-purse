# AMD adapter specification

This document specifies the adapter for provider `amd`, AMD TokenLab, with an API key. The
vendor has no usage endpoint: limits come only from the response headers of inference requests
the host made. Shared behavior is owned by [adapter-contract.md](adapter-contract.md).

## 1. Constants

| Constant         | Value                          |
| ---------------- | ------------------------------ |
| provider origin  | `https://api.tokenlab.amd.com` |
| host allowlist   | none                           |
| freshness period | 60 seconds                     |
| body cap         | none                           |
| exposed facets   | `limits`                       |

The adapter makes no request and runs no command. Any credential is accepted: the adapter has
no credential check of its own.

## 2. Header observations

purse MUST handle the host `after_provider_response` event and forwarded responses
([query-protocol.md](query-protocol.md), Section 7). When the handler context's current
model has provider `amd` and the event headers contain `x-ratelimit-limit-user-budget-usd` or
`x-ratelimit-limit-user-rpm` (header names compare case-insensitively), it records a header
observation for provider `amd`, replacing the previous one, without issuing a request or
starting a refresh. The header observation is `{ observedAt, budget, rpm }`: `observedAt` the
current epoch milliseconds, and:

| Header                                  | Field                                            |
| --------------------------------------- | ------------------------------------------------ |
| `x-ratelimit-limit-user-budget-usd`     | `budget.limit`                                   |
| `x-ratelimit-used-user-budget-usd`      | `budget.used`                                    |
| `x-ratelimit-remaining-user-budget-usd` | `budget.remaining`                               |
| `x-ratelimit-reset-user-budget-usd`     | `budget.resetsAt` = value (epoch seconds) × 1000 |
| `x-ratelimit-limit-user-rpm`            | `rpm.limit`                                      |
| `x-ratelimit-remaining-user-rpm`        | `rpm.remaining`                                  |

A header that is absent, or whose value, trimmed, is empty or does not parse as a finite
[ECMAScript] number, gives `null`.

## 3. Limits

Without a header observation, `limits` is `unavailable` with `not-observed`. Otherwise the result
has `capturedAt` the observation's `observedAt` and `limits` known with these windows, in this
order; a window whose `limit` is `null` is omitted, and with neither window `limits` is
`unavailable` with `not-observed`:

| Field           | `budget` window                                                                                | `rpm` window                                                 |
| --------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `id`            | `budget`                                                                                       | `rpm`                                                        |
| `label`         | `budget`                                                                                       | `rpm`                                                        |
| `unit`          | `currency`, `currency` `USD`                                                                   | `requests`                                                   |
| `limit`         | `budget.limit`                                                                                 | `rpm.limit`                                                  |
| `used`          | `budget.used`; when `null`, `budget.limit − budget.remaining` when both are known; else `null` | `rpm.limit − rpm.remaining` when both are known, else `null` |
| `percent`       | `null`                                                                                         | `null`                                                       |
| `resetsAt`      | `budget.resetsAt`                                                                              | `observedAt` + 60000                                         |
| `windowSeconds` | `null`                                                                                         | 60                                                           |
| `models`        | `null`                                                                                         | `null`                                                       |
| `source`        | `headers`                                                                                      | `headers`                                                    |

> Note (non-normative): the rpm window passes its reset a minute after the observation, so its
> `used` and `percent` then read unknown ([billing-state.md](billing-state.md), Section 3).

## 4. Normative references

- [ECMAScript] ECMAScript 2023 Language Specification, ECMA-262 14th edition, clause 7.1.4.1.1
  (StringToNumber): the parsing of header values in Section 2.

## 5. Specification gaps

- `live check`: the length of the budget window; one observed reset was a month ahead.
- `decision`: whether a budget observation older than the serving age
  ([refresh.md](refresh.md), Section 2) is still worth serving; it is not served now.
