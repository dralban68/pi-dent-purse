import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { AdapterDependencies, TransportOutcome, TransportRequest } from "../../lib/adapter.ts";
import { openaiCodex } from "../../lib/adapters/openai-codex.ts";
import type { AdapterResult, AdapterSuccess } from "../../lib/state.ts";

const TOKEN = "unit-test-token";
const FIXTURE = readFileSync(
  new URL("../fixtures/openai-codex/usage-plus.json", import.meta.url),
  "utf8",
);

function harness(
  outcome: TransportOutcome,
  oauth = true,
): { deps: AdapterDependencies; requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  const deps: AdapterDependencies = {
    transport: async (request) => {
      requests.push(request);
      return outcome;
    },
    commandRunner: async () => {
      throw new Error("no commands");
    },
    credentials: async () => ({ apiKey: TOKEN, oauth }),
    inventory: [
      {
        id: "gpt-6-astra",
        baseUrl: "https://chatgpt.com/backend-api",
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    clock: () => 1794660000000,
    configuration: {},
    store: { get: () => undefined, set: () => {} },
    observations: { latest: () => undefined },
  };
  return { deps, requests };
}

function ok(body: string): TransportOutcome {
  return { status: 200, headers: {}, body };
}

async function run(outcome: TransportOutcome, oauth = true): Promise<AdapterResult> {
  return openaiCodex.run(harness(outcome, oauth).deps, new AbortController().signal);
}

function success(result: AdapterResult): AdapterSuccess {
  if ("reason" in result) assert.fail(`expected success, got ${result.reason}`);
  return result;
}

test("profile constants (Section 1)", () => {
  assert.equal(openaiCodex.id, "openai-codex");
  assert.equal(openaiCodex.providerOrigin, "https://chatgpt.com");
  assert.deepEqual(openaiCodex.hostAllowlist, ["https://chatgpt.com"]);
  assert.deepEqual(openaiCodex.exposedFacets, ["plan", "limits"]);
  assert.equal(openaiCodex.freshnessSeconds, 120);
});

test("an API key is unsupported-auth without a request (Section 2)", async () => {
  const h = harness(ok(FIXTURE), false);
  assert.deepEqual(await openaiCodex.run(h.deps, new AbortController().signal), {
    reason: "unsupported-auth",
  });
  assert.equal(h.requests.length, 0);
});

test("one GET with only the bearer header (Section 3)", async () => {
  const h = harness(ok(FIXTURE));
  await openaiCodex.run(h.deps, new AbortController().signal);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]?.url, "https://chatgpt.com/backend-api/wham/usage");
  assert.deepEqual(h.requests[0]?.headers, { authorization: `Bearer ${TOKEN}` });
  assert.equal(h.requests[0]?.bodyCap, 16384);
});

test("the recorded body yields plan and both windows (Sections 4-5)", async () => {
  const result = success(await run(ok(FIXTURE)));
  assert.deepEqual(result.facets.plan, { state: "known", value: "plus" });
  assert.deepEqual(result.facets.limits, {
    state: "known",
    value: [
      {
        id: "five-hour",
        label: "5h",
        unit: "percent",
        used: null,
        limit: null,
        percent: 12,
        resetsAt: 1794676533000,
        windowSeconds: 18000,
        models: null,
        source: "endpoint",
      },
      {
        id: "weekly",
        label: "7d",
        unit: "percent",
        used: null,
        limit: null,
        percent: 3,
        resetsAt: 1795263333000,
        windowSeconds: 604800,
        models: null,
        source: "endpoint",
      },
    ],
  });
  assert.equal("firstFailure" in result, false);
});

test("non-numbers are null and the window length defaults (Section 4)", async () => {
  const body = JSON.stringify({
    rate_limit: { secondary_window: { used_percent: "x", limit_window_seconds: 0 } },
  });
  const result = success(await run(ok(body)));
  assert.deepEqual(result.facets.limits, {
    state: "known",
    value: [
      {
        id: "weekly",
        label: "7d",
        unit: "percent",
        used: null,
        limit: null,
        percent: null,
        resetsAt: null,
        windowSeconds: 604800,
        models: null,
        source: "endpoint",
      },
    ],
  });
  assert.deepEqual(result.facets.plan, { state: "unavailable", reason: "empty-response" });
});

test("no window and no plan are empty-response (Sections 4-5)", async () => {
  const result = success(await run(ok(JSON.stringify({ rate_limit: null, plan_type: " " }))));
  assert.deepEqual(result.facets.limits, { state: "unavailable", reason: "empty-response" });
  assert.deepEqual(result.facets.plan, { state: "unavailable", reason: "empty-response" });
});

test("a non-object body is bad-response (Section 3)", async () => {
  for (const body of ["[]", "not json"]) {
    const result = success(await run(ok(body)));
    assert.deepEqual(result.facets.limits, { state: "unavailable", reason: "bad-response" });
    assert.deepEqual(result.facets.plan, { state: "unavailable", reason: "bad-response" });
    assert.deepEqual(result.firstFailure, { reason: "bad-response" });
  }
});

test("a failed request makes both facets unavailable (Section 3)", async () => {
  const result = success(await run({ reason: "http-429", status: 429, retryAfter: 30 }));
  assert.deepEqual(result.facets.limits, { state: "unavailable", reason: "http-429" });
  assert.deepEqual(result.facets.plan, { state: "unavailable", reason: "http-429" });
  assert.deepEqual(result.firstFailure, { reason: "http-429", retryAfter: 30 });
});
