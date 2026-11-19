/**
 * The adapters of specs/adapter-contract.md Section 1, keyed by provider id. Every provider not
 * listed here has no adapter.
 */

import type { Adapter } from "../adapter.ts";
import { antigravity } from "./antigravity.ts";
import { amd } from "./amd.ts";
import { anthropic } from "./anthropic.ts";
import { deepseek } from "./deepseek.ts";
import { exa } from "./exa.ts";
import { google } from "./google.ts";
import { openaiCodex } from "./openai-codex.ts";
import { zai } from "./zai.ts";

/** The adapters by provider id; pass to `createRefresher({ adapters: ADAPTERS })`. */
export const ADAPTERS: ReadonlyMap<string, Adapter> = new Map(
  [antigravity, amd, anthropic, deepseek, exa, google, openaiCodex, zai].map((adapter) => [
    adapter.id,
    adapter,
  ]),
);
