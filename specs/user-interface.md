# User interface specification

This document specifies how pi-dent-purse shows billing state to the user: the `/purse` slash command
with its billing report, and the status line. Entries are provider entries per
[billing-state.md](billing-state.md), requested from the refresh layer per
[refresh.md](refresh.md), Section 3.

## 1. `/purse` command

Registered through `pi.registerCommand` as `purse`, description
`Show billing state: /purse [all] [refresh] [provider ...]`.

- Arguments are whitespace-separated. Of the leading tokens, `refresh` requests, for each
  selected provider, a `refresh`-mode refresh that is a bypassing refresh
  ([refresh.md](refresh.md), Section 3) and `all` selects the full view (Section 2); both are
  accepted, in either order. Without `refresh`, each selected provider is requested in `auto`
  mode ([refresh.md](refresh.md), Section 3). Remaining tokens are provider ids;
  a token that is not a known provider is dropped, and duplicates collapse. Without
  provider tokens: every known provider; with provider tokens all dropped: none.
- With no provider selected, nothing is requested and nothing is shown.
- Argument completions: for the token being typed, the known provider ids it prefixes,
  preceded by `all` and `refresh` when it is the first token and they prefix it. With none,
  `getArgumentCompletions` returns `null`.
- Without `all` and without provider tokens, the report is the guided view: only the
  known providers with a guided model appear, and per provider only its guided models
  (Section 2), together with every known provider whose entry has no models, shown whole; otherwise the report is the full view. The model guidance is the latest custom
  message of the session branch whose text begins `Model guidance:`; a guided model is a
  provider id and a model id that the model guidance names in a line `- <provider>/<model>: …`
  or `- <provider>/<model>:<level>: …`: the first `/` splits the provider from the model, and
  the model id ends at the next `:`. With no model guidance on the branch, the guided view is
  the full view. pi-dent-purse reads the message from the session branch and MUST NOT read another
  extension's configuration or files.
- With a UI in mode `tui`: after all entries settle, one custom message is sent through
  `pi.sendMessage`, custom type `purse`, displayed in the session, with the report lines
  (Section 2) joined by a newline as its content and no turn triggered. The message becomes
  part of the session branch and of the model's context. No line is truncated to a width: the
  host renders the message, wrapping lines that do not fit.
- With a UI in another mode: after all entries settle, one `ctx.ui.notify` call, level `info`,
  with the report lines joined by a newline, for a width of 80 columns.
- With a report of no lines, nothing is shown in either mode.
- Without a UI: the refresh runs; nothing is shown.

## 2. Billing report

The full view shows every selected provider with every entry of its `models`; the guided view
is as [Section 1](#1-purse-command) states. Providers are in ascending order of UTF-16 code
units; per provider, lines in this order:

1. Header: provider id, severity, plan value (`—` when `not-exposed`, `?` when `unavailable`
   or empty after character removal), capture age (or `never`), `stale` when stale, and the
   status when it is not `ok`.
2. `reason: <reason>` when `reason` is non-null.
3. Per limit window: label; `<percent>%`, or `?` when `percent` is `null`, or nothing when
   `percent` and `limit` are both `null` and `used` is known; then `<used>/<limit> <unit>` when
   `limit` is known, `<used> <unit>` when only `used` is known, an unknown `used` rendered `?`
   (with unit `currency`, the window's `currency` code as the unit, and `used` and `limit`
   with two decimals); reset as the duration until `resetsAt` when known.
4. Per balance item: amount with two decimals, currency, `(assumed)` when `currencyAssumed`.
5. Per model, in ascending order of UTF-16 code units of the model id: model id, input,
   output, cache-read, and cache-write rates per
   million tokens; with an active schedule, `×<multiplier> now`. Tiers and price source MUST
   NOT be rendered.

- An unknown value renders as `?`; it MUST NOT render as `0`. A facet `not-exposed` renders no
  line.
- A duration renders as `<n><unit>`, `<unit>` the largest of `d`, `h`, `m`, `s` for which the
  whole number `<n>` of units, rounded down, is at least 1, else `s`; a duration of a time in
  the past renders `0s`.
- Characters of [Unicode] general category `Cc`, `Cf`, `Zl`, or `Zp` MUST be removed from
  every rendered text.
- In a notification (Section 1), a line wider than 80 terminal columns, as the host measures
  them, is cut at that width without an ellipsis.
- Colors, column widths, and spacing are not normative.

## 3. Status line

Active when `statusLine` is `true` ([config-file.md](config-file.md)) and the context's mode is
`tui` or `rpc` with a UI; in `rpc` mode the client shows the status. The current model is the model of the live context (`ctx.model`), or for
`model_select` the event's model. It shows, through `ctx.ui.setStatus` with key `purse`, the
`cached` provider entry of the current model's provider:

- `free` → `free`;
- otherwise, known limit windows with a severity other than `unknown` and `models` `null` or
  containing the current model id, ordered by `windowSeconds` descending, at most 3, each as
  `<label> <percent>%` with `percent` rounded to an integer, followed, when `resetsAt` is not
  `null`, by a space and the time left, joined by a space, `·`, and a space;
- otherwise, known balance items with `gatesUsage` `true`, each as `<amount> <currency>` with
  two decimals, joined likewise.

The time left is `resetsAt` minus the render time in milliseconds, rendered as the two largest
of its whole days, hours, and minutes that are at least 1, each taken after subtracting the
larger parts written, concatenated in that order with no separator (`3d5h`, `2h14m`, `45m`); a
time left under one minute, including zero and negative values, renders `<1m`.

> Note (non-normative): two units keep a footer short while still showing the longer horizons.

While the shown text carries a time left, it is rendered again from the `cached` entries with the
context and model of the previous render once 60 seconds have passed since that render, and no
two such renders are closer together, requesting no refresh. No timer runs while the shown text
carries no time left, once the status is cleared, while the status line is not active, or after
`session_shutdown`.

When a text is shown and the entry is stale, ` (stale)` is appended; characters are removed per
Section 2. The status is cleared with `ctx.ui.setStatus("purse", undefined)` when there is no
current model, when none of the above cases applies, when the text would be empty, when the
status line is not active, and on `session_shutdown`. Rendering uses the live context's UI. Updates:

| Event              | Action                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `session_start`    | Request an `auto` refresh of the current model's provider.                                          |
| `model_select`     | Render from `cached` entries for the event's model, then request an `auto` refresh of its provider. |
| `agent_settled`    | Request an `auto` refresh of the current model's provider.                                          |
| `purse:changed:v1` | Re-render.                                                                                          |
| `session_shutdown` | Clear the status.                                                                                   |

While the status line is not active, no event requests a refresh.

## 4. Normative references

- [Unicode] The Unicode Standard, Version 15.0, clause 4.5 (general category): the characters
  removed from rendered text in Section 2.

## 5. Specification gaps

- `decision`: whether guided models come from a versioned source instead of the text of
  another extension's message.
