import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUILT_IN_SCHEDULES,
  DEEPSEEK_SCHEDULE,
  computeSchedule,
  deriveModelPrices,
  derivePrice,
  type InventoryCost,
  type InventoryModel,
  type ScheduleConfiguration,
} from "../lib/prices.ts";
import type { ScheduleWindow } from "../lib/state.ts";

function at(instant: string): number {
  return Date.parse(instant);
}

function inventoryCost(overrides: Partial<InventoryCost> = {}): InventoryCost {
  return { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, ...overrides };
}

function inventoryModel(id: string, overrides: Partial<InventoryCost> = {}): InventoryModel {
  return { id, cost: inventoryCost(overrides) };
}

function scheduleWindow(days: number[], from: string, to: string): ScheduleWindow {
  return { days, from, to };
}

function scheduleConfiguration(
  overrides: Partial<ScheduleConfiguration> = {},
): ScheduleConfiguration {
  return {
    multiplier: 0.5,
    timeZone: "UTC",
    windows: [scheduleWindow([3], "10:00", "11:00")],
    ...overrides,
  };
}

/** Wednesday 2026-11-11T12:00:00Z: DeepSeek's 10:00–24:00 window is active. */
const NOW = at("2026-11-11T12:00:00Z");

const ZERO_RATES = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const UNKNOWN_RATES = { input: null, output: null, cacheRead: null, cacheWrite: null };

test("inventory rates and tiers are copied", () => {
  const tiers = [
    { inputTokensAbove: 200_000, input: 3, output: 6, cacheRead: 0.3, cacheWrite: 0.6 },
  ];
  const price = derivePrice(inventoryModel("model-a", { tiers }), {
    provider: "zai",
    settings: {},
    now: NOW,
  });
  assert.deepEqual(price, {
    rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    tiers,
    source: "inventory",
    schedule: null,
  });
  assert.notEqual(price.tiers, tiers);
  const copied = price.tiers[0];
  const original = tiers[0];
  assert.ok(copied !== undefined && original !== undefined);
  assert.notEqual(copied, original);
});

test("an all-zero inventory cost is unknown", () => {
  const price = derivePrice(
    inventoryModel("free-model", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    { provider: "zai", settings: {}, now: NOW },
  );
  assert.deepEqual(price, {
    rates: UNKNOWN_RATES,
    tiers: [],
    source: "unknown",
    schedule: null,
  });
});

test("an all-zero inventory cost with tiers is an inventory price", () => {
  const tiers = [{ inputTokensAbove: 100_000, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }];
  const price = derivePrice(
    inventoryModel("tiered", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers }),
    { provider: "zai", settings: {}, now: NOW },
  );
  assert.deepEqual(price.rates, ZERO_RATES);
  assert.deepEqual(price.tiers, tiers);
  assert.equal(price.source, "inventory");
});

test("a single zero beside non-zero rates is a real zero", () => {
  const price = derivePrice(inventoryModel("zero-input", { input: 0 }), {
    provider: "zai",
    settings: {},
    now: NOW,
  });
  assert.equal(price.source, "inventory");
  assert.deepEqual(price.rates, { input: 0, output: 2, cacheRead: 0.1, cacheWrite: 0.2 });
});

test("configured rate fields replace inventory rates and keep tiers", () => {
  const tiers = [
    { inputTokensAbove: 200_000, input: 3, output: 6, cacheRead: 0.3, cacheWrite: 0.6 },
  ];
  const price = derivePrice(inventoryModel("model-a", { tiers }), {
    provider: "zai",
    settings: { prices: { "model-a": { input: 2.5, cacheRead: 0 } } },
    now: NOW,
  });
  assert.deepEqual(price.rates, { input: 2.5, output: 2, cacheRead: 0, cacheWrite: 0.2 });
  assert.deepEqual(price.tiers, tiers);
  assert.equal(price.source, "config");
});

test("a configured null rate is applied", () => {
  const price = derivePrice(inventoryModel("model-a"), {
    provider: "zai",
    settings: { prices: { "model-a": { output: null } } },
    now: NOW,
  });
  assert.deepEqual(price.rates, { input: 1, output: null, cacheRead: 0.1, cacheWrite: 0.2 });
  assert.equal(price.source, "config");
});

