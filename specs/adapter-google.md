# Google adapter specification

This document specifies the adapter for provider `google` with a Gemini API key. Limits, the
usage tier, and the token counts behind the estimated spend come from Google Cloud APIs called
with an access token from the locally installed `gcloud` command-line tool. Shared behavior is
owned by [adapter-contract.md](adapter-contract.md).

## 1. Constants

| Constant         | Value                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| provider origin  | `https://generativelanguage.googleapis.com`                                                                 |
| host allowlist   | `https://apikeys.googleapis.com`, `https://cloudquotas.googleapis.com`, `https://monitoring.googleapis.com` |
| freshness period | 300 seconds                                                                                                 |
| body cap         | 16 KiB for `apikeys.googleapis.com`; 1 MiB otherwise                                                        |
| exposed facets   | `plan`, `limits`                                                                                            |

Patterns are [ECMAScript] regular expressions. Sections 2–7 run in order. A failed request or command is a whole failure with its reason
unless its section states otherwise. A paged request follows `nextPageToken` as `pageToken` for
at most 5 pages; a failed page fails the request.

## 2. Access token

Run `gcloud` with exactly the arguments `auth`, `print-access-token`, `--quiet`,
`--verbosity=error`; deadline 10 seconds; output cap 8 KiB.

| Result                                                                | Outcome                                |
| --------------------------------------------------------------------- | -------------------------------------- |
| Non-zero exit, stderr contains `ENOENT`                               | Whole failure `gcloud-missing`         |
| Non-zero exit, stderr contains `gcloud auth login`                    | Whole failure `gcloud-unauthenticated` |
| Other non-zero exit                                                   | Whole failure `gcloud-failed`          |
| Zero exit, trimmed stdout not matching `^[A-Za-z0-9._~+/=-]{1,4096}$` | Whole failure `gcloud-failed`          |
| Zero exit otherwise                                                   | The access token is the trimmed stdout |

pi-dent-purse MUST NOT run any other `gcloud` invocation and MUST NOT change `gcloud` configuration,
accounts, or components. Every request below sends header `authorization: Bearer <access
token>`.

## 3. Cloud project

The cloud project is the provider's `project` configuration ([config-file.md](config-file.md))
when set; otherwise the store item keyed by the [FIPS 180-4] SHA-256 digest of the API key,
in lowercase hexadecimal, when it is a valid cloud project; otherwise the lookup:

`GET https://apikeys.googleapis.com/v2/keys:lookupKey?keyString=<apiKey, [RFC 3986] percent-encoded>`

When the body's `parent` string matches `^projects/([^/]+)/locations/` and capture 1 is a valid
cloud project, capture 1 is the cloud project, stored without expiry under that digest.
`http-403`, a failure with status 404, or any other body is a whole failure with
`project-unresolved`. A valid cloud project matches the pattern of the `project` configuration ([config-file.md](config-file.md), Section 2).
The cloud project MUST NOT appear outside the paths of requests to the host allowlist; in
particular a store key holds its digest, never the project.

## 4. Quota metadata

Paged `GET https://cloudquotas.googleapis.com/v1/projects/<cloud project>/locations/global/services/generativelanguage.googleapis.com/quotaInfos?pageSize=200`,
skipped while the store holds its result under key
`google-quota-metadata:<hex SHA-256 digest of the cloud project>`. From each `quotaInfos[]` object read the strings `quotaId` and
`refreshInterval`; the result is stored for 86400 seconds. A failure is not a whole failure:
metadata is then absent, and nothing is stored.

A quota id's interval is `day` when its metadata `refreshInterval` is `day`, `minute` when
`minute`, and unknown for any other `refreshInterval`; when the metadata has no entry for the
quota id (or is absent), `day` when the quota id contains `PerDay`, `minute` when it contains
`PerMinute`; otherwise unknown.

## 5. Active limits

Metric types: paged `GET https://monitoring.googleapis.com/v3/projects/<cloud project>/metricDescriptors`
with query parameters `filter`
`metric.type = starts_with("generativelanguage.googleapis.com/quota/")` and `pageSize` `500`,
skipped while the store holds its result under key
`google-metric-types:<hex SHA-256 digest of the cloud project>`. The result is the `type`
strings of `metricDescriptors[]`, stored for 86400 seconds; a failure stores nothing.

