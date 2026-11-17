/**
 * The DeepSeek adapter (specs/adapter-deepseek.md): the account balance endpoint and the
 * documented concurrency limits. Shared behavior is owned by specs/adapter-contract.md; the
 * capture shapes by specs/billing-state.md. The adapter performs no I/O of its own: every
 * request goes through the injected transport.
 *
 * The balance request is the adapter's only request. A balance problem — a failed request, a
 * body that is not JSON, a body violating the shape of Section 2, or no usable item — makes the
 * `balance` facet `unavailable` with its reason; the `limits` facet is known in every result
 * (Section 3). A failed request, or a `bad-response` body, is the result's `firstFailure`
 * (adapter-contract.md Section 2).
 */

import type { Adapter, AdapterDependencies, TransportFailure } from "../adapter.ts";
import type {
  AdapterFailure,
  AdapterResult,
  AdapterSuccess,
  BalanceItemCapture,
  Facet,
  LimitWindowCapture,
  ReasonCode,
} from "../state.ts";
import { finiteNumber } from "../state.ts";

/** The provider origin and the only allowed origin (Section 1). */
const PROVIDER_ORIGIN = "https://api.deepseek.com";

/** The balance endpoint (Section 2). */
const BALANCE_URL = "https://api.deepseek.com/user/balance";

/** Maximum bytes of one response body (Section 1). */
const BODY_CAP_BYTES = 16 * 1024;

/** An ISO 4217 code as the vendor sends it (Section 2). */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** A money amount as the vendor sends it: a decimal string, not a JSON number (Section 2). */
const AMOUNT_PATTERN = /^-?[0-9]+(\.[0-9]+)?$/;

/** One documented concurrency limit before its per-result copy (Section 3). */
interface DocumentedLimit {
  id: string;
  label: string;
  limit: number;
  models: readonly string[];
}

/** The documented concurrency limits (Section 3), in the spec's order. */
const DOCUMENTED_LIMITS: readonly DocumentedLimit[] = [
  {
    id: "concurrency-deepseek-flash",
    label: "concurrency flash",
    limit: 2500,
    models: ["deepseek-flash"],
  },
  {
    id: "concurrency-deepseek-v4-pro",
    label: "concurrency pro",
    limit: 500,
    models: ["deepseek-v4-pro"],
  },
];

/** A body that yields balance items, or the reason it yields none (Section 2). */
type BalanceOutcome = { items: BalanceItemCapture[] } | { reason: ReasonCode };

/** Whether `value` is a JSON object (not `null`, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a response body; `null` when it is not JSON (adapter-contract.md Section 4). */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** The documented concurrency limits as limit windows (Section 3). */
function documentedLimits(): LimitWindowCapture[] {
  return DOCUMENTED_LIMITS.map((limit) => ({
    id: limit.id,
    label: limit.label,
    unit: "concurrent-requests",
    used: null,
    limit: limit.limit,
    percent: null,
    resetsAt: null,
    windowSeconds: null,
    models: [...limit.models],
    source: "documented",
  }));
}

/**
 * The balance items a parsed body yields (Section 2): one per distinct currency that matches
 * the currency pattern and whose `total_balance` string matches the amount pattern, in body
 * order, the first of a repeated currency kept; `empty-response` when there is none.
 * `is_available` `false` overrides every item's severity to `exhausted`.
 */
function balanceItems(body: unknown): BalanceOutcome {
  if (!isRecord(body) || !Array.isArray(body.balance_infos)) {
    return { reason: "bad-response" };
  }

  const exhausted = body.is_available === false;
  const items: BalanceItemCapture[] = [];
  const seen = new Set<string>();
  for (const entry of body.balance_infos) {
    if (!isRecord(entry)) continue;
    const currency = entry.currency;
    const total = entry.total_balance;
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) continue;
    if (typeof total !== "string" || !AMOUNT_PATTERN.test(total)) continue;
    const amount = finiteNumber(Number(total));
    if (amount === null) continue;
    if (seen.has(currency)) continue;
    seen.add(currency);
    items.push({
      amount,
      currency,
      currencyAssumed: false,
      gatesUsage: true,
      ...(exhausted ? { severity: "exhausted" } : {}),
    });
  }

  if (items.length === 0) return { reason: "empty-response" };
  return { items };
}

/** A transport failure as the result's `firstFailure` (adapter-contract.md Section 2). */
function adapterFailure(failure: TransportFailure): AdapterFailure {
  return failure.retryAfter === undefined
    ? { reason: failure.reason }
    : { reason: failure.reason, retryAfter: failure.retryAfter };
}

/**
 * A result whose balance facet is `unavailable` with `reason`. A `bad-response` body makes the
 * request a failed one (adapter-contract.md Section 2); an `empty-response` body does not.
 */
function withUnavailableBalance(reason: ReasonCode): AdapterSuccess {
  const failed = reason === "bad-response";
  return {
    facets: {
      limits: { state: "known", value: documentedLimits() },
      balance: { state: "unavailable", reason },
    },
    ...(failed ? { firstFailure: { reason } } : {}),
  };
}

/** One refresh: checks, the balance request, then the mapping (Sections 2–3). */
async function refresh(deps: AdapterDependencies, signal: AbortSignal): Promise<AdapterResult> {
  // adapter-contract.md Section 3 checks ran before `run`; any credential type is accepted.
  const credentials = await deps.credentials();
  if (credentials === undefined) return { reason: "no-credentials" };
  const apiKey = credentials.apiKey;

  const outcome = await deps.transport({
    url: BALANCE_URL,
    headers: { authorization: `Bearer ${apiKey}` },
    bodyCap: BODY_CAP_BYTES,
    signal,
  });

  if ("reason" in outcome) {
    return {
      facets: {
        limits: { state: "known", value: documentedLimits() },
        balance: { state: "unavailable", reason: outcome.reason },
      },
      firstFailure: adapterFailure(outcome),
    };
  }

  const body = parseJson(outcome.body);
  if (body === null) return withUnavailableBalance("bad-response");
  const balance = balanceItems(body);
  if ("reason" in balance) return withUnavailableBalance(balance.reason);

  const limits: Facet<LimitWindowCapture[]> = { state: "known", value: documentedLimits() };
  return {
    facets: { limits, balance: { state: "known", value: balance.items } },
  };
}

/**
 * The DeepSeek adapter (Section 1): id `deepseek`, provider origin and host allowlist
 * `https://api.deepseek.com`, freshness period 300 seconds, exposed facets `balance` and
 * `limits`. Must not throw across the boundary; an unexpected exception is `internal`
 * (adapter-contract.md Section 2).
 */
export const deepseek: Adapter = {
  id: "deepseek",
  providerOrigin: PROVIDER_ORIGIN,
  hostAllowlist: [PROVIDER_ORIGIN],
  exposedFacets: ["balance", "limits"],
  freshnessSeconds: 300,
  async run(deps: AdapterDependencies, signal: AbortSignal): Promise<AdapterResult> {
    try {
      return await refresh(deps, signal);
    } catch {
      return { reason: "internal" };
    }
  },
};