test("an override with no fields leaves the inventory source", () => {
  const price = derivePrice(inventoryModel("model-a"), {
    provider: "zai",
    settings: { prices: { "model-a": {} } },
    now: NOW,
  });
  assert.deepEqual(price.rates, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 });
  assert.equal(price.source, "inventory");
});

test("an override of another model does not apply", () => {
  const price = derivePrice(inventoryModel("model-a"), {
    provider: "zai",
    settings: { prices: { "model-b": { input: 9 } } },
    now: NOW,
  });
  assert.equal(price.rates.input, 1);
  assert.equal(price.source, "inventory");
});

test("an override of an unknown price applies to its unknown rates", () => {
  const price = derivePrice(
    inventoryModel("free-model", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    { provider: "zai", settings: { prices: { "free-model": { output: 1 } } }, now: NOW },
  );
  assert.deepEqual(price.rates, { input: null, output: 1, cacheRead: null, cacheWrite: null });
  assert.equal(price.source, "config");
});

test("a free provider has zero rates, no tiers, no schedule, and no overrides", () => {
  const price = derivePrice(inventoryModel("model-a"), {
    provider: "deepseek",
    settings: {
      free: true,
      prices: { "model-a": { input: 9 } },
      schedule: DEEPSEEK_SCHEDULE,
    },
    now: NOW,
  });
  assert.deepEqual(price, {
    rates: ZERO_RATES,
    tiers: [],
    source: "free",
    schedule: null,
  });
});

test("DeepSeek's built-in schedule is computed at the derivation time", () => {
  const price = derivePrice(inventoryModel("model-a"), {
    provider: "deepseek",
    settings: {},
    now: NOW,
  });
  assert.equal(price.source, "inventory");
  assert.deepEqual(price.rates, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 });
  assert.deepEqual(price.schedule, {
    multiplier: 0.5,
    timeZone: "UTC",
    windows: DEEPSEEK_SCHEDULE.windows,
    active: true,
    changesAt: at("2026-11-12T01:00:00Z"),
  });
});

test("the derivation time selects the schedule's active state", () => {
  const scheduled = (instant: string) => {
    const schedule = derivePrice(inventoryModel("model-a"), {
      provider: "deepseek",
      settings: {},
      now: at(instant),
    }).schedule;
    assert.ok(schedule !== null);
    return schedule;
  };
  const offPeak = scheduled("2026-11-11T02:00:00Z");
  assert.equal(offPeak.active, false);
  assert.equal(offPeak.changesAt, at("2026-11-11T04:00:00Z"));
  const peak = scheduled("2026-11-11T05:00:00Z");
  assert.equal(peak.active, true);
  assert.equal(peak.changesAt, at("2026-11-11T06:00:00Z"));
});

test("a configured null schedule disables the built-in one", () => {
  const price = derivePrice(inventoryModel("model-a"), {
    provider: "deepseek",
    settings: { schedule: null },
    now: NOW,
  });
  assert.equal(price.schedule, null);
});

test("a disabled adapter removes the built-in schedule", () => {
  const price = derivePrice(inventoryModel("model-a"), {
    provider: "deepseek",
    settings: { adapter: false },
    now: NOW,
  });
  assert.equal(price.schedule, null);
});

test("a configured schedule replaces the built-in one", () => {
  const configuration = scheduleConfiguration({
    multiplier: 0.75,
    timeZone: "UTC",
    windows: [scheduleWindow([3], "12:00", "13:00")],
  });
  const price = derivePrice(inventoryModel("model-a"), {
    provider: "deepseek",
    settings: { schedule: configuration },
    now: NOW,
  });
  assert.deepEqual(price.schedule, {
    multiplier: 0.75,
    timeZone: "UTC",
    windows: configuration.windows,
    active: true,
    changesAt: at("2026-11-11T13:00:00Z"),
  });
});

