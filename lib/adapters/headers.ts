/**
 * The header helpers the adapters share when they read the headers of inference responses
 * (adapter-anthropic.md Section 4, adapter-amd.md Section 2). No logic beyond parsing one value.
 */

import { finiteNumber } from "../state.ts";

/** The headers keyed by lowercase name: header names compare case-insensitively. */
export function lowercaseHeaders(headers: Readonly<Record<string, string>>): Map<string, string> {
  const lower = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) lower.set(name.toLowerCase(), value);
  return lower;
}

/**
 * A header value as a finite number, parsed with ECMAScript `Number` semantics
 * (StringToNumber); `null` when absent, empty after trimming, or not a finite number.
 */
export function headerNumber(headers: ReadonlyMap<string, string>, name: string): number | null {
  const value = headers.get(name)?.trim();
  if (value === undefined || value === "") return null;
  return finiteNumber(Number(value));
}
