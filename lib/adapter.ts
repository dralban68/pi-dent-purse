/**
 * The adapter interface and the dependencies an adapter receives (adapter-contract.md).
 * Types and spec-fixed constants only; no logic.
 */

import type {
  AdapterFailure,
  AdapterProfile,
  AdapterResult,
  ProviderSettings,
  Rates,
} from "./state.ts";

/** Deadline of one request (Section 4); the refresh signal may stop it earlier. */
export const REQUEST_DEADLINE_MS = 8000;

/**
 * An adapter (Sections 1–2): its id is its provider id; the constants come from its adapter
 * spec. `exposedFacets`, `freshnessSeconds`, and `credentialVariable` come from
 * `AdapterProfile`.
 */
export interface Adapter extends AdapterProfile {
  /** The provider id (Section 1). */
  id: string;
  /**
   * The https origin the host sends the provider's inference requests to (Section 1); absent
   * for a tool provider, which has none.
   */
  providerOrigin?: string;
  /** The https origins the adapter may contact (Section 1). */
  hostAllowlist: readonly string[];
  /**
   * Runs one refresh (Section 2). Must not throw across the boundary: an unexpected exception
   * is a whole failure with `internal`. `signal` aborts at the refresh deadline.
   */
  run(deps: AdapterDependencies, signal: AbortSignal): Promise<AdapterResult>;
}

/**
 * The only way an adapter reaches the outside (Section 2). The refresh layer builds it after
 * the Section 3 checks passed: `transport` is bound to the adapter's `hostAllowlist`, and
 * `credentials` resolves to checked credentials.
 */
export interface AdapterDependencies {
  transport: Transport;
  commandRunner: CommandRunner;
  credentials: Credentials;
  /** The inventory models of the adapter's provider. */
  inventory: readonly InventoryModel[];
  clock: Clock;
  configuration: ProviderConfiguration;
  store: Store;
  observations: Observations;
}

/**
 * One request under Section 4: method `GET`, `accept: application/json` and
 * `user-agent: pi-dent-purse` added by the transport. The allowlist is bound into the transport.
 */
export interface TransportRequest {
  /** An `https:` URL without userinfo whose origin is in the bound allowlist, else `internal`. */
  url: string;
  /** Only the headers the adapter spec lists (Sections 3–4). */
  headers?: Record<string, string>;
  /** Body cap in bytes of a 2xx body (Section 4). */
  bodyCap: number;
  /** The refresh's abort signal: aborted means `deadline`; the 8-second expiry is `timeout`. */
  signal: AbortSignal;
}

/** A transport success (Section 2). */
export interface TransportSuccess {
  status: number;
  /** Lowercase-keyed. */
  headers: Record<string, string>;
  /** Body text. */
  body: string;
}

/** A transport failure (Sections 2, 4): `status` is present when a response arrived. */
export interface TransportFailure extends AdapterFailure {
  status?: number;
}

/**
 * Outcome of one request: a failure is the outcome with a `reason` field (Section 2).
 */
export type TransportOutcome = TransportSuccess | TransportFailure;

/**
 * Performs one request (Section 2); never rejects.
 */
export type Transport = (request: TransportRequest) => Promise<TransportOutcome>;

/** One command under Section 5: no shell, run in the user's home directory. */
export interface CommandRequest {
  command: string;
  /** The argument vector the adapter spec gives. */
  args: readonly string[];
  /** Deadline in milliseconds, from the adapter spec. */
  deadlineMs: number;
  /** Output cap in bytes, from the adapter spec. */
  outputCap: number;
  /** The refresh's abort signal; aborted means `deadline` (as for `TransportRequest`). */
  signal: AbortSignal;
}

/**
 * A command that ran to exit (Section 2). A missing executable arrives here with code 1 and
 * `ENOENT` in `stderr` (docs/development.md, Exec).
 */
export interface CommandSuccess {
  code: number;
  stdout: string;
  stderr: string;
}

/** A command failure (Sections 2, 5): `timeout`, `deadline`, `response-too-large`, or `internal`. */
export interface CommandFailure {
  reason: AdapterFailure["reason"];
}

/** Outcome of one command: a failure is the outcome with a `reason` field (Section 2). */
export type CommandOutcome = CommandSuccess | CommandFailure;

/** Runs one command (Section 2); never rejects. */
export type CommandRunner = (request: CommandRequest) => Promise<CommandOutcome>;

/** Credentials of a provider as the host resolves them (Section 3). */
export interface ProviderCredentials {
  apiKey?: string;
  oauth: boolean;
  baseUrl?: string;
}

/** Credentials that passed the Section 3 checks: a non-empty `apiKey`. */
export interface CheckedCredentials {
  apiKey: string;
  oauth: boolean;
}

/**
 * Credentials of the adapter's provider (Sections 2–3): the first call returns the credentials
 * the refresh checked; each later call resolves and checks them afresh, `undefined` when the
 * checks fail.
 */
export type Credentials = () => Promise<CheckedCredentials | undefined>;

/** One tier of an inventory cost: rates above an input-token count, USD per million tokens. */
export interface InventoryCostTier {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** An inventory model's cost, USD per million tokens (Section 2). */
export interface InventoryCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: readonly InventoryCostTier[];
}

/** An inventory model (Section 2): the one inventory shape of purse. */
export interface InventoryModel {
  id: string;
  baseUrl: string;
  cost: InventoryCost;
}

/** Current epoch milliseconds (Section 2). */
export type Clock = () => number;

/**
 * The provider's configuration section (Section 2, config-file.md Section 2): the keys
 * entry derivation reads, `project` (`google` only), and the rate overrides.
 */
export interface ProviderConfiguration extends ProviderSettings {
  project?: string;
  /** Rate overrides keyed by model id (prices.md Section 2). */
  prices?: Record<string, { [Field in keyof Rates]?: number | null }>;
}

/**
 * Adapter-private key-value state with per-item expiry, discarded with the cache (Section 2):
 * synchronous, `undefined` for absent or expired, no `ttlSeconds` meaning no expiry.
 */
export interface Store {
  get(key: string): unknown;
  set(key: string, value: unknown, ttlSeconds?: number): void;
}

/**
 * Read access to the header observations of the adapter's provider (Section 2): `undefined`
 * when none exists. The observation is in the shape the provider's adapter spec fixes, so it
 * is `unknown` here and the adapter narrows it with a type guard.
 */
export interface Observations {
  latest(): unknown;
}
