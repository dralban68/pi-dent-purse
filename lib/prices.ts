/**
 * Price derivation per specs/prices.md: each inventory model's rates, tiers, source, and
 * schedule, from the inventory and the provider's configuration. The module is pure: it
 * reads no host API, network, file, or clock; the current time is a parameter.
 *
 * The price shapes are owned by lib/state.ts, the inventory shapes by lib/adapter.ts, and the
 * configuration shapes by lib/config.ts; this module re-exports the latter under its own names.
 */

import type {
  InventoryCost as AdapterInventoryCost,
  InventoryModel as AdapterInventoryModel,
} from "./adapter.ts";
import type { ProviderConfig, RateOverrides, ScheduleConfig } from "./config.ts";

import type {
  ModelPrice,
  Price,
  PriceSource,
  PriceTier,
  Rates,
  Schedule,
  ScheduleWindow,
} from "./state.ts";

/** An inventory model's cost, USD per million tokens (prices.md Section 2). */
export type InventoryCost = AdapterInventoryCost;

/** One tier of an inventory cost (prices.md Section 2). */
export type InventoryCostTier = NonNullable<InventoryCost["tiers"]>[number];

/** The inventory fields price derivation reads (prices.md Section 2). */
export type InventoryModel = Pick<AdapterInventoryModel, "id" | "cost">;

/** A provider's `prices.<model id>` rate overrides (config-file.md Section 2). */
export type RateOverride = RateOverrides;

/** A price schedule without its computed fields (config-file.md Section 2). */
export type ScheduleConfiguration = ScheduleConfig;

/** The provider configuration fields price derivation reads (config-file.md Section 2). */
export type PriceSettings = Pick<ProviderConfig, "free" | "adapter" | "prices" | "schedule">;

/** What one model's price derivation reads (prices.md Section 2). */
export interface PriceInput {
  provider: string;
  settings: PriceSettings;
  now: number;
}

/** What a provider's model prices derivation reads (prices.md Section 2). */
export interface ModelPricesInput extends PriceInput {
  models: readonly InventoryModel[];
}

/**
 * DeepSeek's built-in off-peak discount (adapter-deepseek.md Section 4, prices.md Section 3):
 * multiplier 0.5 in UTC on the windows below.
 */
export const DEEPSEEK_SCHEDULE: ScheduleConfiguration = {
  multiplier: 0.5,
  timeZone: "UTC",
  windows: [
    { days: [1, 2, 3, 4, 5], from: "00:00", to: "01:00" },
    { days: [1, 2, 3, 4, 5], from: "04:00", to: "06:00" },
    { days: [1, 2, 3, 4, 5], from: "10:00", to: "24:00" },
    { days: [0, 6], from: "00:00", to: "24:00" },
  ],
};

/** Built-in schedules by adapter id; an adapter spec gives at most one (prices.md Section 2). */
export const BUILT_IN_SCHEDULES: Readonly<Record<string, ScheduleConfiguration>> = {
  deepseek: DEEPSEEK_SCHEDULE,
};

const RATE_FIELDS: readonly (keyof Rates)[] = ["input", "output", "cacheRead", "cacheWrite"];

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * DAY_MS;
const TRANSITION_STEP_MS = 6 * 60 * 60 * 1000;

interface LocalDate {
  year: number;
  month: number;
  day: number;
}

interface LocalTime extends LocalDate {
  hour: number;
  minute: number;
  second: number;
}

/** A schedule window with its local times as minutes of the day. */
interface CompiledWindow {
  days: readonly number[];
  from: number;
  to: number;
}

