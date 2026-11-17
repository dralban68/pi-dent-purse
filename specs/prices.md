# Prices specification

This document specifies the `price` of each model in a provider entry
([billing-state.md](billing-state.md), Section 1). Prices come from the inventory and
configuration only; deriving them MUST NOT issue a request or run a command.

## 1. Price

| Field      | Type                                                              | Contract                                                   |
| ---------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| `rates`    | `{ input, output, cacheRead, cacheWrite }`, each number \| `null` | Base rates in USD per million tokens; `null` is unknown.   |
| `tiers`    | `{ inputTokensAbove, input, output, cacheRead, cacheWrite }[]`    | Rates applying above an input-token count; `[]` when none. |
| `source`   | `inventory` \| `config` \| `free` \| `unknown`                    | Section 2.                                                 |
| `schedule` | Schedule \| `null`                                                | Section 3.                                                 |

Rates MUST NOT be pre-multiplied by a schedule.

## 2. Derivation

For each inventory model of the provider, in order:

1. Free provider: all rates `0`, `tiers` `[]`, `source` `free`, `schedule` `null`; stop.
2. Inventory `cost`: when `input`, `output`, `cacheRead`, and `cacheWrite` are all `0` and
   `tiers` is absent or empty, all rates are `null` and `source` is `unknown`; otherwise rates
   and `tiers` are copied and `source` is `inventory`.
3. Override: each field present in the provider's `prices.<model id>` configuration
   ([config-file.md](config-file.md), Section 2), `null` included, replaces its rate; `tiers`
   are kept; when any field is present, `source` is `config`.
4. Schedule: the provider's `schedule` configuration when the key is present (`null` disables);
   otherwise the built-in schedule of the provider's adapter when its spec gives one and the
   provider's `adapter` configuration is not `false`; otherwise `null`.

## 3. Schedule

| Field        | Type                   | Contract                                                                                                                                                         |
| ------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `multiplier` | number                 | Greater than 0. Effective rate = rate × `multiplier` while active.                                                                                               |
| `timeZone`   | string                 | A zone name of the [IANA TZ] database.                                                                                                                           |
| `windows`    | `{ days, from, to }[]` | `days`: integers 0 (Sunday)–6; `from`, `to`: `HH:MM` local times, `from` < `to`, `to` ≤ `24:00`.                                                                 |
| `active`     | boolean                | Computed at derivation time: whether the derivation time is active.                                                                                              |
| `changesAt`  | number \| `null`       | Computed: epoch milliseconds of the first later instant whose activity differs, when it is at most 7 days (604800000 ms) after the derivation time; else `null`. |

An instant is active when its local date and time in `timeZone` falls on one of a window's
`days` at or after `from` and before `to`. Activity is a function of the instant alone: a local
time that occurs twice is active at both occurrences, and a boundary that a time-zone
transition skips takes effect at the transition instant.

Derivation receives only schedules that satisfy this table: configured ones validated per
[config-file.md](config-file.md), Section 2, and built-in ones as their adapter spec gives them.

## 4. Normative references

- [IANA TZ] IANA Time Zone Database, any release supported by the host runtime's ECMAScript
  `Intl` API: the zone names and offsets of Section 3.

## 5. Specification gaps

- `decision`: pricing for a vendor account settled in a currency other than USD.
- `decision`: whether an all-zero inventory cost can mean a genuinely free model outside a free
  provider.
- `decision`: whether a single zero rate beside non-zero rates can mean unknown.
