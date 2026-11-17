# Z.ai adapter specification

This document specifies the adapter for provider `zai` with a GLM Coding Plan API key. Shared
behavior is owned by [adapter-contract.md](adapter-contract.md).

## 1. Constants

| Constant         | Value                       |
| ---------------- | --------------------------- |
| provider origin  | `https://api.z.ai`          |
| host allowlist   | `https://api.z.ai`          |
| freshness period | 300 seconds                 |
| body cap         | 64 KiB                      |
| exposed facets   | `plan`, `balance`, `limits` |

## 2. Requests

The three requests run concurrently, each with header `authorization: Bearer <apiKey>`:

| Request | URL                                                              | Feeds            |
| ------- | ---------------------------------------------------------------- | ---------------- |
| quota   | `https://api.z.ai/api/monitor/usage/quota/limit`                 | `limits`, `plan` |
| plan    | `https://api.z.ai/api/biz/subscription/list`                     | `plan`           |
| balance | `https://api.z.ai/api/biz/account/query-customer-account-report` | `balance`        |

Envelope: a body that is not an object fails with `bad-response`; unless its `success` is `true` and
its `code` is `200`, the request fails with `vendor-error`. A failed request makes the facets it
feeds `unavailable` with its reason, except as Section 4 states.

## 3. Limits

From quota `data.limits[]`; each element is an object, else skipped:

| Condition                                         | `id`                 | `label`    | `unit`     | `windowSeconds`             |
| ------------------------------------------------- | -------------------- | ---------- | ---------- | --------------------------- |
| `type` `CREDIT_LIMIT` or `TOKENS_LIMIT`, `unit` 3 | `five-hour`          | `5h`       | see below  | `number` × 3600, else 18000 |
| `type` `CREDIT_LIMIT` or `TOKENS_LIMIT`, `unit` 6 | `weekly`             | `7d`       | see below  | 604800                      |
| `type` `TIME_LIMIT`                               | `tool-calls-monthly` | `tools/mo` | `requests` | `null`                      |

- `unit` is `credits` for `CREDIT_LIMIT` and `tokens` for `TOKENS_LIMIT`. Other elements are
  skipped; a repeated `id` keeps the first in `data.limits[]` order, whatever its `type`.
- `limit` = `usage`, else `total`; `used` = `currentValue`; `percent` = `percentage` as given,
  negative values included (entry derivation discards them, per
  [billing-state.md](billing-state.md), Section 3); `resetsAt` = `nextResetTime` (epoch milliseconds); for `tool-calls-monthly`
  without `nextResetTime`, the first instant of the next calendar month in UTC. Non-numbers are
  `null`. `models` `null`; `source` `endpoint`.
- No window: `limits` is `unavailable` with `empty-response`.

## 4. Plan

First that applies: the `productName` of the first plan `data[]` object whose `status` is
`VALID`, when it is a string that is not empty after cleaning
([billing-state.md](billing-state.md), Section 7); the quota `data.level` under the same
condition; `unavailable` with the plan request's reason when that request failed; otherwise
`unavailable` with `empty-response`. No other field of either body is read.

## 5. Balance

`data.availableBalance` of the balance body, when a finite number, yields one item: `amount`
that number, `currency` `USD`, `currencyAssumed` `true`, `gatesUsage` `false`. When the balance request
succeeded and the value is not a finite number, `balance` is `unavailable` with `bad-response`.

## 6. Specification gaps

- `decision`: the balance currency; the body carries none.
- `decision`: whether provider `zai-coding-cn` (China host) needs an adapter.
- `decision`: whether `remaining`, `usageDetails`, the usage-history endpoints, or Coding Plan
  error codes in inference responses are wanted.
