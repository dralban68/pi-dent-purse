# Configuration file specification

This document specifies pi-dent-purse's configuration file and environment variables.

## 1. File

The configuration file is `~/.pi/purse/purse.conf`, or the absolute path in `PURSE_CONF` when
set. pi-dent-purse MUST read it once per boot window, at the first `session_start`, and serve that
image for the whole window. pi-dent-purse MUST NOT read any other configuration file.

The file is JSONC: [RFC 8259] JSON text extended with `//` line comments, `/* */` block
comments, and one trailing comma before a closing `]` or `}`. A missing file, and a file
holding no JSON value (empty, or only whitespace and comments), is an empty configuration,
silently. A read failure other than a missing file, a parse failure, or a root that is not an
object produces one diagnostic and an empty configuration.

## 2. Keys

| Root key     | Type                           | Default                         | Contract                                                                                                                                      |
| ------------ | ------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers`  | Record\<provider id, Provider> | `{}`                            | Per-provider settings. A key not matching the provider-id pattern of [query-protocol.md](query-protocol.md), Section 2, is a violation.       |
| `severity`   | `{ low?, critical? }`          | `{ "low": 75, "critical": 90 }` | Percent thresholds ([billing-state.md](billing-state.md), Section 5). Each field is a number; after defaulting, 0 < `low` < `critical` ≤ 100. |
| `statusLine` | boolean                        | `true`                          | Enables the status line ([user-interface.md](user-interface.md)).                                                                             |

| Provider key | Type                                          | Contract                                                                                                                                                                           |
| ------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `free`       | boolean?                                      | `true` declares a free provider ([billing-state.md](billing-state.md), Section 2; [prices.md](prices.md), Section 2).                                                              |
| `adapter`    | boolean?                                      | `false` disables the provider's adapter ([billing-state.md](billing-state.md), Section 2).                                                                                         |
| `ttlSeconds` | integer?                                      | 60–86400; the provider's freshness period ([refresh.md](refresh.md), Section 2).                                                                                                   |
| `lowBalance` | number?                                       | ≥ 0; the provider's low-balance threshold ([billing-state.md](billing-state.md), Section 5).                                                                                       |
| `prices`     | Record\<model id, Rates>?                     | Rate overrides ([prices.md](prices.md), Section 2); any string is a model id. Rates: `{ input?, output?, cacheRead?, cacheWrite? }`, each a number ≥ 0 or `null`.                  |
| `schedule`   | `{ multiplier, timeZone, windows }` \| `null` | A price schedule per [prices.md](prices.md), Section 3, without computed fields; `null` disables the built-in one.                                                                 |
| `project`    | string?                                       | `google` only: the cloud project owning the API key ([adapter-google.md](adapter-google.md)), matching the [ECMAScript] pattern `^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]\|[0-9]{1,20})$`. |

Loading rules, in this order of precedence:

1. An unknown key — at any level, including `project` on a provider other than `google` —
   produces one diagnostic and is ignored.
2. On a provider whose `free` is `true`, every other provider key produces one diagnostic and is
   ignored.
3. A value violating its contract produces one diagnostic and is ignored; its default applies,
   an optional key or a provider entry is absent, and siblings still load. The violating
   value is the smallest of: a rate field; a `prices` entry; a provider key; a provider entry;
   a root key. Exceptions:
   - any violation inside `schedule` makes the whole `schedule` the violating value, with one
     diagnostic per violation, each naming its own key path;
   - a `severity` field that is not a number is the violating value, and the order condition
     is checked after defaulting it; an order violation produces one diagnostic naming
     `severity` and defaults both fields.

A key produces at most one diagnostic; when several rules apply, the first in the order above
reports it.

```jsonc
{
  "providers": {
    "llm-dralban68": { "free": true },
    "deepseek": { "lowBalance": 5 },
    "zai": { "prices": { "glm-5.3-highspeed": { "input": 1.4, "output": 4.4 } } },
    "google": { "project": "my-project" },
  },
  "severity": { "low": 70, "critical": 90 },
}
```

## 3. Environment

| Variable                | Contract                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `PURSE_CONF`            | Absolute path of the configuration file. A relative value produces one diagnostic and is ignored. |
| `PURSE_OFFLINE`         | `1` disables refreshes ([refresh.md](refresh.md), Section 3); other values are ignored.           |
| `PURSE_EXA_SERVICE_KEY` | The `exa` credential variable ([adapter-exa.md](adapter-exa.md), Section 1).                      |

## 4. Diagnostics

A diagnostic names the configuration file path and the key path of the offending value (for
example `providers.zai.schedule.windows[0].from`); one about the file as a whole names no key
path; one about `PURSE_CONF` names the variable and its value. pi-dent-purse MUST report each
diagnostic once per boot window through the host UI notification API, level `warning`, as
`purse: <message>`, at the first `session_start` whose context has a UI. A diagnostic MUST NOT
fail the extension.

## 5. Normative references

- [RFC 8259] The JavaScript Object Notation (JSON) Data Interchange Format, T. Bray, 2017:
  the grammar of Section 1, which this specification extends with comments and trailing commas.
- [ECMAScript] ECMAScript 2023 Language Specification, ECMA-262 14th edition, clause 22.2
  (RegExp): the syntax and matching of the patterns in this specification, compiled with the
  `u` flag.

## 6. Specification gaps

- `decision`: whether a project-local configuration layer is wanted.