test("a configured schedule applies even when the adapter is disabled", () => {
  const price = derivePrice(inventoryModel("model-a"), {
    provider: "deepseek",
    settings: { adapter: false, schedule: scheduleConfiguration({ multiplier: 0.25 }) },
    now: NOW,
  });
  assert.ok(price.schedule !== null);
  assert.equal(price.schedule.multiplier, 0.25);
});

test("a provider without a built-in schedule gets none", () => {
  for (const provider of ["zai", "anthropic", "google"]) {
    const price = derivePrice(inventoryModel("model-a"), { provider, settings: {}, now: NOW });
    assert.equal(price.schedule, null);
  }
});

test("an unknown price still carries the provider's schedule", () => {
  const price = derivePrice(
    inventoryModel("free-model", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    { provider: "deepseek", settings: {}, now: NOW },
  );
  assert.equal(price.source, "unknown");
  assert.ok(price.schedule !== null);
  assert.equal(price.schedule.active, true);
});

test("the aggregate keeps inventory order and one computed schedule", () => {
  const models = [inventoryModel("first"), inventoryModel("second", { input: 5, output: 10 })];
  const prices = deriveModelPrices({ provider: "deepseek", models, settings: {}, now: NOW });
  assert.deepEqual(
    prices.map((entry) => entry.id),
    ["first", "second"],
  );
  assert.deepEqual(
    prices.map((entry) => entry.price.rates.input),
    [1, 5],
  );
  const [first, second] = prices;
  assert.ok(first !== undefined && second !== undefined);
  assert.deepEqual(first.price.schedule, second.price.schedule);
  assert.equal(first.price.schedule?.active, true);
});

test("the aggregate prices every model of a free provider as free", () => {
  const models = [inventoryModel("first"), inventoryModel("second")];
  const prices = deriveModelPrices({
    provider: "deepseek",
    models,
    settings: { free: true },
    now: NOW,
  });
  assert.equal(prices.length, 2);
  for (const entry of prices) {
    assert.deepEqual(entry.price, {
      rates: ZERO_RATES,
      tiers: [],
      source: "free",
      schedule: null,
    });
  }
});

test("computeSchedule copies its windows", () => {
  const configuration = scheduleConfiguration();
  const schedule = computeSchedule(configuration, NOW);
  assert.deepEqual(schedule.windows, configuration.windows);
  assert.notEqual(schedule.windows, configuration.windows);
  const original = configuration.windows[0];
  const copied = schedule.windows[0];
  assert.ok(original !== undefined && copied !== undefined);
  assert.notEqual(copied, original);
  assert.notEqual(copied.days, original.days);
});

test("DeepSeek's schedule matches the adapter spec", () => {
  assert.deepEqual(DEEPSEEK_SCHEDULE, {
    multiplier: 0.5,
    timeZone: "UTC",
    windows: [
      { days: [1, 2, 3, 4, 5], from: "00:00", to: "01:00" },
      { days: [1, 2, 3, 4, 5], from: "04:00", to: "06:00" },
      { days: [1, 2, 3, 4, 5], from: "10:00", to: "24:00" },
      { days: [0, 6], from: "00:00", to: "24:00" },
    ],
  });
  assert.equal(BUILT_IN_SCHEDULES.deepseek, DEEPSEEK_SCHEDULE);
  assert.equal(BUILT_IN_SCHEDULES.anthropic, undefined);
});

test("DeepSeek's windows are active and report their next change in UTC", () => {
  const scheduled = (instant: string) => computeSchedule(DEEPSEEK_SCHEDULE, at(instant));
  const cases: readonly (readonly [string, boolean, string | null])[] = [
    ["2026-11-11T00:30:00Z", true, "2026-11-11T01:00:00Z"],
    ["2026-11-11T01:00:00Z", false, "2026-11-11T04:00:00Z"],
    ["2026-11-11T03:59:59Z", false, "2026-11-11T04:00:00Z"],
    ["2026-11-11T04:00:00Z", true, "2026-11-11T06:00:00Z"],
    ["2026-11-11T06:00:00Z", false, "2026-11-11T10:00:00Z"],
    ["2026-11-11T10:00:00Z", true, "2026-11-12T01:00:00Z"],
    ["2026-11-12T03:00:00Z", false, "2026-11-12T04:00:00Z"],
    ["2026-11-16T00:30:00Z", true, "2026-11-16T01:00:00Z"],
    ["2026-11-13T23:00:00Z", true, "2026-11-16T01:00:00Z"],
    ["2026-11-14T12:00:00Z", true, "2026-11-16T01:00:00Z"],
    ["2026-11-15T23:59:00Z", true, "2026-11-16T01:00:00Z"],
  ];
  for (const [instant, active, changesAt] of cases) {
    const schedule = scheduled(instant);
    assert.equal(schedule.active, active, instant);
    assert.equal(schedule.changesAt, changesAt === null ? null : at(changesAt), instant);
  }
});

test("a weekly window reports the next week's start", () => {
  const configuration = scheduleConfiguration({ windows: [scheduleWindow([1], "09:00", "10:00")] });
  const active = computeSchedule(configuration, at("2026-11-09T09:30:00Z"));
  assert.equal(active.active, true);
  assert.equal(active.changesAt, at("2026-11-09T10:00:00Z"));
  const after = computeSchedule(configuration, at("2026-11-09T10:00:00Z"));
  assert.equal(after.active, false);
  assert.equal(after.changesAt, at("2026-11-16T09:00:00Z"));
  const midweek = computeSchedule(configuration, at("2026-11-10T12:00:00Z"));
  assert.equal(midweek.active, false);
  assert.equal(midweek.changesAt, at("2026-11-16T09:00:00Z"));
});

test("window days are local weekdays, not UTC weekdays", () => {
  const configuration = scheduleConfiguration({
    timeZone: "Asia/Kolkata",
    windows: [scheduleWindow([1], "09:00", "10:00")],
  });
  const active = computeSchedule(configuration, at("2026-11-09T03:30:00Z"));
  assert.equal(active.active, true);
  assert.equal(active.changesAt, at("2026-11-09T04:30:00Z"));
  const before = computeSchedule(configuration, at("2026-11-08T20:00:00Z"));
  assert.equal(before.active, false);
  assert.equal(before.changesAt, at("2026-11-09T03:30:00Z"));
  const after = computeSchedule(configuration, at("2026-11-09T05:00:00Z"));
  assert.equal(after.active, false);
  assert.equal(after.changesAt, at("2026-11-16T03:30:00Z"));
});

test("a window ending at 24:00 crosses midnight", () => {
  const configuration = scheduleConfiguration({ windows: [scheduleWindow([1], "22:00", "24:00")] });
  const active = computeSchedule(configuration, at("2026-11-09T22:00:00Z"));
  assert.equal(active.active, true);
  assert.equal(active.changesAt, at("2026-11-10T00:00:00Z"));
  const before = computeSchedule(configuration, at("2026-11-09T21:59:00Z"));
  assert.equal(before.active, false);
  assert.equal(before.changesAt, at("2026-11-09T22:00:00Z"));
  const atMidnight = computeSchedule(configuration, at("2026-11-10T00:00:00Z"));
  assert.equal(atMidnight.active, false);
  assert.equal(atMidnight.changesAt, at("2026-11-16T22:00:00Z"));
});

test("from is inclusive and to is exclusive", () => {
  const configuration = scheduleConfiguration({ windows: [scheduleWindow([3], "10:00", "11:00")] });
  const start = computeSchedule(configuration, at("2026-11-11T10:00:00Z"));
  assert.equal(start.active, true);
  assert.equal(start.changesAt, at("2026-11-11T11:00:00Z"));
  const lastMoment = computeSchedule(configuration, at("2026-11-11T10:59:59.999Z"));
  assert.equal(lastMoment.active, true);
  const end = computeSchedule(configuration, at("2026-11-11T11:00:00Z"));
  assert.equal(end.active, false);
  assert.equal(end.changesAt, at("2026-11-18T10:00:00Z"));
});

test("an always-active schedule never changes", () => {
  const configuration = scheduleConfiguration({
    windows: [scheduleWindow([0, 1, 2, 3, 4, 5, 6], "00:00", "24:00")],
  });
  const schedule = computeSchedule(configuration, at("2026-11-11T12:34:56.789Z"));
  assert.equal(schedule.active, true);
  assert.equal(schedule.changesAt, null);
});

test("an empty schedule is never active and never changes", () => {
  const schedule = computeSchedule(scheduleConfiguration({ windows: [] }), NOW);
  assert.equal(schedule.active, false);
  assert.equal(schedule.changesAt, null);
});

test("a spring-forward boundary that does not exist changes at the transition", () => {
  const configuration = scheduleConfiguration({
    timeZone: "America/New_York",
    windows: [scheduleWindow([0], "01:00", "02:00")],
  });
  const inside = computeSchedule(configuration, at("2026-03-08T06:30:00Z"));
  assert.equal(inside.active, true);
  assert.equal(inside.changesAt, at("2026-03-08T07:00:00Z"));
  const before = computeSchedule(configuration, at("2026-03-08T05:30:00Z"));
  assert.equal(before.active, false);
  assert.equal(before.changesAt, at("2026-03-08T06:00:00Z"));
  const after = computeSchedule(configuration, at("2026-03-08T07:00:00Z"));
  assert.equal(after.active, false);
  assert.equal(after.changesAt, at("2026-03-15T05:00:00Z"));
});

test("a window ending in the spring-forward gap ends at the transition", () => {
  const configuration = scheduleConfiguration({
    timeZone: "America/New_York",
    windows: [scheduleWindow([0], "00:00", "02:00")],
  });
  const schedule = computeSchedule(configuration, at("2026-03-08T05:00:00Z"));
  assert.equal(schedule.active, true);
  assert.equal(schedule.changesAt, at("2026-03-08T07:00:00Z"));
});

test("a window that crosses the spring-forward transition stays active", () => {
  const configuration = scheduleConfiguration({
    timeZone: "America/New_York",
    windows: [scheduleWindow([0], "00:00", "04:00")],
  });
  const schedule = computeSchedule(configuration, at("2026-03-08T05:00:00Z"));
  assert.equal(schedule.active, true);
  assert.equal(schedule.changesAt, at("2026-03-08T08:00:00Z"));
});

test("a window wholly inside the spring-forward gap never changes within 7 days", () => {
  const configuration = scheduleConfiguration({
    timeZone: "America/New_York",
    windows: [scheduleWindow([0], "02:00", "03:00")],
  });
  const schedule = computeSchedule(configuration, at("2026-03-08T05:00:00Z"));
  assert.equal(schedule.active, false);
  assert.equal(schedule.changesAt, null);
});

test("both occurrences of a repeated fall-back hour are active", () => {
  const configuration = scheduleConfiguration({
    timeZone: "America/New_York",
    windows: [scheduleWindow([0], "01:00", "01:30")],
  });
  const first = computeSchedule(configuration, at("2026-11-01T05:15:00Z"));
  assert.equal(first.active, true);
  assert.equal(first.changesAt, at("2026-11-01T05:30:00Z"));
  const gap = computeSchedule(configuration, at("2026-11-01T05:45:00Z"));
  assert.equal(gap.active, false);
  assert.equal(gap.changesAt, at("2026-11-01T06:00:00Z"));
  const second = computeSchedule(configuration, at("2026-11-01T06:15:00Z"));
  assert.equal(second.active, true);
  assert.equal(second.changesAt, at("2026-11-01T06:30:00Z"));
  const after = computeSchedule(configuration, at("2026-11-01T06:45:00Z"));
  assert.equal(after.active, false);
  assert.equal(after.changesAt, at("2026-11-08T06:00:00Z"));
});

test("a provider id naming an Object.prototype member has no built-in schedule", () => {
  for (const provider of ["constructor", "toString", "__proto__"]) {
    const prices = deriveModelPrices({
      provider,
      models: [{ id: "m", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      settings: {},
      now: NOW,
    });
    assert.equal(prices.length, 1);
  }
});
