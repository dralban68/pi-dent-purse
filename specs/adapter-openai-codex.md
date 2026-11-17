# OpenAI Codex adapter specification

This document specifies the adapter for provider `openai-codex` with ChatGPT subscription OAuth
authentication. Shared behavior is owned by [adapter-contract.md](adapter-contract.md).

## 1. Constants

| Constant         | Value                 |
| ---------------- | --------------------- |
| provider origin  | `https://chatgpt.com` |
| host allowlist   | `https://chatgpt.com` |
| freshness period | 120 seconds           |
| body cap         | 16 KiB                |
| exposed facets   | `plan`, `limits`      |

## 2. Authentication

After the checks of [adapter-contract.md](adapter-contract.md), Section 3: `oauth` MUST be
`true`; otherwise the result is a whole failure with `unsupported-auth` and no request is made.
The token is the `apiKey` of the first `credentials` call.

## 3. Usage request

`GET https://chatgpt.com/backend-api/wham/usage` with header `authorization: Bearer <token>`.
A failed request makes `plan` and `limits` `unavailable` with its reason. A body that is not an
object is `bad-response`.

## 4. Limits

From `rate_limit`, in this order:

| Key                | `id`        | `label` | default `windowSeconds` |
| ------------------ | ----------- | ------- | ----------------------- |
| `primary_window`   | `five-hour` | `5h`    | 18000                   |
| `secondary_window` | `weekly`    | `7d`    | 604800                  |

- A `rate_limit` or key that is absent or not an object yields no window.
- Each window: `unit` `percent`; `percent` = `used_percent` (a number, already 0–100);
  `resetsAt` = `reset_at` (epoch seconds) × 1000; `windowSeconds` = `limit_window_seconds` when
  a number greater than 0, else the default; non-numbers are `null`; `used`, `limit`, `models`
  `null`; `source` `endpoint`.
- No window: `limits` is `unavailable` with `empty-response`.

## 5. Plan

`plan_type`, when a string that is not empty after cleaning
([billing-state.md](billing-state.md), Section 7); otherwise `plan` is `unavailable` with
`empty-response`.

## 6. Specification gaps

- `decision`: whether `credits` (balance in Codex credits, not a currency) is wanted.
- `decision`: whether `code_review_rate_limit`, `additional_rate_limits`, and `model_usage` are
  wanted; live responses held `null` for the first two.
- `decision`: whether limits for provider `openai` with an API key are wanted, from the
  documented `x-ratelimit-*` response headers; no API-key endpoint reports a balance.
- `live check`: whether inference response headers carry the window utilization, for a header
  fallback as for `anthropic`.