A limit type is a metric type ending in `/limit`; its family is the segment between `quota/`
and `/limit`. For each limit type, concurrently, paged
`GET https://monitoring.googleapis.com/v3/projects/<cloud project>/timeSeries` with query
parameters:

| Parameter                      | Value                          |
| ------------------------------ | ------------------------------ |
| `filter`                       | `metric.type = "<limit type>"` |
| `interval.startTime`           | now − 25 hours, [RFC 3339]     |
| `interval.endTime`             | now, RFC 3339                  |
| `aggregation.alignmentPeriod`  | `90000s`                       |
| `aggregation.perSeriesAligner` | `ALIGN_NEXT_OLDER`             |

When several of these requests fail, the whole failure's reason is that of the failed request
with the first limit type in ascending order of UTF-16 code units.

> Note (non-normative): Cloud Monitoring rejects a time-series request whose filter matches
> more than one metric type, so each type is requested on its own.

Each `timeSeries[]` object yields a series:

- family: the family of the request's limit type;
- quota id and model: the `limit_name` and `model` strings of `metric.labels`; the quota id
  matches metadata `quotaId` exactly;
- value: the first point's `value.int64Value` when it is a string matching `^-?[0-9]+$`,
  converted to the nearest number (precision above 2^53 is lost); else its `value.doubleValue`.

A series without a quota id or without a finite value is skipped. Usage tier, from the
remaining families, first that applies: a family containing `paid_tier_3` → `Paid tier 3`;
`paid_tier_2` → `Paid tier 2`; a family not containing `free_tier` → `Paid tier 1`; otherwise
`Free tier`. The usage tier is the `plan` value. When it is not `Free tier`, series of families
containing `free_tier` are dropped. Each remaining series with a value other than `-1` yields one window:

| Field           | Value                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`            | The quota id, followed by `:<model>` when a model is present                                                                  |
| `label`         | `<model, else "all"> <"tok" when the family contains "token", else "req">/<"day", "min", or "?" per the quota id's interval>` |
| `unit`          | `tokens` when the family contains `token`; else `requests`                                                                    |
| `limit`         | The value                                                                                                                     |
| `used`          | Section 6 for `day`; `null` otherwise                                                                                         |
| `resetsAt`      | For `day`, the next midnight in [IANA TZ] zone `America/Los_Angeles`; `null` otherwise                                        |
| `windowSeconds` | 86400 for `day`, 60 for `minute`, `null` otherwise                                                                            |
| `models`        | `[<model>]`, the vendor's model name, which need not be an inventory model id; else `null`                                    |
| `source`        | `endpoint`                                                                                                                    |

A repeated `id` keeps the first, in ascending order of limit type by UTF-16 code units, then
response order. No series (or no limit type): `plan` and `limits` are `unavailable` with
`empty-response`. Series but no window: `limits` is `unavailable` with `empty-response`.

## 6. Daily usage

For each family with a `day` window whose `quota/<family>/usage` is a metric type,
concurrently: the Section 5 time-series request with `filter`
`metric.type = "generativelanguage.googleapis.com/quota/<family>/usage"`,
`interval.startTime` the latest midnight in `America/Los_Angeles` at or before now,
`aggregation.alignmentPeriod` the seconds elapsed since that midnight, rounded down, and at
least 60 (`<n>s`), and `aggregation.perSeriesAligner` `ALIGN_SUM`. A `day` window's `used` is
the sum of the finite point values of all points of all series of its family's request with
the same quota id and model (`limit_name` and `model` of `metric.labels`); `0` when the
request succeeded and no such series exists. A failure is not a whole failure: `used` stays
`null` for the family's windows, as it does for a family without a usage metric type.

## 7. Estimated spend

Runs when Section 5 yielded a window and the usage tier is not `Free tier`; adds one window
after those of Section 5. The month start is the latest midnight in `America/Los_Angeles`
beginning a calendar month, at or before now. Concurrently, the Section 5 time-series request with `filter`
`metric.type = "<metric type>"`, `interval.startTime` the month start,
`aggregation.alignmentPeriod` the seconds elapsed since it, rounded down, and at least 60
(`<n>s`), and `aggregation.perSeriesAligner` `ALIGN_SUM`, for:

