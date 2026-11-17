# Exa adapter specification

This document specifies the adapter for provider `exa`, a tool provider
([adapter-contract.md](adapter-contract.md), Section 1) for the Exa search API, read with an Exa
team service key. Shared behavior is owned by [adapter-contract.md](adapter-contract.md).

## 1. Constants

| Constant            | Value                                              |
| ------------------- | -------------------------------------------------- |
| provider origin     | none                                               |
| credential variable | `PURSE_EXA_SERVICE_KEY`                            |
| host allowlist      | `https://admin-api.exa.ai`                         |
| freshness period    | 900 seconds                                        |
| body cap            | credits 16 KiB; key list 256 KiB; key usage 64 KiB |
| exposed facets      | `balance`, `limits`                                |

Every request carries header `x-api-key: <apiKey>` and no other header of the adapter's own. Any
credential is accepted: the adapter has no credential check of its own. A body that is not a JSON
object is `bad-response`.

## 2. Balance

`GET https://admin-api.exa.ai/team-management/credits`.

- A failed request leaves `balance` `unavailable` with its reason.
- `credits_usd`, when a finite number, yields one item: `amount` that number, `currency` `USD`,
  `currencyAssumed` `false`, `gatesUsage` `true`. Otherwise the body is `bad-response`: `balance`
  is `unavailable` with it, and the request failed ([adapter-contract.md](adapter-contract.md),
  Section 2).

## 3. Limits

`limits` holds one window, the team's spend over the 30 days before the run. It is computed from
the key list and key usage requests below. The credits request of Section 2 is issued first and
the key list request right after it, without waiting for the credits response:

1. Key list: `GET https://admin-api.exa.ai/team-management/api-keys`. A body whose `apiKeys` is
   not an array, or holds an element that is not an object whose `publicId` matches the
   [ECMAScript] pattern `^[A-Za-z0-9_-]{1,128}$`, is `bad-response`; otherwise more than 32
   elements is `response-too-large`. After either, no key usage request is made. No other field of the body is read.
2. Key usage, once per distinct `publicId`, in key list order, at most 4 in flight at a time:
   `GET https://admin-api.exa.ai/team-management/api-keys/<publicId>/usage?start_date=<start>&end_date=<end>`,
   `<end>` the clock's time at the start of `run` and `<start>` 2592000 seconds before it, each
   in the [RFC 3339] form `YYYY-MM-DDTHH:MM:SSZ` in UTC, seconds rounded down. A body whose
   `total_cost_usd` is not a finite number ≥ 0 is `bad-response`. No other field is read.

The first failure among the key list and key usage requests, in issue order, leaves `limits` `unavailable` with its
reason; a key usage request is not issued once one has failed. Otherwise the window is:

| Field           | Value                                                                 |
| --------------- | --------------------------------------------------------------------- |
| `id`            | `spend-30d`                                                           |
| `label`         | `30d spend`                                                           |
| `unit`          | `currency`                                                            |
| `currency`      | `USD`                                                                 |
| `used`          | Sum of every `total_cost_usd`, rounded to two decimals; 0 for no key. |
| `limit`         | `null`                                                                |
| `percent`       | `null`                                                                |
| `resetsAt`      | `null`                                                                |
| `windowSeconds` | 2592000                                                               |
| `models`        | `null`                                                                |
| `source`        | `endpoint`                                                            |

> Note (non-normative): the key list body carries every key's secret in its `id` field, which is
> why only `publicId` is read.

## 4. Normative references

- [ECMAScript] ECMAScript 2023 Language Specification, ECMA-262 14th edition, clause 22.2
  (RegExp): the syntax and matching of the pattern in Section 3, compiled with the `u` flag.
- [RFC 3339] Date and Time on the Internet: Timestamps, G. Klyne and C. Newman, 2002, Section
  5.6: the `start_date` and `end_date` values of Section 3.

## 5. Specification gaps

- `decision`: whether per-key budgets (`budgetCents`, `isOverBudget`) or `expiring_credits` are
  wanted.
- `decision`: whether a team with overage enabled, which keeps serving at a zero balance, needs a
  `gatesUsage` of `false`.
