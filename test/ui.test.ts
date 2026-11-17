import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuidedModel } from "../lib/guidance.ts";
import {
  PURSE_COMMAND_DESCRIPTION,
  PURSE_COMMAND_NAME,
  PURSE_STATUS_KEY,
  completePurseArguments,
  createPurseCommand,
  createStatusLineUpdater,
  displayWidth,
  formatAmount,
  formatDuration,
  formatTimeLeft,
  parsePurseArguments,
  renderProviderEntry,
  renderReport,
  renderStatusLine,
  sanitizeText,
  statusLineActive,
  truncateToWidth,
  type PurseCommand,
  type PurseCommandContext,
  type PurseCompletion,
  type PurseReportMessage,
  type PurseStatusContext,
  type StatusLineUpdater,
} from "../lib/ui.ts";
import type { Refresher, RequestOptions, RefreshMode, Timers } from "../lib/refresh.ts";
import type { BalanceItem, LimitWindow, Price, ProviderEntry } from "../lib/state.ts";

const NOW = 1_700_000_000_000;

function priceOf(overrides: Partial<Price> = {}): Price {
  return {
    rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    tiers: [],
    source: "inventory",
    schedule: null,
    ...overrides,
  };
}

function limitWindow(overrides: Partial<LimitWindow> = {}): LimitWindow {
  return {
    id: "five-hour",
    label: "5h",
    unit: "percent",
    used: null,
    limit: null,
    percent: 50,
    resetsAt: null,
    windowSeconds: 18_000,
    models: null,
    source: "endpoint",
    severity: "ok",
    ...overrides,
  };
}

function balanceItem(overrides: Partial<BalanceItem> = {}): BalanceItem {
  return {
    amount: 10,
    currency: "USD",
    currencyAssumed: false,
    gatesUsage: true,
    severity: "ok",
    ...overrides,
  };
}

function providerEntry(overrides: Partial<ProviderEntry> = {}): ProviderEntry {
  return {
    provider: "zai",
    status: "ok",
    reason: null,
    adapter: "zai",
    capturedAt: NOW - 60_000,
    freshUntil: NOW + 60_000,
    stale: false,
    severity: "ok",
    plan: { state: "known", value: "pro" },
    balance: { state: "known", value: [balanceItem()] },
    limits: { state: "known", value: [limitWindow()] },
    models: { "zai-large": { price: priceOf(), severity: "ok" } },
    ...overrides,
  };
}

function linesOf(entry: ProviderEntry, now = NOW): string[] {
  return renderProviderEntry(entry, { now });
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const PROVIDERS = ["anthropic", "openai", "zai"];

test("parse: no arguments selects every known provider in ASCII order", () => {
  assert.deepEqual(parsePurseArguments("", PROVIDERS), {
    refresh: false,
    all: false,
    named: false,
    providers: PROVIDERS,
  });
  assert.deepEqual(parsePurseArguments("   ", PROVIDERS), {
    refresh: false,
    all: false,
    named: false,
    providers: PROVIDERS,
  });
});

test("parse: no known providers selects none", () => {
  assert.deepEqual(parsePurseArguments("", []), {
    refresh: false,
    all: false,
    named: false,
    providers: [],
  });
  assert.deepEqual(parsePurseArguments("zai", []), {
    refresh: false,
    all: false,
    named: true,
    providers: [],
  });
});

test("parse: refresh token alone refreshes every known provider", () => {
  assert.deepEqual(parsePurseArguments("refresh", PROVIDERS), {
    refresh: true,
    all: false,
    named: false,
    providers: PROVIDERS,
  });
});

test("parse: provider tokens are filtered to configured ids and sorted", () => {
  assert.deepEqual(parsePurseArguments("zai openai", PROVIDERS), {
    refresh: false,
    all: false,
    named: true,
    providers: ["openai", "zai"],
  });
  assert.deepEqual(parsePurseArguments("nope zai", PROVIDERS), {
    refresh: false,
    all: false,
    named: true,
    providers: ["zai"],
  });
  assert.deepEqual(parsePurseArguments("nope", PROVIDERS), {
    refresh: false,
    all: false,
    named: true,
    providers: [],
  });
  assert.deepEqual(parsePurseArguments("ZAI", PROVIDERS), {
    refresh: false,
    all: false,
    named: true,
    providers: [],
  });
});

test("parse: refresh with provider tokens", () => {
  assert.deepEqual(parsePurseArguments("refresh zai nope", PROVIDERS), {
    refresh: true,
    all: false,
    named: true,
    providers: ["zai"],
  });
});

test("parse: flags only count before provider tokens", () => {
  assert.deepEqual(parsePurseArguments("zai refresh", PROVIDERS), {
    refresh: false,
    all: false,
    named: true,
    providers: ["zai"],
  });
  assert.deepEqual(parsePurseArguments("zai all", PROVIDERS), {
    refresh: false,
    all: false,
    named: true,
    providers: ["zai"],
  });
});

test("parse: all alone selects the full view of every known provider", () => {
  assert.deepEqual(parsePurseArguments("all", PROVIDERS), {
    refresh: false,
    all: true,
    named: false,
    providers: PROVIDERS,
  });
});

test("parse: all and refresh come in either order", () => {
  const expected = { refresh: true, all: true, named: true, providers: ["zai"] };
  assert.deepEqual(parsePurseArguments("all refresh zai", PROVIDERS), expected);
  assert.deepEqual(parsePurseArguments("refresh all zai", PROVIDERS), expected);
});

test("parse: duplicate tokens are selected once", () => {
  assert.deepEqual(parsePurseArguments("zai zai zai", PROVIDERS).providers, ["zai"]);
});

test("parse: whitespace of any kind separates tokens", () => {
  assert.deepEqual(parsePurseArguments("\t refresh \n zai\topenai ", PROVIDERS), {
    refresh: true,
    all: false,
    named: true,
    providers: ["openai", "zai"],
  });
});

test("completions: empty prefix offers both flags and every known provider", () => {
  assert.deepEqual(completePurseArguments("", PROVIDERS), [
    { value: "all ", label: "all" },
    { value: "refresh ", label: "refresh" },
    { value: "anthropic ", label: "anthropic" },
    { value: "openai ", label: "openai" },
    { value: "zai ", label: "zai" },
  ]);
});

test("completions: provider ids match the typed prefix", () => {
  assert.deepEqual(completePurseArguments("z", PROVIDERS), [{ value: "zai ", label: "zai" }]);
  assert.deepEqual(completePurseArguments("an", PROVIDERS), [
    { value: "anthropic ", label: "anthropic" },
  ]);
});

test("completions: all matches its prefix", () => {
  assert.deepEqual(completePurseArguments("al", PROVIDERS), [{ value: "all ", label: "all" }]);
});

test("completions: a flag before the token completes provider ids", () => {
  assert.deepEqual(completePurseArguments("all z", PROVIDERS), [
    { value: "all zai ", label: "zai" },
  ]);
});

test("completions: refresh matches its prefix", () => {
  assert.deepEqual(completePurseArguments("ref", PROVIDERS), [
    { value: "refresh ", label: "refresh" },
  ]);
});

test("completions: after refresh only provider ids complete", () => {
  assert.deepEqual(completePurseArguments("refresh ", PROVIDERS), [
    { value: "refresh anthropic ", label: "anthropic" },
    { value: "refresh openai ", label: "openai" },
    { value: "refresh zai ", label: "zai" },
  ]);
  assert.deepEqual(completePurseArguments("refresh z", PROVIDERS), [
    { value: "refresh zai ", label: "zai" },
  ]);
});

test("completions: no match returns null", () => {
  assert.equal(completePurseArguments("nope", PROVIDERS), null);
  assert.equal(completePurseArguments("zai zzz", PROVIDERS), null);
  assert.deepEqual(completePurseArguments("ref", []), [{ value: "refresh ", label: "refresh" }]);
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test("format: durations use the largest whole unit", () => {
  const cases: [number, string][] = [
    [0, "0s"],
    [-5000, "0s"],
    [999, "0s"],
    [1000, "1s"],
    [59_999, "59s"],
    [60_000, "1m"],
    [3_599_000, "59m"],
    [3_600_000, "1h"],
    [86_399_000, "23h"],
    [86_400_000, "1d"],
    [10 * 86_400_000, "10d"],
  ];
  for (const [milliseconds, expected] of cases) {
    assert.equal(formatDuration(milliseconds), expected, `for ${milliseconds}ms`);
  }
});

test("format: a time left uses up to two units, and under a minute reads <1m", () => {
  const cases: Array<[number, string]> = [
    [-1, "<1m"],
    [0, "<1m"],
    [59_999, "<1m"],
    [60_000, "1m"],
    [45 * 60_000, "45m"],
    [60 * 60_000, "1h"],
    [(2 * 60 + 14) * 60_000, "2h14m"],
    [(3 * 24 + 5) * 3_600_000, "3d5h"],
    [(3 * 24 * 60 + 20) * 60_000, "3d20m"],
    [(3 * 24 + 5) * 3_600_000 + 20 * 60_000, "3d5h"],
    [90 * 24 * 3_600_000 + 12 * 3_600_000, "90d12h"],
    [3_600_000 + 59 * 60_000 + 59_000, "1h59m"],
  ];
  for (const [milliseconds, expected] of cases) {
    assert.equal(formatTimeLeft(milliseconds), expected, String(milliseconds));
  }
});

test("format: a non-finite time left is unknown", () => {
  assert.equal(formatTimeLeft(Number.POSITIVE_INFINITY), "?");
});

test("format: non-finite durations are unknown", () => {
  assert.equal(formatDuration(Number.NaN), "?");
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), "?");
});

test("format: amounts always carry two decimals", () => {
  assert.equal(formatAmount(0), "0.00");
  assert.equal(formatAmount(-0), "0.00");
  assert.equal(formatAmount(0.5), "0.50");
  assert.equal(formatAmount(10), "10.00");
  assert.equal(formatAmount(1234.5678), "1234.57");
  assert.equal(formatAmount(1_000_000_000), "1000000000.00");
  assert.equal(formatAmount(-3.25), "-3.25");
  assert.equal(formatAmount(Number.NaN), "?");
});

test("sanitize: control, format and separator characters are removed", () => {
  assert.equal(sanitizeText("\u001b[31mred\u001b[0m"), "[31mred[0m");
  assert.equal(sanitizeText("a\nb\tc"), "abc");
  assert.equal(sanitizeText("x\u007fy"), "xy");
  assert.equal(sanitizeText("a\u202eb"), "ab");
  assert.equal(sanitizeText("a\u2028b"), "ab");
  assert.equal(sanitizeText("plain"), "plain");
});

test("width: counted in terminal columns, wide characters take two", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("宽"), 2);
  assert.equal(displayWidth("a宽"), 3);
  assert.equal(displayWidth("e\u0301"), 1);
  assert.equal(truncateToWidth("abcdef", 3), "abc");
  assert.equal(truncateToWidth("abcdef", 0), "");
  assert.equal(truncateToWidth("宽限", 3), "宽");
  assert.equal(truncateToWidth("a宽", 2), "a");
  assert.equal(truncateToWidth("a宽", 3), "a宽");
  assert.equal(displayWidth(truncateToWidth("宽限宽限", 5)), 4);
});