- input: each metric type `generativelanguage.googleapis.com/quota/<family>/usage` whose family
  contains `input_token_count` and not `free_tier`;
- output: `generativelanguage.googleapis.com/generate_content_usage_output_token_count`.

A series total is the sum of the finite point values of its points; a series without a `model`
string in `metric.labels` is skipped. A model's input tokens are, per family, the greatest
series total among its quota ids, summed over the families; its output tokens are the sum of
its series totals.

The estimated spend is the sum, over the inventory models whose id equals a series `model`, of
(input tokens × `input` + output tokens × `output`) ÷ 1000000, with the rates of
[prices.md](prices.md), Section 2, steps 2 and 3.

| Field           | Value                                                                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`            | `spend:month`                                                                                                                                                                                                                                                      |
| `label`         | `spend est/month`                                                                                                                                                                                                                                                  |
| `unit`          | `currency`                                                                                                                                                                                                                                                         |
| `currency`      | `USD`                                                                                                                                                                                                                                                              |
| `used`          | The estimated spend rounded to 2 decimals; `null` when any request of this section failed, a model with a non-zero token total has no inventory model, a non-zero `input` total has a `null` `input` rate, or a non-zero `output` total has a `null` `output` rate |
| `limit`         | The spend cap: 250 for `Paid tier 1`, 2000 for `Paid tier 2`, `null` for `Paid tier 3`                                                                                                                                                                             |
| `resetsAt`      | The next midnight in `America/Los_Angeles` beginning a calendar month                                                                                                                                                                                              |
| `windowSeconds` | `null`                                                                                                                                                                                                                                                             |
| `models`        | `null`                                                                                                                                                                                                                                                             |
| `source`        | `endpoint`                                                                                                                                                                                                                                                         |
| `severity`      | `unknown` (adapter-spec override)                                                                                                                                                                                                                                  |

A failure in this section is not a whole failure.

> Note (non-normative): the estimate ignores cache and batch discounts, tiered rates, and
> other projects of the billing account, which share the spend cap. Its `percent`, when
> derived, is informational: it never implies `exhausted` and the estimate gates nothing
> (`severity` is always `unknown`).

## 8. Normative references

- [ECMAScript] ECMAScript 2023 Language Specification, ECMA-262 14th edition, clause 22.2
  (RegExp): the syntax and matching of the patterns in this specification, compiled with the
  `u` flag.
- [FIPS 180-4] Secure Hash Standard, NIST FIPS PUB 180-4, 2015, clause 6.2 (SHA-256): the
  store key of Section 3.
- [RFC 3986] Uniform Resource Identifier (URI): Generic Syntax, T. Berners-Lee et al., 2005,
  clause 2.1 (percent-encoding): the `keyString` query value of Section 3.
- [RFC 3339] Date and Time on the Internet: Timestamps, G. Klyne and C. Newman, 2002, clause
  5.6: the `interval.*` values of Sections 5 to 7, in UTC with `Z`.
- [IANA TZ] IANA Time Zone Database, any release supported by the host runtime's ECMAScript
  `Intl` API: the zone `America/Los_Angeles` of Sections 5 to 7.

## 9. Specification gaps

- `live check`: the usage-tier inference for a paid tier 2 or 3 project, and for a project
  whose series all carry the value `-1`; one paid tier 1 project was observed.
- `live check`: daily usage (Section 6); the observed project had no `day` window.
- `live check`: whether token-per-day quotas reset at midnight `America/Los_Angeles`, as
  requests-per-day quotas are documented to.
- `decision`: whether sending the API key in the lookup's URL query, the endpoint's only form,
  is acceptable when `project` is not configured.
- `live check`: whether input token counts include cached tokens and output token counts
  include thinking tokens; whether the spend cap's month starts at midnight
  `America/Los_Angeles`; an alignment period longer than 10 days.
- `live check`: whether the quota ids of one model always carry equal input totals.
- `live check`: the spend cap of `Paid tier 3`, documented as a range.
- `decision`: whether balance or per-minute usage is wanted; no Google API usable with this
  credential exposes balance or exact spend.
