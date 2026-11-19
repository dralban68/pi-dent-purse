# Antigravity adapter specification

This document specifies the adapter for provider `antigravity` with Google account OAuth
authentication (Google Antigravity / Cloud Code Assist). The plan, shared quota pools, and
credits come from the service's usage RPCs, called with the OAuth access token the host holds.
Shared behavior is owned by [adapter-contract.md](adapter-contract.md).

## 1. Constants

| Constant         | Value                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| provider origin  | `https://daily-cloudcode-pa.googleapis.com`                                                                                             |
| host allowlist   | `https://daily-cloudcode-pa.googleapis.com`, `https://daily-cloudcode-pa.sandbox.googleapis.com`, `https://cloudcode-pa.googleapis.com` |
| freshness period | 300 seconds                                                                                                                             |
| body cap         | 1 MiB                                                                                                                                   |
| exposed facets   | `plan`, `limits`                                                                                                                        |

## 2. Authentication

After the checks of [adapter-contract.md](adapter-contract.md), Section 3: `oauth` MUST be
`true`; otherwise the result is a whole failure with `unsupported-auth` and no request is made.
The credential is the provider's `apiKey` string, which the host stores as a JSON object:
it MUST parse as an object whose `token` and `projectId` are strings matching
`^[\x21-\x7e]+$`; otherwise the result is a whole failure with `unsupported-auth` and no
request is made. The `token` string is the access token of Sections 3 and 4. The access token
and the `projectId` MUST NOT appear outside the requests of Sections 3 and 4.

## 3. Quota summary

First request of a refresh. `POST
https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` with headers
`authorization: Bearer <token>`, `content-type: application/json`, and
`user-agent: antigravity/cli/1.5.5 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)`,
body `{}`. A body that is not an object is `bad-response`.

Each object of `groups[]` is a quota pool; each object of its `buckets[]` yields at most one
window. When a group's `displayName` is a string that survives cleaning
([billing-state.md](billing-state.md), Section 7), let `<group>` be that cleaned string
lowercased with a single trailing `" models"` or `" model"` removed (and any resulting trailing
whitespace trimmed), and let its family tokens be the non-empty trimmed parts of splitting
`<group>` on `" and "`. The group tag is those family tokens joined with `"/"` (absent when no
family token remains); when the group has a tag, its matching models are the provider's
inventory model ids whose lowercase form contains at least one family token with internal
whitespace runs replaced by `"-"`, in inventory order (an empty array when none match); when
there is no group tag, its matching models are `null`.

From a bucket's cleaned `displayName` lowercased (when present), the duration is the first that
applies:

| Match                                                                | Duration token | `windowSeconds` |
| -------------------------------------------------------------------- | -------------- | --------------- |
| contains `five hour`, `5 hour`, `5-hour`, or standalone word `5h`    | `5h`           | 18000           |
| contains `weekly`, `seven day`, `7 day`, `7-day`, or standalone `7d` | `7d`           | 604800          |
| otherwise                                                            | none           | `null`          |

- A bucket is skipped when neither its `bucketId` nor its `displayName` is a string that
  survives cleaning ([billing-state.md](billing-state.md), Section 7), or its
  `remainingFraction` is not a finite number in the inclusive range 0 to 1.
- `id`: the cleaned `bucketId`, else the cleaned `displayName`; a repeated `id` keeps the
  first, in response order.
- `label`: when the bucket has a duration token, `<duration> <group tag>` when the group has a
  tag, else `<duration>`; otherwise the cleaned `displayName`, else the window's `id`.
- `unit` is `percent`; `used` and `limit` are `null`.
- `percent`: `(1 − remainingFraction) × 100`, rounded to one decimal.
- `resetsAt`: the epoch milliseconds of `resetTime` parsed as an [RFC 3339] date-time;
  `null` when absent or unparsable.
- `windowSeconds`: from the duration table above.
- `models`: the group's matching models above.
- `source` is `endpoint`.

When the request failed, `limits` is `unavailable` with its reason; a status 403 stands for
the service's refusal to report account quotas to a free-tier subscription, and its
`http-403` is kept. Otherwise `limits` is `known` when at least one window of Section 3 or
Section 4 exists, and `unavailable` with `empty-response` when none does.

## 4. Plan and credits

Second request of a refresh. `POST
https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` with the headers of
Section 3, body exactly
`{"metadata":{"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}}`.
A body that is not an object is `bad-response`.

The plan is the first string that survives cleaning, first that applies: `paidTier.name`,
`paidTier.id`, `currentTier.name`, `currentTier.id`. The service reports `currentTier` as the
free tier even when `paidTier` carries the account's subscription. Without one, `plan` is
`unavailable` with `empty-response`.

The credits are the first of `paidTier.availableCredits`, `currentTier.availableCredits`, and
`availableCredits` that is an array. Each object with a finite `creditAmount` yields one
window; the service reports one entry per credit kind:

- `id`: `credits` when `creditType` is not a string that survives cleaning, else
  `credits:<cleaned creditType>`; a repeated `id` keeps the first.
- `label` is `credits`; `unit` is `credits`.
- `limit` is the `creditAmount`: the balance the account holds, which the adapter reports as
  the window's remaining allowance.
- `used`, `percent`, `resetsAt`, `windowSeconds`, and `models` are `null`; `source` is
  `endpoint`.

When the request failed, `plan` is `unavailable` with its reason and its credit windows are
omitted; the windows of Section 3 are kept. The request order of a refresh is Section 3, then
Section 4; `firstFailure` is the first failure in that order, and both requests are made even
when the first fails.

## 5. Normative references

- [RFC 3339] Date and Time on the Internet: Timestamps, G. Klyne and C. Newman, 2002, clause
  5.6: the `resetTime` values of Section 3.

## 6. Specification gaps

- `decision`: failing over to the sandbox and `cloudcode-pa` origins of the host allowlist when
  the provider origin fails, as the reference client does.
- `decision`: per-model quota fractions from `fetchAvailableModels`; the pools are shared, so
  a per-model percentage can mislead.
- `live check`: `bucket.window` as a numeric window length; credit amounts reported as
  strings; whether credits are USD-denominated, which would make them balance items.