test("width: matches the host's measure for emoji, cut without an ellipsis", () => {
  assert.equal(displayWidth("⚡"), 2);
  assert.equal(displayWidth("☀\uFE0F"), 2);
  assert.equal(truncateToWidth("a⚡b", 2), "a");
  assert.equal(truncateToWidth("a⚡b", 3), "a⚡");
  assert.equal(truncateToWidth("abcdef", 4), "abcd");
});

test("report: an emoji plan never makes a line wider than the width", () => {
  const entry = providerEntry({ plan: { state: "known", value: "⚡⚡⚡⚡⚡⚡" } });
  for (const width of [1, 8, 9, 10, 11, 12]) {
    for (const line of renderReport([entry], { now: NOW, width })) {
      assert.ok(displayWidth(line) <= width, `${JSON.stringify(line)} wider than ${width}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Billing report
// ---------------------------------------------------------------------------

test("report: a full entry renders header, limits, balance and models", () => {
  assert.deepEqual(linesOf(providerEntry()), [
    "zai ok pro 1m",
    "  5h 50%",
    "  10.00 USD",
    "  zai-large 1 2 0.1 0.2",
  ]);
});

test("report: header carries provider, severity, plan, age and status", () => {
  assert.deepEqual(
    linesOf(
      providerEntry({
        provider: "openai",
        status: "partial",
        severity: "critical",
        plan: { state: "known", value: "team" },
        capturedAt: NOW - 2 * 3_600_000,
        stale: true,
        reason: "http-429",
        balance: { state: "not-exposed" },
        limits: { state: "known", value: [] },
        models: {},
      }),
    ),
    ["openai critical team 2h stale partial", "reason: http-429"],
  );
});

test("report: every status is shown verbatim when it is not ok", () => {
  const cases: [ProviderEntry["status"], string][] = [
    ["free", "zai ok pro 1m free"],
    ["no-adapter", "zai ok pro 1m no-adapter"],
    ["unknown-provider", "zai ok pro 1m unknown-provider"],
    ["unavailable", "zai ok pro 1m unavailable"],
    ["not-collected", "zai ok pro 1m not-collected"],
    ["partial", "zai ok pro 1m partial"],
  ];
  for (const [status, expected] of cases) {
    const lines = linesOf(
      providerEntry({
        status,
        balance: { state: "not-exposed" },
        limits: { state: "not-exposed" },
        models: {},
      }),
    );
    assert.equal(lines[0], expected, `status ${status}`);
  }
  const ok = linesOf(
    providerEntry({
      status: "ok",
      balance: { state: "not-exposed" },
      limits: { state: "not-exposed" },
      models: {},
    }),
  );
  assert.equal(ok[0], "zai ok pro 1m");
});

test("report: every severity renders in the header", () => {
  const severities: ProviderEntry["severity"][] = ["ok", "low", "critical", "exhausted", "unknown"];
  for (const severity of severities) {
    const lines = linesOf(
      providerEntry({
        severity,
        balance: { state: "not-exposed" },
        limits: { state: "not-exposed" },
        models: {},
      }),
    );
    assert.equal(lines[0], `zai ${severity} pro 1m`);
  }
});

test("report: plan facet states", () => {
  assert.equal(
    linesOf(providerEntry({ plan: { state: "known", value: "pro max" } }))[0],
    "zai ok pro max 1m",
  );
  assert.equal(linesOf(providerEntry({ plan: { state: "not-exposed" } }))[0], "zai ok — 1m");
  assert.equal(
    linesOf(providerEntry({ plan: { state: "unavailable", reason: "http-403" } }))[0],
    "zai ok ? 1m",
  );
  assert.equal(linesOf(providerEntry({ plan: { state: "known", value: "" } }))[0], "zai ok ? 1m");
  assert.equal(
    linesOf(providerEntry({ plan: { state: "known", value: "\u0007\u200b" } }))[0],
    "zai ok ? 1m",
  );
});

test("report: capture age or never", () => {
  assert.equal(
    linesOf(providerEntry({ capturedAt: null, status: "free" }))[0],
    "zai ok pro never free",
  );
  assert.equal(linesOf(providerEntry({ capturedAt: NOW }))[0], "zai ok pro 0s");
  assert.equal(linesOf(providerEntry({ capturedAt: NOW + 10_000 }))[0], "zai ok pro 0s");
  assert.equal(linesOf(providerEntry({ capturedAt: NOW - 3 * 86_400_000 }))[0], "zai ok pro 3d");
});

test("report: not-exposed and unavailable facets render no lines", () => {
  assert.deepEqual(
    linesOf(
      providerEntry({
        plan: { state: "not-exposed" },
        limits: { state: "not-exposed" },
        balance: { state: "not-exposed" },
        models: {},
      }),
    ),
    ["zai ok — 1m"],
  );
  assert.deepEqual(
    linesOf(
      providerEntry({
        limits: { state: "unavailable", reason: "http-429" },
        balance: { state: "unavailable", reason: "bad-response" },
        models: {},
      }),
    ),
    ["zai ok pro 1m"],
  );
});

test("report: limit windows render percent, used/limit and reset", () => {
  assert.deepEqual(
    linesOf(
      providerEntry({
        balance: { state: "not-exposed" },
        models: {},
        limits: {
          state: "known",
          value: [
            limitWindow({ label: "5h", percent: 42.5 }),
            limitWindow({
              label: "day",
              unit: "tokens",
              used: 1_500,
              limit: 2_000_000,
              percent: 0.075,
              resetsAt: NOW + 4 * 3_600_000,
            }),
            limitWindow({
              label: "credits",
              unit: "currency",
              currency: "EUR",
              used: 3,
              limit: 10,
              percent: 30,
            }),
            limitWindow({ label: "week", percent: null, used: null, limit: null }),
            limitWindow({
              label: "requests",
              unit: "requests",
              used: 5,
              limit: 100,
              percent: 5,
              resetsAt: NOW - 5_000,
            }),
          ],
        },
      }),
    ),
    [
      "zai ok pro 1m",
      "  5h 42.5%",
      "  day 0.075% 1500/2000000 tokens resets in 4h",
      "  credits 30% 3.00/10.00 EUR",
      "  week ?",
      "  requests 5% 5/100 requests resets in 0s",
    ],
  );
});

test("report: unknown limit values never render as zero", () => {
  assert.deepEqual(
    linesOf(
      providerEntry({
        balance: { state: "not-exposed" },
        models: {},
        limits: { state: "known", value: [limitWindow({ percent: null, used: 10, limit: null })] },
      }),
    ),
    ["zai ok pro 1m", "  5h 10 percent"],
  );
});

test("report: a known percent with only used known renders both", () => {
  assert.deepEqual(
    linesOf(
      providerEntry({
        balance: { state: "not-exposed" },
        models: {},
        limits: {
          state: "known",
          value: [limitWindow({ label: "tokens", unit: "tokens", used: 1500, limit: null })],
        },
      }),
    ),
    ["zai ok pro 1m", "  tokens 50% 1500 tokens"],
  );
});

test("report: a currency window renders used and limit with two decimals", () => {
  assert.deepEqual(
    linesOf(
      providerEntry({
        balance: { state: "not-exposed" },
        models: {},
        limits: {
          state: "known",
          value: [
            limitWindow({
              label: "spend",
              unit: "currency",
              currency: "USD",
              used: 12.345,
              limit: null,
              percent: null,
            }),
            limitWindow({
              label: "cap",
              unit: "currency",
              currency: "EUR",
              used: null,
              limit: 10,
              percent: null,
            }),
            limitWindow({
              label: "budget",
              unit: "currency",
              currency: "GBP",
              used: 2.5,
              limit: 4,
              percent: 62.5,
            }),
          ],
        },
      }),
    ),
    ["zai ok pro 1m", "  spend 12.35 USD", "  cap ? ?/10.00 EUR", "  budget 62.5% 2.50/4.00 GBP"],
  );
});

test("report: a known limit shows even when used and percent are unknown", () => {
  assert.deepEqual(
    linesOf(
      providerEntry({
        balance: { state: "not-exposed" },
        models: {},
        limits: {
          state: "known",
          value: [
            limitWindow({
              label: "concurrency flash",
              unit: "concurrent-requests",
              limit: 2500,
              used: null,
              percent: null,
            }),
          ],
        },
      }),
    ),
    ["zai ok pro 1m", "  concurrency flash ? ?/2500 concurrent-requests"],
  );
});

test("report: unknown rates render as ? and are not zero", () => {
  assert.deepEqual(
    linesOf(
      providerEntry({
        limits: { state: "not-exposed" },
        balance: { state: "not-exposed" },
        models: {
          "m-null": {
            price: priceOf({
              rates: { input: null, output: null, cacheRead: null, cacheWrite: null },
            }),
            severity: "ok",
          },
        },
      }),
    ),
    ["zai ok pro 1m", "  m-null ? ? ? ?"],
  );
});

test("report: balance items render amount, currency and assumed", () => {
  assert.deepEqual(
    linesOf(
      providerEntry({
        limits: { state: "not-exposed" },
        models: {},
        balance: {
          state: "known",
          value: [
            balanceItem({ amount: 0, currency: "USD" }),
            balanceItem({ amount: 12.345, currency: "EUR", currencyAssumed: true }),
            balanceItem({ amount: 1_000_000, currency: "JPY", gatesUsage: false }),
          ],
        },
      }),
    ),
    ["zai ok pro 1m", "  0.00 USD", "  12.35 EUR (assumed)", "  1000000.00 JPY"],
  );
});

test("report: models are sorted ascending ASCII with their four rates", () => {
  assert.deepEqual(
    linesOf(
      providerEntry({
        limits: { state: "not-exposed" },
        balance: { state: "not-exposed" },
        models: {
          "model-b": {
            price: priceOf({ rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }),
            severity: "ok",
          },
          "model-a": {
            price: priceOf({ rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
            severity: "ok",
          },
          "Model-C": { price: priceOf(), severity: "ok" },
        },
      }),
    ),
    ["zai ok pro 1m", "  Model-C 1 2 0.1 0.2", "  model-a 0 0 0 0", "  model-b 3 15 0.3 3.75"],
  );
});

test("report: an active schedule appends its multiplier", () => {
  const schedule = {
    multiplier: 0.5,
    timeZone: "UTC",
    windows: [{ days: [1, 2, 3, 4, 5], from: "00:00", to: "06:00" }],
    active: true,
    changesAt: null,
  };
  assert.deepEqual(
    linesOf(
      providerEntry({
        limits: { state: "not-exposed" },
        balance: { state: "not-exposed" },
        models: { "model-a": { price: priceOf({ schedule }), severity: "ok" } },
      }),
    ),
    ["zai ok pro 1m", "  model-a 1 2 0.1 0.2 ×0.5 now"],
  );
  assert.deepEqual(
    linesOf(
      providerEntry({
        limits: { state: "not-exposed" },
        balance: { state: "not-exposed" },
        models: {
          "model-a": {
            price: priceOf({ schedule: { ...schedule, active: false } }),
            severity: "ok",
          },
        },
      }),
    ),
    ["zai ok pro 1m", "  model-a 1 2 0.1 0.2"],
  );
});

test("report: vendor text cannot inject control sequences", () => {
  const lines = linesOf(
    providerEntry({
      provider: "z\u001b[2Jai",
      plan: { state: "known", value: "\u001b]0;title\u0007pro" },
      limits: {
        state: "known",
        value: [limitWindow({ label: "5h\u001b[31m" })],
      },
      balance: { state: "known", value: [balanceItem({ currency: "US\u001b[0mD" })] },
      models: { "model\u001b[1m": { price: priceOf(), severity: "ok" } },
    }),
  );
  for (const line of lines) {
    assert.ok(!line.includes("\u001b"), `control character in ${JSON.stringify(line)}`);
    assert.ok(!line.includes("\u0007"), `control character in ${JSON.stringify(line)}`);
  }
  assert.deepEqual(lines, [
    "z[2Jai ok ]0;titlepro 1m",
    "  5h[31m 50%",
    "  10.00 US[0mD",
    "  model[1m 1 2 0.1 0.2",
  ]);
});

test("report: providers in ascending ASCII order, separated by an empty line", () => {
  const lines = renderReport(
    [
      providerEntry({ provider: "zai" }),
      providerEntry({
        provider: "openai",
        plan: { state: "not-exposed" },
        balance: { state: "not-exposed" },
        limits: { state: "not-exposed" },
        models: {},
      }),
    ],
    { now: NOW, width: 80 },
  );
  assert.deepEqual(lines, [
    "openai ok — 1m",
    "",
    "zai ok pro 1m",
    "  5h 50%",
    "  10.00 USD",
    "  zai-large 1 2 0.1 0.2",
  ]);
});

test("report: an empty entry list renders nothing", () => {
  assert.deepEqual(renderReport([], { now: NOW, width: 80 }), []);
});

test("report: the guided view keeps only guided models and their providers", () => {
  const priced = () => ({ price: priceOf(), severity: "ok" as const });
  const lines = renderReport(
    [
      providerEntry({
        provider: "zai",
        models: { "glm-4.7": priced(), "glm-5.3": priced() },
      }),
      providerEntry({ provider: "openai", models: { "gpt-5": priced() } }),
    ],
    {
      now: NOW,
      width: 80,
      only: [
        { provider: "zai", id: "glm-5.3" },
        { provider: "zai", id: "absent-model" },
      ],
    },
  );
  assert.deepEqual(lines, ["zai ok pro 1m", "  5h 50%", "  10.00 USD", "  glm-5.3 1 2 0.1 0.2"]);
});

test("report: the guided view renders nothing when no provider has a guided model", () => {
  const lines = renderReport([providerEntry()], {
    now: NOW,
    width: 80,
    only: [{ provider: "openai", id: "gpt-5" }],
  });
  assert.deepEqual(lines, []);
});

test("report: the guided view shows a provider without models whole", () => {
  const priced = () => ({ price: priceOf(), severity: "ok" as const });
  const lines = renderReport(
    [
      providerEntry({ provider: "zai", models: { "glm-5.3": priced() } }),
      providerEntry({ provider: "exa", models: {} }),
      providerEntry({ provider: "openai", models: { "gpt-5": priced() } }),
    ],
    { now: NOW, width: 80, only: [{ provider: "zai", id: "glm-5.3" }] },
  );
  assert.deepEqual(lines, [
    "exa ok pro 1m",
    "  5h 50%",
    "  10.00 USD",
    "",
    "zai ok pro 1m",
    "  5h 50%",
    "  10.00 USD",
    "  glm-5.3 1 2 0.1 0.2",
  ]);
});

test("report: a long list renders every provider and every facet line", () => {
  const windows = Array.from({ length: 40 }, (_, index) =>
    limitWindow({ id: `w${index}`, label: `w${index}`, percent: index }),
  );
  const models = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [
      `m${String(index).padStart(2, "0")}`,
      { price: priceOf(), severity: "ok" as const },
    ]),
  );
  const entries = [
    providerEntry({ provider: "zai", limits: { state: "known", value: windows }, models }),
    providerEntry({ provider: "openai", limits: { state: "known", value: windows }, models }),
  ];
  const lines = renderReport(entries, { now: NOW, width: 80 });
  assert.equal(lines.length, 2 * (1 + 40 + 1 + 20) + 1);
  assert.equal(lines[0], "openai ok pro 1m");
  assert.equal(lines[61], "  m19 1 2 0.1 0.2");
  assert.equal(lines[62], "");
  assert.equal(lines[63], "zai ok pro 1m");
  assert.ok(lines.every((line) => displayWidth(line) <= 80));
});

test("report: every line fits the width in terminal columns", () => {
  const entry = providerEntry({
    provider: "very-long-provider-name",
    plan: { state: "known", value: "a-plan-with-a-rather-long-name" },
    limits: { state: "known", value: [limitWindow({ label: "5h", percent: 42.5 })] },
  });
  for (const width of [0, 1, 5, 10, 17, 80]) {
    const lines = renderReport([entry], { now: NOW, width });
    for (const line of lines) {
      assert.ok(displayWidth(line) <= width, `${JSON.stringify(line)} wider than ${width}`);
    }
  }
  assert.deepEqual(renderReport([entry], { now: NOW, width: 0 }), ["", "", "", ""]);
  assert.deepEqual(renderReport([entry], { now: NOW, width: 10 }), [
    "very-long-",
    "  5h 42.5%",
    "  10.00 US",
    "  zai-larg",
  ]);
});

test("report: wide characters are truncated by columns, not code units", () => {
  const entry = providerEntry({
    provider: "宽限",
    limits: { state: "not-exposed" },
    balance: { state: "not-exposed" },
    models: {},
  });
  const lines = renderReport([entry], { now: NOW, width: 7 });
  assert.deepEqual(lines, ["宽限 ok"]);
  assert.equal(displayWidth(lines[0] ?? ""), 7);
});

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

test("status: free providers show free", () => {
  assert.equal(renderStatusLine(providerEntry({ status: "free" }), "zai-large", NOW), "free");
});

test("status: without an entry or a current model nothing is shown", () => {
  assert.equal(renderStatusLine(undefined, "zai-large", NOW), undefined);
  assert.equal(renderStatusLine(providerEntry(), undefined, NOW), undefined);
});

test("status: limit windows ordered by duration, filtered by model, capped at three", () => {
  const entry = providerEntry({
    limits: {
      state: "known",
      value: [
        limitWindow({ id: "a", label: "5h", percent: 20, windowSeconds: 18_000 }),
        limitWindow({ id: "b", label: "day", percent: 80, windowSeconds: 86_400 }),
        limitWindow({ id: "c", label: "week", percent: 55, windowSeconds: 604_800 }),
        limitWindow({ id: "d", label: "month", percent: 10, windowSeconds: 2_592_000 }),
        limitWindow({ id: "e", label: "other", percent: 99, models: ["other-model"] }),
        limitWindow({ id: "f", label: "unknown", percent: null }),
      ],
    },
  });
  assert.equal(renderStatusLine(entry, "zai-large", NOW), "month 10% · week 55% · day 80%");
});

test("status: percentages are rounded to integers", () => {
  const entry = providerEntry({
    limits: {
      state: "known",
      value: [
        limitWindow({ id: "a", label: "a", percent: 74.4 }),
        limitWindow({ id: "b", label: "b", percent: 74.5 }),
        limitWindow({ id: "c", label: "c", percent: 99.9 }),
      ],
    },
  });
  assert.equal(renderStatusLine(entry, "zai-large", NOW), "a 74% · b 75% · c 100%");
});

test("status: a window of unknown severity is left out", () => {
  const entry = providerEntry({
    limits: {
      state: "known",
      value: [
        limitWindow({ id: "a", label: "a", percent: 20 }),
        limitWindow({ id: "spend", label: "spend", percent: 93, severity: "unknown" }),
      ],
    },
  });
  assert.equal(renderStatusLine(entry, "zai-large", NOW), "a 20%");
});

test("status: model-restricted windows only count for that model", () => {
  const entry = providerEntry({
    limits: {
      state: "known",
      value: [limitWindow({ id: "a", label: "5h", percent: 20, models: ["zai-large"] })],
    },
  });
  assert.equal(renderStatusLine(entry, "zai-large", NOW), "5h 20%");
  assert.equal(renderStatusLine(entry, "zai-small", NOW), "10.00 USD");
});

test("status: balance items that gate usage are the fallback", () => {
  const entry = providerEntry({
    limits: { state: "not-exposed" },
    balance: {
      state: "known",
      value: [
        balanceItem({ amount: 12.5, currency: "USD", gatesUsage: true }),
        balanceItem({ amount: 3, currency: "EUR", gatesUsage: false }),
        balanceItem({ amount: 0.25, currency: "GBP", gatesUsage: true }),
      ],
    },
  });
  assert.equal(renderStatusLine(entry, "zai-large", NOW), "12.50 USD · 0.25 GBP");
});

test("status: no known percent falls back to balance", () => {
  const entry = providerEntry({
    limits: { state: "known", value: [limitWindow({ percent: null, severity: "unknown" })] },
  });
  assert.equal(renderStatusLine(entry, "zai-large", NOW), "10.00 USD");
});

test("status: nothing to show clears the status", () => {
  const entry = providerEntry({
    limits: { state: "not-exposed" },
    balance: { state: "not-exposed" },
  });
  assert.equal(renderStatusLine(entry, "zai-large", NOW), undefined);
  assert.equal(
    renderStatusLine(
      providerEntry({
        limits: { state: "known", value: [] },
        balance: { state: "known", value: [balanceItem({ gatesUsage: false })] },
      }),
      "zai-large",
      NOW,
    ),
    undefined,
  );
});

test("status: a window with a reset shows its time left", () => {
  const entry = providerEntry({
    limits: {
      state: "known",
      value: [
        limitWindow({
          id: "a",
          label: "5h",
          percent: 36,
          windowSeconds: 18_000,
          resetsAt: NOW + 2 * 3_600_000 + 14 * 60_000,
        }),
        limitWindow({
          id: "b",
          label: "7d",
          percent: 21,
          windowSeconds: 604_800,
          resetsAt: NOW + 3 * 86_400_000 + 5 * 3_600_000,
        }),
        limitWindow({ id: "c", label: "none", percent: 5, resetsAt: null }),
      ],
    },
  });
  assert.equal(renderStatusLine(entry, "zai-large", NOW), "7d 21% 3d5h · 5h 36% 2h14m · none 5%");
});

test("status: a reset at or before the render time reads <1m", () => {
  const past = providerEntry({
    limits: { state: "known", value: [limitWindow({ percent: 50, resetsAt: NOW })] },
  });
  assert.equal(renderStatusLine(past, "zai-large", NOW), "5h 50% <1m");
  assert.equal(renderStatusLine(past, "zai-large", NOW + 60_000), "5h 50% <1m");
});

test("status: only limit windows carry a time left", () => {
  const entry = providerEntry({
    limits: { state: "not-exposed" },
    balance: { state: "known", value: [balanceItem({ amount: 12.5, currency: "USD" })] },
  });
  assert.equal(renderStatusLine(entry, "zai-large", NOW), "12.50 USD");
});

test("status: a stale entry appends (stale)", () => {
  assert.equal(
    renderStatusLine(providerEntry({ stale: true, status: "free" }), "zai-large", NOW),
    "free (stale)",
  );
  assert.equal(
    renderStatusLine(providerEntry({ stale: true }), "zai-large", NOW),
    "5h 50% (stale)",
  );
  assert.equal(
    renderStatusLine(
      providerEntry({ stale: true, limits: { state: "not-exposed" } }),
      "zai-large",
      NOW,
    ),
    "10.00 USD (stale)",
  );
});

test("status: vendor text is sanitized", () => {
  const entry = providerEntry({
    limits: {
      state: "known",
      value: [limitWindow({ label: "5h\u001b[31m", percent: 20 })],
    },
  });
  assert.equal(renderStatusLine(entry, "zai-large", NOW), "5h[31m 20%");
});

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

interface RequestCall {
  provider: string;
  mode: RefreshMode | undefined;
  options: RequestOptions | undefined;
}

interface FakeRefresher {
  refresher: Refresher;
  calls: RequestCall[];
  entries: Map<string, ProviderEntry>;
}

function fakeRefresher(init: {
  ready?: boolean;
  providers?: string[];
  entries?: Record<string, ProviderEntry>;
  request?: (
    provider: string,
    mode?: RefreshMode,
    options?: RequestOptions,
  ) => Promise<ProviderEntry>;
}): FakeRefresher {
  const calls: RequestCall[] = [];
  const entries = new Map(Object.entries(init.entries ?? {}));
  const refresher: Refresher = {
    ready: () => init.ready ?? true,
    knownProviders: () => init.providers ?? [],
    recordObservation() {},
    entry: (provider) => entries.get(provider) ?? providerEntry({ provider }),
    request: (provider, mode, options) => {
      calls.push({ provider, mode, options });
      if (init.request !== undefined) return init.request(provider, mode, options);
      return Promise.resolve(entries.get(provider) ?? providerEntry({ provider }));
    },
    clear() {},
  };
  return { refresher, calls, entries };
}

/** A clock and timers that fire only when advanced, so no test waits. */
function fakeTimers(start = NOW): {
  clock: () => number;
  timers: Timers;
  advance: (ms: number) => void;
  pending: () => number;
} {
  let now = start;
  let nextId = 1;
  const handles = new Map<number, { at: number; callback: () => void }>();
  const timers: Timers = {
    setTimeout(callback, ms) {
      const id = nextId++;
      handles.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout(id) {
      if (typeof id === "number") handles.delete(id);
    },
  };
  return {
    clock: () => now,
    timers,
    pending: () => handles.size,
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const due = [...handles.entries()]
          .filter(([, handle]) => handle.at <= target)
          .toSorted((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        handles.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
  };
}

interface NotifyCall {
  message: string;
  type: string | undefined;
}

interface FakeCommandContext {
  ctx: PurseCommandContext;
  notifications: NotifyCall[];
  sent: PurseReportMessage[];
}

function fakeCommandContext(
  options: {
    mode?: PurseCommandContext["mode"];
    hasUI?: boolean;
    guidance?: readonly GuidedModel[];
  } = {},
): FakeCommandContext {
  const notifications: NotifyCall[] = [];
  const sent: PurseReportMessage[] = [];
  const ctx: PurseCommandContext = {
    mode: options.mode ?? "rpc",
    hasUI: options.hasUI ?? true,
    ui: {
      notify: (message, type) => {
        notifications.push({ message, type });
      },
      setStatus: () => {},
    },
    guidance: options.guidance ?? [],
  };
  return { ctx, notifications, sent };
}

function commandFor(
  refresher: Refresher,
  extra: {
    send?: (message: PurseReportMessage) => void;
    notifyWidth?: number;
  } = {},
): PurseCommand {
  return createPurseCommand({
    refresher,
    clock: () => NOW,
    send: extra.send ?? (() => {}),
    ...(extra.notifyWidth === undefined ? {} : { notifyWidth: extra.notifyWidth }),
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("command: name, description and completions come from the spec", () => {
  const { refresher } = fakeRefresher({ providers: PROVIDERS });
  const command: PurseCommand = commandFor(refresher);
  assert.equal(command.name, PURSE_COMMAND_NAME);
  assert.equal(command.description, PURSE_COMMAND_DESCRIPTION);
  const completions: PurseCompletion[] | null = command.getArgumentCompletions("ref");
  assert.deepEqual(completions, [{ value: "refresh ", label: "refresh" }]);
});

test("command: completions are empty without a live context", () => {
  const { refresher } = fakeRefresher({ ready: false, providers: PROVIDERS });
  const command = commandFor(refresher);
  assert.deepEqual(command.getArgumentCompletions(""), [
    { value: "all ", label: "all" },
    { value: "refresh ", label: "refresh" },
  ]);
});

test("command: plain /purse requests auto mode for every known provider", async () => {
  const { refresher, calls } = fakeRefresher({ providers: PROVIDERS });
  const command = commandFor(refresher);
  const fake = fakeCommandContext();
  await command.handler("", fake.ctx);
  assert.deepEqual(
    calls.map((call) => [call.provider, call.mode, call.options?.bypass]),
    [
      ["anthropic", "auto", undefined],
      ["openai", "auto", undefined],
      ["zai", "auto", undefined],
    ],
  );
});

test("command: refresh requests bypass a refresh for the selected providers", async () => {
  const { refresher, calls } = fakeRefresher({ providers: PROVIDERS });
  const command = commandFor(refresher);
  const fake = fakeCommandContext();
  await command.handler("refresh zai", fake.ctx);
  assert.deepEqual(
    calls.map((call) => [call.provider, call.mode, call.options?.bypass]),
    [["zai", "refresh", true]],
  );
});

test("command: the non-TUI report is one info notification with the report lines", async () => {
  const { refresher } = fakeRefresher({
    providers: ["zai"],
    entries: { zai: providerEntry() },
  });
  const command = commandFor(refresher);
  const fake = fakeCommandContext();
  await command.handler("zai", fake.ctx);
  assert.deepEqual(fake.notifications, [
    {
      message: ["zai ok pro 1m", "  5h 50%", "  10.00 USD", "  zai-large 1 2 0.1 0.2"].join("\n"),
      type: "info",
    },
  ]);
  assert.equal(fake.sent.length, 0);
});

test("command: the non-TUI report honours the injected width", async () => {
  const { refresher } = fakeRefresher({ providers: ["zai"], entries: { zai: providerEntry() } });
  const command = commandFor(refresher, { notifyWidth: 12 });
  const fake = fakeCommandContext();
  await command.handler("zai", fake.ctx);
  const message = fake.notifications[0]?.message ?? "";
  for (const line of message.split("\n")) assert.ok(displayWidth(line) <= 12);
});

test("command: without a UI the refresh runs and nothing is shown", async () => {
  const { refresher, calls } = fakeRefresher({ providers: ["zai"] });
  const command = commandFor(refresher);
  const fake = fakeCommandContext({ mode: "tui", hasUI: false });
  await command.handler("refresh zai", fake.ctx);
  assert.equal(calls.length, 1);
  assert.equal(fake.notifications.length, 0);
  assert.equal(fake.sent.length, 0);
});

test("command: without a live context no provider is selected", async () => {
  const { refresher, calls } = fakeRefresher({ ready: false, providers: ["zai"] });
  const command = commandFor(refresher);
  const fake = fakeCommandContext();
  await command.handler("refresh zai", fake.ctx);
  assert.equal(calls.length, 0);
  assert.equal(fake.notifications.length, 0);
});

const TWO_MODELS = {
  "zai-large": { price: priceOf(), severity: "ok" as const },
  "zai-small": { price: priceOf(), severity: "ok" as const },
};

test("command: the default view shows only guided models", async () => {
  const { refresher } = fakeRefresher({
    providers: ["zai"],
    entries: { zai: providerEntry({ models: TWO_MODELS }) },
  });
  const fake = fakeCommandContext({
    mode: "tui",
    guidance: [{ provider: "zai", id: "zai-large" }],
  });
  const command = commandFor(refresher, { send: (message) => fake.sent.push(message) });
  await command.handler("", fake.ctx);

  assert.deepEqual(fake.sent, [
    {
      content: ["zai ok pro 1m", "  5h 50%", "  10.00 USD", "  zai-large 1 2 0.1 0.2"].join("\n"),
    },
  ]);
});

test("command: all shows the full view", async () => {
  const { refresher } = fakeRefresher({
    providers: ["zai"],
    entries: { zai: providerEntry({ models: TWO_MODELS }) },
  });
  const fake = fakeCommandContext({
    mode: "tui",
    guidance: [{ provider: "zai", id: "zai-large" }],
  });
  const command = commandFor(refresher, { send: (message) => fake.sent.push(message) });
  await command.handler("all", fake.ctx);

  assert.deepEqual(fake.sent, [
    {
      content: [
        "zai ok pro 1m",
        "  5h 50%",
        "  10.00 USD",
        "  zai-large 1 2 0.1 0.2",
        "  zai-small 1 2 0.1 0.2",
      ].join("\n"),
    },
  ]);
});

test("command: a provider token shows the full view, the default shows the guided view", async () => {
  const { refresher } = fakeRefresher({
    providers: ["zai"],
    entries: { zai: providerEntry({ models: TWO_MODELS }) },
  });
  const fake = fakeCommandContext({
    mode: "tui",
    guidance: [{ provider: "zai", id: "zai-large" }],
  });
  const command = commandFor(refresher, { send: (message) => fake.sent.push(message) });

  await command.handler("zai", fake.ctx);
  assert.deepEqual(fake.sent, [
    {
      content: [
        "zai ok pro 1m",
        "  5h 50%",
        "  10.00 USD",
        "  zai-large 1 2 0.1 0.2",
        "  zai-small 1 2 0.1 0.2",
      ].join("\n"),
    },
  ]);

  fake.sent.length = 0;
  await command.handler("", fake.ctx);
  assert.deepEqual(fake.sent, [
    {
      content: ["zai ok pro 1m", "  5h 50%", "  10.00 USD", "  zai-large 1 2 0.1 0.2"].join("\n"),
    },
  ]);
});

test("command: the guided view shows a provider whose entry has no models whole", async () => {
  const { refresher } = fakeRefresher({
    providers: ["exa", "zai"],
    entries: {
      exa: providerEntry({
        provider: "exa",
        status: "not-collected",
        capturedAt: null,
        models: {},
      }),
      zai: providerEntry({ models: TWO_MODELS }),
    },
  });
  const fake = fakeCommandContext({
    mode: "tui",
    guidance: [{ provider: "zai", id: "zai-large" }],
  });
  const command = commandFor(refresher, { send: (message) => fake.sent.push(message) });
  await command.handler("", fake.ctx);

  assert.deepEqual(fake.sent, [
    {
      content: [
        "exa ok pro never not-collected",
        "  5h 50%",
        "  10.00 USD",
        "",
        "zai ok pro 1m",
        "  5h 50%",
        "  10.00 USD",
        "  zai-large 1 2 0.1 0.2",
      ].join("\n"),
    },
  ]);
});

test("command: without model guidance the default view is the full view", async () => {
  const { refresher } = fakeRefresher({
    providers: ["zai"],
    entries: { zai: providerEntry({ models: TWO_MODELS }) },
  });
  const fake = fakeCommandContext({ mode: "tui" });
  const command = commandFor(refresher, { send: (message) => fake.sent.push(message) });
  await command.handler("", fake.ctx);

  assert.equal(fake.sent.length, 1);
  assert.match(fake.sent[0]?.content ?? "", /zai-small/u);
});

test("command: a guided view with no guided provider shows nothing", async () => {
  const { refresher, calls } = fakeRefresher({ providers: ["zai"] });
  const fake = fakeCommandContext({
    mode: "tui",
    guidance: [{ provider: "openai", id: "gpt-5" }],
  });
  const command = commandFor(refresher, { send: (message) => fake.sent.push(message) });
  await command.handler("", fake.ctx);

  assert.equal(calls.length, 1, "the provider is still refreshed");
  assert.deepEqual(fake.sent, []);
});

test("command: tui sends one report message to the transcript after every request settles", async () => {
  const settled = new Map<string, (entry: ProviderEntry) => void>();
  const { refresher, calls } = fakeRefresher({
    providers: ["zai", "openai"],
    request: (provider) =>
      new Promise<ProviderEntry>((resolve) => {
        settled.set(provider, resolve);
      }),
  });
  const fake = fakeCommandContext({ mode: "tui" });
  const command = commandFor(refresher, { send: (message) => fake.sent.push(message) });
  const running = command.handler("refresh", fake.ctx);
  await tick();

  assert.equal(fake.sent.length, 0, "nothing is sent before every request settles");
  assert.deepEqual(
    calls.map((call) => [call.provider, call.mode]),
    [
      ["openai", "refresh"],
      ["zai", "refresh"],
    ],
  );

  settled.get("zai")?.(providerEntry({ provider: "zai", status: "partial", reason: "http-429" }));
  await tick();
  assert.equal(fake.sent.length, 0);
  settled.get("openai")?.(providerEntry({ provider: "openai" }));
  await running;

  const lines = [
    "openai ok pro 1m",
    "  5h 50%",
    "  10.00 USD",
    "  zai-large 1 2 0.1 0.2",
    "",
    "zai ok pro 1m partial",
    "reason: http-429",
    "  5h 50%",
    "  10.00 USD",
    "  zai-large 1 2 0.1 0.2",
  ];
  assert.deepEqual(fake.sent, [{ content: lines.join("\n") }]);
  assert.equal(fake.notifications.length, 0);
});

test("command: the tui report message is not truncated at a fixed width", async () => {
  const long = "x".repeat(200);
  const { refresher } = fakeRefresher({
    providers: ["zai"],
    entries: { zai: providerEntry({ plan: { state: "known", value: long } }) },
  });
  const fake = fakeCommandContext({ mode: "tui" });
  const command = commandFor(refresher, { send: (message) => fake.sent.push(message) });
  await command.handler("zai", fake.ctx);
  assert.ok(fake.sent[0]?.content.startsWith(`zai ok ${long}`));
});

test("command: an empty selection shows nothing in any mode", async () => {
  const { refresher, calls } = fakeRefresher({ providers: PROVIDERS });
  const command = commandFor(refresher);
  const tui = fakeCommandContext({ mode: "tui" });
  await command.handler("nope", tui.ctx);
  assert.equal(calls.length, 0);
  assert.equal(tui.sent.length, 0);
  assert.equal(tui.notifications.length, 0);

  const notify = fakeCommandContext();
  await command.handler("nope", notify.ctx);
  assert.equal(notify.notifications.length, 0);
  assert.equal(notify.sent.length, 0);
});

// ---------------------------------------------------------------------------
// Status line updater
// ---------------------------------------------------------------------------

interface StatusCalls {
  key: string;
  text: string | undefined;
}

function fakeStatusContext(options: { mode?: PurseStatusContext["mode"]; hasUI?: boolean } = {}): {
  ctx: PurseStatusContext;
  calls: StatusCalls[];
} {
  const calls: StatusCalls[] = [];
  const ctx: PurseStatusContext = {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    ui: {
      setStatus: (key, text) => {
        calls.push({ key, text });
      },
    },
  };
  return { ctx, calls };
}

function statusUpdater(
  refresher: Refresher,
  extra: { statusLine?: boolean; clock?: () => number; timers?: Timers } = {},
): StatusLineUpdater {
  return createStatusLineUpdater({
    refresher,
    statusLine: extra.statusLine ?? true,
    clock: extra.clock ?? (() => NOW),
    ...(extra.timers === undefined ? {} : { timers: extra.timers }),
  });
}

function statusTexts(status: { calls: StatusCalls[] }): (string | undefined)[] {
  return status.calls.map((call) => call.text);
}

test("status updater: writes the cached entry of the current model's provider", () => {
  const { refresher } = fakeRefresher({
    providers: ["zai"],
    entries: { zai: providerEntry() },
  });
  const update = statusUpdater(refresher);
  const fake = fakeStatusContext();
  update(fake.ctx, { provider: "zai", id: "zai-large" });
  assert.deepEqual(fake.calls, [{ key: PURSE_STATUS_KEY, text: "5h 50%" }]);
});

test("status updater: clears without a current model", () => {
  const { refresher } = fakeRefresher({ providers: ["zai"], entries: { zai: providerEntry() } });
  const update = statusUpdater(refresher);
  const fake = fakeStatusContext();
  update(fake.ctx, undefined);
  assert.deepEqual(fake.calls, [{ key: PURSE_STATUS_KEY, text: undefined }]);
});

test("status updater: cleared when statusLine is false", () => {
  const { refresher } = fakeRefresher({ providers: ["zai"], entries: { zai: providerEntry() } });
  const update = statusUpdater(refresher, { statusLine: false });
  const fake = fakeStatusContext();
  update(fake.ctx, { provider: "zai", id: "zai-large" });
  assert.deepEqual(fake.calls, [{ key: PURSE_STATUS_KEY, text: undefined }]);
});

test("status updater: cleared in json mode or without a UI", () => {
  const { refresher } = fakeRefresher({ providers: ["zai"], entries: { zai: providerEntry() } });
  const update = statusUpdater(refresher);
  for (const options of [{ mode: "json" as const }, { hasUI: false }]) {
    const fake = fakeStatusContext(options);
    update(fake.ctx, { provider: "zai", id: "zai-large" });
    assert.deepEqual(fake.calls, [{ key: PURSE_STATUS_KEY, text: undefined }]);
  }
});

test("status updater: not active with statusLine false, so no refresh is requested", () => {
  assert.equal(statusLineActive(false, fakeStatusContext().ctx), false);
});

test("status updater: active in tui and rpc mode with a UI", () => {
  assert.equal(statusLineActive(true, fakeStatusContext({ mode: "tui" }).ctx), true);
  assert.equal(statusLineActive(true, fakeStatusContext({ mode: "rpc" }).ctx), true);
});

test("status updater: not active in json or print mode or without a UI, so no refresh is requested", () => {
  assert.equal(statusLineActive(true, fakeStatusContext({ mode: "json" }).ctx), false);
  assert.equal(statusLineActive(true, fakeStatusContext({ mode: "print" }).ctx), false);
  assert.equal(statusLineActive(true, fakeStatusContext({ hasUI: false }).ctx), false);
});

test("status updater: cleared without a live context", () => {
  const { refresher } = fakeRefresher({ ready: false, providers: ["zai"] });
  const update = statusUpdater(refresher);
  const fake = fakeStatusContext();
  update(fake.ctx, { provider: "zai", id: "zai-large" });
  assert.deepEqual(fake.calls, [{ key: PURSE_STATUS_KEY, text: undefined }]);
});

test("status updater: cleared when the entry has nothing to show", () => {
  const { refresher } = fakeRefresher({
    providers: ["zai"],
    entries: {
      zai: providerEntry({ limits: { state: "not-exposed" }, balance: { state: "not-exposed" } }),
    },
  });
  const update = statusUpdater(refresher);
  const fake = fakeStatusContext();
  update(fake.ctx, { provider: "zai", id: "zai-large" });
  assert.deepEqual(fake.calls, [{ key: PURSE_STATUS_KEY, text: undefined }]);
});

function entryWithReset(resetsAt: number): ProviderEntry {
  return providerEntry({ limits: { state: "known", value: [limitWindow({ resetsAt })] } });
}

test("status updater: renders again every minute while a time left is shown", () => {
  const { refresher, calls } = fakeRefresher({
    providers: ["zai"],
    entries: { zai: entryWithReset(NOW + 3_600_000) },
  });
  const fake = fakeTimers();
  const update = statusUpdater(refresher, { clock: fake.clock, timers: fake.timers });
  const status = fakeStatusContext();

  update(status.ctx, { provider: "zai", id: "zai-large" });
  assert.deepEqual(statusTexts(status), ["5h 50% 1h"]);

  fake.advance(59_000);
  assert.deepEqual(statusTexts(status), ["5h 50% 1h"]);

  fake.advance(1_000);
  assert.deepEqual(statusTexts(status), ["5h 50% 1h", "5h 50% 59m"]);

  fake.advance(60_000);
  assert.equal(statusTexts(status).at(-1), "5h 50% 58m");
  assert.deepEqual(calls, []);
  assert.equal(fake.pending(), 1);
});

test("status updater: no timer while no time left is shown", () => {
  const entries = [
    providerEntry(),
    providerEntry({ status: "free" }),
    providerEntry({ limits: { state: "not-exposed" } }),
  ];
  for (const entry of entries) {
    const { refresher } = fakeRefresher({ providers: ["zai"], entries: { zai: entry } });
    const fake = fakeTimers();
    const update = statusUpdater(refresher, { clock: fake.clock, timers: fake.timers });
    const status = fakeStatusContext();
    update(status.ctx, { provider: "zai", id: "zai-large" });
    assert.equal(fake.pending(), 0);
  }
});

test("status updater: the timer stops when the text loses its time left", () => {
  const { refresher, entries } = fakeRefresher({
    providers: ["zai"],
    entries: { zai: entryWithReset(NOW + 3_600_000) },
  });
  const fake = fakeTimers();
  const update = statusUpdater(refresher, { clock: fake.clock, timers: fake.timers });
  const status = fakeStatusContext();
  update(status.ctx, { provider: "zai", id: "zai-large" });
  assert.equal(fake.pending(), 1);

  entries.set("zai", providerEntry());
  fake.advance(60_000);
  assert.equal(statusTexts(status).at(-1), "5h 50%");
  assert.equal(fake.pending(), 0);

  fake.advance(120_000);
  assert.equal(status.calls.length, 2);
});

test("status updater: no timer once the status is cleared", () => {
  const { refresher } = fakeRefresher({
    providers: ["zai"],
    entries: { zai: entryWithReset(NOW + 3_600_000) },
  });
  const fake = fakeTimers();
  const update = statusUpdater(refresher, { clock: fake.clock, timers: fake.timers });
  const status = fakeStatusContext();
  update(status.ctx, { provider: "zai", id: "zai-large" });
  assert.equal(fake.pending(), 1);

  update(status.ctx, undefined);
  assert.equal(fake.pending(), 0);
  fake.advance(600_000);
  assert.deepEqual(status.calls.at(-1), { key: PURSE_STATUS_KEY, text: undefined });
});

test("status updater: no timer while the status line is not active", () => {
  const { refresher } = fakeRefresher({
    providers: ["zai"],
    entries: { zai: entryWithReset(NOW + 3_600_000) },
  });
  const fake = fakeTimers();
  const update = statusUpdater(refresher, {
    statusLine: false,
    clock: fake.clock,
    timers: fake.timers,
  });
  const status = fakeStatusContext();
  update(status.ctx, { provider: "zai", id: "zai-large" });
  assert.equal(fake.pending(), 0);
});
