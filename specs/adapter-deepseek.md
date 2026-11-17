# DeepSeek adapter specification

This document specifies the adapter for provider `deepseek` with an API key. Shared behavior is
owned by [adapter-contract.md](adapter-contract.md).

## 1. Constants

| Constant         | Value                      |
| ---------------- | -------------------------- |
| provider origin  | `https://api.deepseek.com` |
| host allowlist   | `https://api.deepseek.com` |
| freshness period | 300 seconds                |
| body cap         | 16 KiB                     |
| exposed facets   | `balance`, `limits`        |

## 2. Balance

`GET https://api.deepseek.com/user/balance` with header `authorization: Bearer <apiKey>`. Any
credential type is accepted: the adapter has no credential check of its own.

- A failed request leaves `balance` `unavailable` with its reason; status 402 is an
  `http-error` like any other ([adapter-contract.md](adapter-contract.md), Section 4).
- A body that is not an object with an array `balance_infos` is `bad-response`: `balance` is
  `unavailable` with it, and the request failed
  ([adapter-contract.md](adapter-contract.md), Section 2).
- Each element whose `currency` matches the [ECMAScript] pattern `^[A-Z]{3}$` and whose `total_balance` string matches
  `^-?[0-9]+(\.[0-9]+)?$` and converts to a finite number yields one item: `amount` = that
  number, `currency`,
  `currencyAssumed` `false`, `gatesUsage` `true`. A repeated currency keeps the first.
- When `is_available` is `false`, every item's severity is `exhausted`.
- No item: `balance` is `unavailable` with `empty-response`.

## 3. Limits

`limits` is known in every result that is not a whole failure, without a request, with these
windows, their `models` exactly as written whether or not the inventory has those ids (`unit`
`concurrent-requests`, `used`, `percent`, `resetsAt`, and `windowSeconds` `null`, `source`
`documented`):

| `id`                          | `label`             | `limit` | `models`              |
| ----------------------------- | ------------------- | ------- | --------------------- |
| `concurrency-deepseek-flash`  | `concurrency flash` | 2500    | `["deepseek-flash"]`  |
| `concurrency-deepseek-v4-pro` | `concurrency pro`   | 500     | `["deepseek-v4-pro"]` |

## 4. Price schedule

The adapter's built-in price schedule ([prices.md](prices.md), Section 3) is the off-peak
discount, multiplier `0.5`, time zone UTC, windows:

| `days`        | `from`  | `to`    |
| ------------- | ------- | ------- |
| `[1,2,3,4,5]` | `00:00` | `01:00` |
| `[1,2,3,4,5]` | `04:00` | `06:00` |
| `[1,2,3,4,5]` | `10:00` | `24:00` |
| `[0,6]`       | `00:00` | `24:00` |

## 5. Normative references

- [ECMAScript] ECMAScript 2023 Language Specification, ECMA-262 14th edition, clause 22.2
  (RegExp): the syntax and matching of the patterns in this specification, compiled with the
  `u` flag.

## 6. Specification gaps

- `decision`: whether to model Chinese public holidays, which are off-peak, in the price
  schedule.
- `decision`: whether a CNY-settled account is priced from the published CNY prices.
- `decision`: whether spend history is wanted; no API-key endpoint provides it.
