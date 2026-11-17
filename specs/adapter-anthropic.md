# Anthropic adapter specification

This document specifies the adapter for provider `anthropic` with subscription OAuth
authentication. Shared behavior is owned by [adapter-contract.md](adapter-contract.md).

## 1. Constants

| Constant         | Value                       |
| ---------------- | --------------------------- |
| provider origin  | `https://api.anthropic.com` |
| host allowlist   | `https://api.anthropic.com` |
| freshness period | 120 seconds                 |
| body cap         | 64 KiB                      |
| exposed facets   | `limits`                    |

## 2. Authentication

After the checks of [adapter-contract.md](adapter-contract.md), Section 3: `oauth` MUST be
`true`; otherwise the result is a whole failure with `unsupported-auth` and no request is made.
The token is the `apiKey` of the first `credentials` call.

## 3. Usage request

`GET https://api.anthropic.com/api/oauth/usage` with headers:

| Header           | Value              |
| ---------------- | ------------------ |
| `authorization`  | `Bearer <token>`   |
| `anthropic-beta` | `oauth-2025-04-20` |

On `http-401`, the adapter MUST call `credentials` once more; when it returns a token that
differs, the adapter repeats the request once with it. When there is no repeat, or the repeat
fails ([adapter-contract.md](adapter-contract.md), Section 2), the usage request's failure is
the first request's `http-401`, whatever the repeat's own reason; a successful repeat's body is
used as below.

A body that is not an object is `bad-response`. Unknown keys are ignored. The provider-wide
windows come first, in this order, then the scoped windows (Section 3.1):

| Body key    | `id`        | `label` | `windowSeconds` | `models` |
| ----------- | ----------- | ------- | --------------- | -------- |
| `five_hour` | `five-hour` | `5h`    | 18000           | `null`   |
| `seven_day` | `weekly`    | `7d`    | 604800          | `null`   |

- A key that is absent, `null`, or not an object yields no window.
- Each window: `unit` `percent`; `percent` = `utilization` (a number, already 0–100);
  `resetsAt` = `resets_at` (an [ISO 8601] date-time with offset) as epoch milliseconds, `null` when
  absent or unparsable; `used`, `limit` `null`; `source` `endpoint`.
- No window from `five_hour` or `seven_day`: the `limits` facet is `unavailable` with
  `empty-response`.

### 3.1 Scoped windows

A scoped window comes from the body's `limits` array, considered per element in body order. An
element is a scoped element when it is an object whose `kind` is `weekly_scoped`, whose `scope`
and `scope.model` are objects, and whose `scope.model.display_name` is present after the
cleaning of [billing-state.md](billing-state.md), Section 7; `<name>` is that cleaned display
name lowercased, and only the first scoped element for a `<name>` is considered. A considered
element yields a window:

| Field           | Contract                                                                       |
| --------------- | ------------------------------------------------------------------------------ |
| `id`            | `weekly-<name>`                                                                |
| `label`         | `7d <name>`                                                                    |
| `models`        | The inventory model ids of the provider whose lowercase form contains `<name>` |
| `windowSeconds` | 604800                                                                         |
| `unit`          | `percent`                                                                      |
| `percent`       | `percent` (a number, already 0–100)                                            |
| `resetsAt`      | `resets_at`, as `resetsAt` above                                               |
| `used`, `limit` | `null`                                                                         |
| `source`        | `endpoint`                                                                     |

- A considered element whose `models` list is empty yields no window.
- A `limits` that is absent or not an array yields none.

## 4. Header observations

purse MUST handle the host `after_provider_response` event and forwarded responses
([query-protocol.md](query-protocol.md), Section 7). When the handler context's current
model has provider `anthropic` and the event headers contain
`anthropic-ratelimit-unified-5h-utilization` or `anthropic-ratelimit-unified-7d-utilization`
(header names compare case-insensitively), it records a header observation for provider
`anthropic`, replacing the previous one, without issuing a request or starting a refresh. A
header observation is `{ observedAt, fiveHour, weekly }`: `observedAt` the current epoch
milliseconds, and each window `{ percent, resetsAt }`:

| Header                                       | Field                                              |
| -------------------------------------------- | -------------------------------------------------- |
| `anthropic-ratelimit-unified-5h-utilization` | `fiveHour.percent` = value (a 0–1 fraction) × 100  |
| `anthropic-ratelimit-unified-5h-reset`       | `fiveHour.resetsAt` = value (epoch seconds) × 1000 |
| `anthropic-ratelimit-unified-7d-utilization` | `weekly.percent` = value × 100                     |
| `anthropic-ratelimit-unified-7d-reset`       | `weekly.resetsAt` = value × 1000                   |

A header that is absent, or whose value, trimmed, is empty or does not parse as a finite
[ECMAScript] number, gives `null`.

When the usage request fails (Section 3) with a reason other than `internal` and a header observation younger than 3600 seconds
(`clock() − observedAt < 3600000`) exists, the
adapter returns, instead of the failure: `limits` known with windows `five-hour` (from `fiveHour`) and
`weekly` (from `weekly`) as in Section 3 except `source` `headers`, `percent` and `resetsAt`
from the observation, both windows present even when unobserved, `capturedAt` the
`observedAt`, and `captureReason` the usage request's failure reason. The checks of Sections 2
and [adapter-contract.md](adapter-contract.md), Section 3 are not usage request failures and
never use the observation.

## 5. Normative references

- [ISO 8601] ISO 8601-1:2019 Date and time — Representations for information interchange,
  Part 1, clause 5.4 (date and time of day): the `resets_at` format of Section 3.
- [ECMAScript] ECMAScript 2023 Language Specification, ECMA-262 14th edition, clause 7.1.4.1.1
  (StringToNumber): the parsing of header values in Section 4.

## 6. Specification gaps

- `live check`: whether one more credentials call recovers from a 401 of the usage endpoint;
  live runs with the host's OAuth token gave 200 and, after repeated calls, 429, never 401.
- `decision`: whether the plan name is wanted; the vendor client's profile endpoint has an
  unverified response shape.
- `decision`: whether `extra_usage` and `spend` are wanted; their units are unverified.
- `decision`: whether the other weekly windows (`seven_day_oauth_apps`, `seven_day_cowork`, and
  others) are wanted; their units are unverified.
- `decision`: whether `weekly_scoped_shares` — a scoped window as a share of the weekly limit,
  which the vendor dashboard shows as "up to 50% of your weekly limit" — and
  `seven_day_breakdown` are wanted; their units are unverified.
- `live check`: whether a response header carries the utilization of a scoped window; the header
  fallback reports only `five-hour` and `weekly`.
- `decision`: whether limits for API-key authentication are wanted, from the documented
  `anthropic-ratelimit-*` request and token headers.