/** Epoch milliseconds of a UTC wall time; `24:00` arrives here as the next day's zero minutes. */
function utcMillis(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(utcMillis(date.year, date.month, date.day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function dayOfWeek(date: LocalDate): number {
  return new Date(utcMillis(date.year, date.month, date.day)).getUTCDay();
}

/** Minutes of the day of an `HH:MM` local time; `24:00` is 1440. */
function clockMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * A time zone's wall clock through `Intl`: local parts and offset at an instant, the instants
 * a local wall time names, and the zone's offset transitions.
 */
class LocalZone {
  readonly #format: Intl.DateTimeFormat;

  constructor(timeZone: string) {
    this.#format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  }

  partsAt(instant: number): LocalTime {
    const local: LocalTime = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
    for (const part of this.#format.formatToParts(new Date(instant))) {
      switch (part.type) {
        case "year":
          local.year = Number(part.value);
          break;
        case "month":
          local.month = Number(part.value);
          break;
        case "day":
          local.day = Number(part.value);
          break;
        case "hour":
          local.hour = Number(part.value);
          break;
        case "minute":
          local.minute = Number(part.value);
          break;
        case "second":
          local.second = Number(part.value);
          break;
      }
    }
    return local;
  }

  /** The zone's offset from UTC at an instant, in milliseconds. */
  offsetAt(instant: number): number {
    const local = this.partsAt(instant);
    const wall = utcMillis(
      local.year,
      local.month,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    return wall - Math.floor(instant / 1000) * 1000;
  }

  /**
   * The instants a local date and minute of the day name. None in a daylight-saving gap and
   * two in a repeated hour.
   */
  instantsFor(date: LocalDate, minutes: number): number[] {
    const wall = utcMillis(date.year, date.month, date.day) + minutes * 60_000;
    const offsets = new Set<number>();
    for (const probe of [wall - DAY_MS, wall, wall + DAY_MS]) {
      offsets.add(this.offsetAt(probe));
    }
    const instants: number[] = [];
    for (const offset of offsets) {
      const instant = wall - offset;
      if (this.offsetAt(instant) === offset) instants.push(instant);
    }
    return instants.toSorted((left, right) => left - right);
  }

  /** Every offset transition instant in `[from, to]`, ascending. */
  transitions(from: number, to: number): number[] {
    const result: number[] = [];
    let start = Math.floor(from / 1000) * 1000;
    const limit = Math.floor(to / 1000) * 1000;
    while (start < limit) {
      const end = Math.min(start + TRANSITION_STEP_MS, limit);
      const transition = this.firstTransition(start, end);
      if (transition === null) {
        start = end;
      } else {
        result.push(transition);
        start = transition + 1000;
      }
    }
    return result;
  }

  /** The first whole second in `(from, to]` whose offset differs from `from`'s, if any. */
  private firstTransition(from: number, to: number): number | null {
    if (to <= from) return null;
    const before = this.offsetAt(from);
    if (this.offsetAt(to) === before) return null;
    let low = from;
    let high = to;
    while (high - low > 1000) {
      const middle = low + Math.floor((high - low) / 2000) * 1000;
      if (this.offsetAt(middle) === before) {
        low = middle;
      } else {
        high = middle;
      }
    }
    return high;
  }
}

/** Whether `instant` lies in a window, from inclusive and to exclusive, on its local day. */
function isActive(zone: LocalZone, windows: readonly CompiledWindow[], instant: number): boolean {
  const local = zone.partsAt(instant);
  const weekday = dayOfWeek(local);
  const minute =
    local.hour * 60 +
    local.minute +
    local.second / 60 +
    (instant - Math.floor(instant / 1000) * 1000) / 60_000;
  for (const window of windows) {
    if (!window.days.includes(weekday)) continue;
    if (minute >= window.from && minute < window.to) return true;
  }
  return false;
}

/** The next instant `active` changes, or `null` when it does not change within 7 days. */
function nextChange(
  zone: LocalZone,
  windows: readonly CompiledWindow[],
  now: number,
): number | null {
  const active = isActive(zone, windows, now);
  const horizon = now + SEVEN_DAYS_MS;
  const candidates = new Set<number>();

  const today = zone.partsAt(now);
  for (let offset = -1; offset <= 8; offset += 1) {
    const date = addDays(today, offset);
    const weekday = dayOfWeek(date);
    for (const window of windows) {
      if (!window.days.includes(weekday)) continue;
      for (const minutes of [window.from, window.to]) {
        for (const instant of zone.instantsFor(date, minutes)) {
          if (instant > now && instant <= horizon) candidates.add(instant);
        }
      }
    }
  }

  for (const instant of zone.transitions(now, horizon)) {
    if (instant > now && instant <= horizon) candidates.add(instant);
  }

  const ordered = [...candidates].toSorted((left, right) => left - right);
  for (const instant of ordered) {
    if (isActive(zone, windows, instant) !== active) return instant;
  }
  return null;
}

/** Derive a schedule's computed `active` and `changesAt` at `now` (prices.md Section 3). */
export function computeSchedule(configuration: ScheduleConfiguration, now: number): Schedule {
  const windows: ScheduleWindow[] = configuration.windows.map((window) => ({
    days: [...window.days],
    from: window.from,
    to: window.to,
  }));
  const compiled: CompiledWindow[] = windows.map((window) => ({
    days: window.days,
    from: clockMinutes(window.from),
    to: clockMinutes(window.to),
  }));
  const zone = new LocalZone(configuration.timeZone);
  return {
    multiplier: configuration.multiplier,
    timeZone: configuration.timeZone,
    windows,
    active: isActive(zone, compiled, now),
    changesAt: nextChange(zone, compiled, now),
  };
}

function zeroRates(): Rates {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function unknownRates(): Rates {
  return { input: null, output: null, cacheRead: null, cacheWrite: null };
}

function copyTier(tier: InventoryCostTier): PriceTier {
  return {
    inputTokensAbove: tier.inputTokensAbove,
    input: tier.input,
    output: tier.output,
    cacheRead: tier.cacheRead,
    cacheWrite: tier.cacheWrite,
  };
}

/** The schedule configuration the provider's price uses, before its computed fields. */
function scheduleConfiguration(
  provider: string,
  settings: PriceSettings,
): ScheduleConfiguration | null {
  if (settings.schedule !== undefined) return settings.schedule;
  if (settings.adapter === false) return null;
  return Object.hasOwn(BUILT_IN_SCHEDULES, provider)
    ? (BUILT_IN_SCHEDULES[provider] ?? null)
    : null;
}

/** The provider's schedule computed at `now`; `null` for a free provider or no schedule. */
function derivedSchedule(provider: string, settings: PriceSettings, now: number): Schedule | null {
  if (settings.free === true) return null;
  const configuration = scheduleConfiguration(provider, settings);
  return configuration === null ? null : computeSchedule(configuration, now);
}

/** One model's price: free, inventory cost, rate overrides, then the schedule (Section 2). */
function priceFor(
  model: InventoryModel,
  settings: PriceSettings,
  schedule: Schedule | null,
): Price {
  if (settings.free === true) {
    return { rates: zeroRates(), tiers: [], source: "free", schedule: null };
  }

  const cost = model.cost;
  const tiers = (cost.tiers ?? []).map(copyTier);
  const allZero =
    cost.input === 0 && cost.output === 0 && cost.cacheRead === 0 && cost.cacheWrite === 0;
  let rates: Rates;
  let source: PriceSource;
  if (allZero && tiers.length === 0) {
    rates = unknownRates();
    source = "unknown";
  } else {
    rates = {
      input: cost.input,
      output: cost.output,
      cacheRead: cost.cacheRead,
      cacheWrite: cost.cacheWrite,
    };
    source = "inventory";
  }

  const override = settings.prices?.[model.id];
  let applied = false;
  if (override !== undefined) {
    for (const field of RATE_FIELDS) {
      const value = override[field];
      if (value !== undefined) {
        rates[field] = value;
        applied = true;
      }
    }
  }
  if (applied) source = "config";

  return { rates, tiers, source, schedule };
}

/** Derive one inventory model's price (prices.md Section 2). */
export function derivePrice(model: InventoryModel, input: PriceInput): Price {
  return priceFor(
    model,
    input.settings,
    derivedSchedule(input.provider, input.settings, input.now),
  );
}

/** Derive the prices of a provider's inventory models, in inventory order (prices.md Section 2). */
export function deriveModelPrices(input: ModelPricesInput): ModelPrice[] {
  const schedule = derivedSchedule(input.provider, input.settings, input.now);
  return input.models.map((model) => ({
    id: model.id,
    price: priceFor(model, input.settings, schedule),
  }));
}
