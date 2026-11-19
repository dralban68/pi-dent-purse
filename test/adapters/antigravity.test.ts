import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { AdapterDependencies, TransportOutcome, TransportRequest } from "../../lib/adapter.ts";
import { antigravity } from "../../lib/adapters/antigravity.ts";
import type { AdapterResult, AdapterSuccess, LimitWindowCapture } from "../../lib/state.ts";

/** The `apiKey` blob the host stores for the provider (redacted; never a real credential). */
const TOKEN = "unit-test-token";
const PROJECT = "unit-test-project";
const API_KEY = JSON.stringify({ token: TOKEN, projectId: PROJECT });

const QUOTA_FIXTURE = readFileSync(
  new URL("../fixtures/antigravity/quota-summary.json", import.meta.url),
  "utf8",
);
const ASSIST_FIXTURE = readFileSync(
  new URL("../fixtures/antigravity/load-code-assist.json", import.meta.url),
  "utf8",
);

interface Harness {
  deps: AdapterDependencies;
  requests: TransportRequest[];
  apiKeys: string[];
}

function harness(outcomes: readonly TransportOutcome[], oauth = true): Harness {
  const requests: TransportRequest[] = [];
  const apiKeys: string[] = [];
  const deps: AdapterDependencies = {
    transport: async (request) => {
      requests.push(request);
      return (
        outcomes[requests.length - 1] ??
        outcomes[outcomes.length - 1] ?? {
          reason: "network",
        }
      );
    },
    commandRunner: async () => {
      throw new Error("no commands");
    },
    credentials: async () => {
      apiKeys.push(API_KEY);
      return oauth ? { apiKey: API_KEY, oauth } : { apiKey: "unit-test-api-key", oauth: false };
    },
    inventory: [
      {
        id: "gemini-3.8-pro",
        baseUrl: "https://daily-cloudcode-pa.googleapis.com",
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    clock: () => 1794660000000,
    configuration: {},
    store: { get: () => undefined, set: () => {} },
    observations: { latest: () => undefined },
  };
  return { deps, requests, apiKeys };
}

function ok(body: string): TransportOutcome {
  return { status: 200, headers: {}, body };
}

function status(
  reason: "http-403" | "http-429" | "http-error",
  statusCode?: number,
  retryAfter?: number,
): TransportOutcome {
  const outcome: TransportOutcome & { reason: string } = { reason };
  if (statusCode !== undefined) outcome.status = statusCode;
  if (retryAfter !== undefined) outcome.retryAfter = retryAfter;
  return outcome;
}

async function run(outcomes: readonly TransportOutcome[], oauth = true): Promise<AdapterResult> {
  return antigravity.run(harness(outcomes, oauth).deps, new AbortController().signal);
}

function success(result: AdapterResult): AdapterSuccess {
  if ("reason" in result) assert.fail(`expected success, got ${result.reason}`);
  return result;
}

/** The known limit windows of a success, else `[]`. */
function knownWindows(result: AdapterSuccess): LimitWindowCapture[] {
  const limits = result.facets.limits;
  return limits !== undefined && limits.state === "known" ? limits.value : [];
}

test("profile constants (Section 1)", () => {
  assert.equal(antigravity.id, "antigravity");
  assert.equal(antigravity.providerOrigin, "https://daily-cloudcode-pa.googleapis.com");
  assert.deepEqual(antigravity.hostAllowlist, [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
  ]);
  assert.deepEqual(antigravity.exposedFacets, ["plan", "limits"]);
  assert.equal(antigravity.freshnessSeconds, 300);
});

test("an API key is unsupported-auth without a request (Section 2)", async () => {
  const h = harness([ok(QUOTA_FIXTURE), ok(ASSIST_FIXTURE)], false);
  assert.deepEqual(await antigravity.run(h.deps, new AbortController().signal), {
    reason: "unsupported-auth",
  });
  assert.equal(h.requests.length, 0);
});

test("a credential that is not the stored object is unsupported-auth without a request (Section 2)", async () => {
  for (const apiKey of [
    "",
    "not json",
    "[]",
    '{"token":"t"}',
    '{"projectId":"p"}',
    '{"token":"t\n","projectId":"p"}',
  ]) {
    const requests: TransportRequest[] = [];
    const deps: AdapterDependencies = {
      ...harness([ok(QUOTA_FIXTURE), ok(ASSIST_FIXTURE)]).deps,
      credentials: async () => ({ apiKey, oauth: true }),
      transport: async (request) => {
        requests.push(request);
        return ok("{}");
      },
    };
    assert.deepEqual(await antigravity.run(deps, new AbortController().signal), {
      reason: "unsupported-auth",
    });
    assert.equal(requests.length, 0);
  }
});

test("missing credentials are no-credentials (Section 2)", async () => {
  const requests: TransportRequest[] = [];
  const deps: AdapterDependencies = {
    ...harness([]).deps,
    credentials: async () => undefined,
    transport: async (request) => {
      requests.push(request);
      return ok("{}");
    },
  };
  assert.deepEqual(await antigravity.run(deps, new AbortController().signal), {
    reason: "no-credentials",
  });
  assert.equal(requests.length, 0);
});

test("two POSTs, the quota summary before the plan, with the verbatim bodies (Sections 3–4)", async () => {
  const h = harness([ok(QUOTA_FIXTURE), ok(ASSIST_FIXTURE)]);
  await antigravity.run(h.deps, new AbortController().signal);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(
    h.requests.map((request) => request.url),
    [
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    ],
  );
  for (const request of h.requests) {
    assert.equal(request.method, "POST");
    assert.deepEqual(request.headers, {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "user-agent":
        "antigravity/cli/1.5.5 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)",
    });
    assert.equal(request.bodyCap, 1048576);
  }
  assert.equal(h.requests[0]?.body, "{}");
  assert.equal(
    h.requests[1]?.body,
    '{"metadata":{"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}}',
  );
});

test("the recorded bodies yield plan, quota-pool windows, and credit windows (Sections 3–4)", async () => {
  const result = success(await run([ok(QUOTA_FIXTURE), ok(ASSIST_FIXTURE)]));
  assert.deepEqual(result.facets.plan, { state: "known", value: "Google AI Pro" });
  assert.deepEqual(result.facets.limits, {
    state: "known",
    value: [
      {
        id: "gemini-pro-pool",
        label: "Gemini Pro",
        unit: "percent",
        used: null,
        limit: null,
        percent: 10,
        resetsAt: 1906531200000,
        windowSeconds: null,
        models: [],
        source: "endpoint",
      },
      {
        id: "Shared pool",
        label: "Shared pool",
        unit: "percent",
        used: null,
        limit: null,
        percent: 50,
        resetsAt: null,
        windowSeconds: null,
        models: [],
        source: "endpoint",
      },
      {
        id: "claude-gpt-pool",
        label: "Claude and GPT",
        unit: "percent",
        used: null,
        limit: null,
        percent: 75,
        resetsAt: 1906848000000,
        windowSeconds: null,
        models: [],
        source: "endpoint",
      },
      {
        id: "credits:GOOGLE_ONE_AI",
        label: "credits",
        unit: "credits",
        used: null,
        limit: 8,
        percent: null,
        resetsAt: null,
        windowSeconds: null,
        models: null,
        source: "endpoint",
      },
      {
        id: "credits",
        label: "credits",
        unit: "credits",
        used: null,
        limit: 5,
        percent: null,
        resetsAt: null,
        windowSeconds: null,
        models: null,
        source: "endpoint",
      },
    ],
  });
  assert.equal("firstFailure" in result, false);
});

test("a bucket outside [0, 1] is skipped and a repeated id keeps the first (Section 3)", async () => {
  const body = JSON.stringify({
    groups: [
      {
        buckets: [
          { bucketId: "pool", remainingFraction: 1.5 },
          { bucketId: "pool", remainingFraction: 0.75 },
        ],
      },
    ],
  });
  const result = success(await run([ok(body), ok(ASSIST_FIXTURE)]));
  const percents = knownWindows(result)
    .filter((window) => window.id === "pool")
    .map((window) => window.percent);
  assert.deepEqual(percents, [25]);
});

test("no buckets anywhere are empty-response (Section 3)", async () => {
  const result = success(await run([ok('{"groups":[]}'), ok("{}")]));
  assert.deepEqual(result.facets.limits, { state: "unavailable", reason: "empty-response" });
  assert.deepEqual(result.facets.plan, { state: "unavailable", reason: "empty-response" });
});

test("a 403 quota summary is http-403 on limits while plan stays known (Section 3)", async () => {
  const result = success(await run([status("http-403", 403), ok(ASSIST_FIXTURE)]));
  assert.deepEqual(result.facets.limits, { state: "unavailable", reason: "http-403" });
  assert.deepEqual(result.facets.plan, { state: "known", value: "Google AI Pro" });
  assert.deepEqual(result.firstFailure, { reason: "http-403" });
});

test("a failed plan request keeps the quota windows and marks plan unavailable (Section 4)", async () => {
  const result = success(await run([ok(QUOTA_FIXTURE), status("http-error", 500)]));
  assert.deepEqual(result.facets.plan, { state: "unavailable", reason: "http-error" });
  assert.deepEqual(
    knownWindows(result).map((window) => window.id),
    ["gemini-pro-pool", "Shared pool", "claude-gpt-pool"],
  );
  assert.deepEqual(result.firstFailure, { reason: "http-error" });
});

test("the first failure in issue order wins when both requests fail (Sections 3–4)", async () => {
  const result = success(await run([status("http-429", 429, 30), status("http-error", 500)]));
  assert.deepEqual(result.facets.limits, { state: "unavailable", reason: "http-429" });
  assert.deepEqual(result.facets.plan, { state: "unavailable", reason: "http-error" });
  assert.deepEqual(result.firstFailure, { reason: "http-429", retryAfter: 30 });
});

test("a body that is not an object is bad-response on its facet (Sections 3–4)", async () => {
  const result = success(await run([ok("[]"), ok("not json")]));
  assert.deepEqual(result.facets.limits, { state: "unavailable", reason: "bad-response" });
  assert.deepEqual(result.facets.plan, { state: "unavailable", reason: "bad-response" });
  assert.deepEqual(result.firstFailure, { reason: "bad-response" });
});

test("known durations and group names yield compact labels, windowSeconds, and model scopes (Section 3)", async () => {
  const body = JSON.stringify({
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          {
            bucketId: "gemini-weekly",
            displayName: "Weekly Limit Remaining",
            remainingFraction: 0.969,
          },
          {
            bucketId: "gemini-5h",
            displayName: "Five Hour Limit Remaining",
            remainingFraction: 0.942,
          },
        ],
      },
      {
        displayName: "Claude and GPT models",
        buckets: [
          {
            bucketId: "cg-weekly",
            displayName: "Weekly Limit Remaining",
            remainingFraction: 1,
          },
          {
            bucketId: "cg-5h",
            displayName: "Five Hour Limit Remaining",
            remainingFraction: 1,
          },
        ],
      },
      {
        displayName: "Gemini 4 Argon",
        buckets: [
          {
            bucketId: "argon-weekly",
            displayName: "Gemini 4 Argon Weekly Limit",
            remainingFraction: 1,
          },
        ],
      },
      {
        displayName: "Other Model",
        buckets: [
          {
            bucketId: "other-weekly",
            displayName: "Weekly Limit Remaining",
            remainingFraction: 0.8,
          },
        ],
      },
      {
        buckets: [
          {
            bucketId: "ungrouped-5h",
            displayName: "5h Limit",
            remainingFraction: 0.5,
          },
        ],
      },
    ],
  });
  const base = harness([ok(body), ok("{}")]);
  const deps: AdapterDependencies = {
    ...base.deps,
    inventory: ["claude-opus-5-5", "gemini-4-argon", "gemini-4-hydrogen", "gpt-oss-120b"].map(
      (id) => ({
        id,
        baseUrl: "https://daily-cloudcode-pa.googleapis.com",
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      }),
    ),
  };
  const result = success(await antigravity.run(deps, new AbortController().signal));
  assert.deepEqual(
    knownWindows(result).map(({ id, label, windowSeconds, models }) => ({
      id,
      label,
      windowSeconds,
      models,
    })),
    [
      {
        id: "gemini-weekly",
        label: "7d gemini",
        windowSeconds: 604800,
        models: ["gemini-4-argon", "gemini-4-hydrogen"],
      },
      {
        id: "gemini-5h",
        label: "5h gemini",
        windowSeconds: 18000,
        models: ["gemini-4-argon", "gemini-4-hydrogen"],
      },
      {
        id: "cg-weekly",
        label: "7d claude/gpt",
        windowSeconds: 604800,
        models: ["claude-opus-5-5", "gpt-oss-120b"],
      },
      {
        id: "cg-5h",
        label: "5h claude/gpt",
        windowSeconds: 18000,
        models: ["claude-opus-5-5", "gpt-oss-120b"],
      },
      {
        id: "argon-weekly",
        label: "7d gemini 4 argon",
        windowSeconds: 604800,
        models: ["gemini-4-argon"],
      },
      {
        id: "other-weekly",
        label: "7d other",
        windowSeconds: 604800,
        models: [],
      },
      {
        id: "ungrouped-5h",
        label: "5h",
        windowSeconds: 18000,
        models: null,
      },
    ],
  );
});
