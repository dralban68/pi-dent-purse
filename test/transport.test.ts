import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";

import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

import {
  REQUEST_DEADLINE_MS,
  type CommandRequest,
  type Transport,
  type TransportRequest,
} from "../lib/adapter.ts";
import {
  createCommandRunner,
  createTransport as createBoundTransport,
  type ExecFunction,
  type FetchFunction,
} from "../lib/transport.ts";

const ALLOWED: readonly string[] = ["https://apikeys.googleapis.com"];

/** The explicit default body cap the request helper applies when a test omits one. */
const DEFAULT_BODY_CAP = 262144;

/** A request plus the allowlist the transport under test is bound to. */
type TestRequest = TransportRequest & { allowedOrigins: readonly string[] };

/** Binds a transport per request to the request's `allowedOrigins`. */
function createTransport(fetch: FetchFunction): (request: TestRequest) => ReturnType<Transport> {
  return ({ allowedOrigins, ...request }) => createBoundTransport(fetch, allowedOrigins)(request);
}

function transportRequest(overrides: Partial<TestRequest> = {}): TestRequest {
  return Object.assign(
    {
      url: "https://apikeys.googleapis.com/v2/keys",
      allowedOrigins: ALLOWED,
      bodyCap: DEFAULT_BODY_CAP,
      signal: new AbortController().signal,
    },
    overrides,
  );
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function recordingFetch(handler: (call: FetchCall) => Response | Promise<Response>): {
  fetch: FetchFunction;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetch: FetchFunction = async (url, init) => {
    const call: FetchCall = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

/** A body that delivers `chunks` and then never closes, so a read after them stays pending. */
function openStream(chunks: readonly Uint8Array[] = []): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
  });
}

/** A body whose read only settles when the request is aborted. */
function hangingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>();
}

function fetchThatNeverSettles(): FetchFunction {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (signal === null || signal === undefined) return;
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
}

const text = (length: number): string => "a".repeat(length);

test("refuses a non-https URL with internal before connecting", async () => {
  const { fetch, calls } = recordingFetch(() => new Response("{}"));
  const outcome = await createTransport(fetch)(
    transportRequest({ url: "http://apikeys.googleapis.com/v2/keys" }),
  );
  assert.deepEqual(outcome, { reason: "internal" });
  assert.equal(calls.length, 0);
});

test("refuses a malformed URL with internal before connecting", async () => {
  const { fetch, calls } = recordingFetch(() => new Response("{}"));
  const outcome = await createTransport(fetch)(transportRequest({ url: "not a url" }));
  assert.deepEqual(outcome, { reason: "internal" });
  assert.equal(calls.length, 0);
});

test("refuses a host outside the allowlist with internal before connecting", async () => {
  const { fetch, calls } = recordingFetch(() => new Response("{}"));
  const outcome = await createTransport(fetch)(
    transportRequest({ url: "https://evil.example/v2/keys" }),
  );
  assert.deepEqual(outcome, { reason: "internal" });
  assert.equal(calls.length, 0);
});

test("refuses every request when the allowlist is empty", async () => {
  const { fetch, calls } = recordingFetch(() => new Response("{}"));
  const outcome = await createTransport(fetch)(transportRequest({ allowedOrigins: [] }));
  assert.deepEqual(outcome, { reason: "internal" });
  assert.equal(calls.length, 0);
});

test("compares origins, not paths, so a different path on an allowed origin proceeds", async () => {
  const { fetch, calls } = recordingFetch(() => new Response("{}"));
  const outcome = await createTransport(fetch)(
    transportRequest({ url: "https://apikeys.googleapis.com/v2/other?keyString=x" }),
  );
  assert.equal(calls.length, 1);
  assert.ok(!("reason" in outcome));
  assert.equal(outcome.body, "{}");
});

test("compares ports: a matching port is allowed, a differing one is refused", async () => {
  const matching = recordingFetch(() => new Response("{}"));
  const matchingOutcome = await createTransport(matching.fetch)(
    transportRequest({
      url: "https://apikeys.googleapis.com:8443/v2/keys",
      allowedOrigins: ["https://apikeys.googleapis.com:8443"],
    }),
  );
  assert.equal(matching.calls.length, 1);
  assert.ok(!("reason" in matchingOutcome));

  const differing = recordingFetch(() => new Response("{}"));
  const differingOutcome = await createTransport(differing.fetch)(
    transportRequest({
      url: "https://apikeys.googleapis.com:8443/v2/keys",
      allowedOrigins: ["https://apikeys.googleapis.com"],
    }),
  );
  assert.deepEqual(differingOutcome, { reason: "internal" });
  assert.equal(differing.calls.length, 0);
});

test("omits the default https port when comparing origins", async () => {
  const { fetch, calls } = recordingFetch(() => new Response("{}"));
  const outcome = await createTransport(fetch)(
    transportRequest({ url: "https://apikeys.googleapis.com:443/v2/keys" }),
  );
  assert.equal(calls.length, 1);
  assert.ok(!("reason" in outcome));
});

test("compares hosts case-insensitively and ignores trailing dots", async () => {
  const request = recordingFetch(() => new Response("{}"));
  const requestOutcome = await createTransport(request.fetch)(
    transportRequest({ url: "https://APIKEYS.GoogleAPIs.com./v2/keys" }),
  );
  assert.equal(request.calls.length, 1);
  assert.ok(!("reason" in requestOutcome));

  const allowlist = recordingFetch(() => new Response("{}"));
  const allowlistOutcome = await createTransport(allowlist.fetch)(
    transportRequest({ allowedOrigins: ["HTTPS://ApiKeys.GoogleApis.Com."] }),
  );
  assert.equal(allowlist.calls.length, 1);
  assert.ok(!("reason" in allowlistOutcome));
});

test("accepts each listed origin and refuses a lookalike host", async () => {
  const allowedOrigins = [
    "https://apikeys.googleapis.com",
    "https://cloudquotas.googleapis.com",
    "https://monitoring.googleapis.com",
  ];
  for (const origin of allowedOrigins) {
    const { fetch, calls } = recordingFetch(() => new Response("{}"));
    const outcome = await createTransport(fetch)(
      transportRequest({ url: `${origin}/v1/probe`, allowedOrigins }),
    );
    assert.equal(calls.length, 1, origin);
    assert.ok(!("reason" in outcome), origin);
  }

  for (const url of [
    "https://storage.googleapis.com/v1/probe",
    "https://monitoring.googleapis.com.evil.example/v1/probe",
  ]) {
    const { fetch, calls } = recordingFetch(() => new Response("{}"));
    const outcome = await createTransport(fetch)(transportRequest({ url, allowedOrigins }));
    assert.deepEqual(outcome, { reason: "internal" }, url);
    assert.equal(calls.length, 0, url);
  }
});

test("refuses an allowlist entry that is not an https origin", async () => {
  const { fetch, calls } = recordingFetch(() => new Response("{}"));
  const outcome = await createTransport(fetch)(
    transportRequest({ allowedOrigins: ["http://apikeys.googleapis.com"] }),
  );
  assert.deepEqual(outcome, { reason: "internal" });
  assert.equal(calls.length, 0);
});

test("refuses an invalid body cap with internal before connecting", async () => {
  const { fetch, calls } = recordingFetch(() => new Response("{}"));
  const transport = createTransport(fetch);

  assert.deepEqual(await transport(transportRequest({ bodyCap: -1 })), { reason: "internal" });
  assert.deepEqual(await transport(transportRequest({ bodyCap: Number.NaN })), {
    reason: "internal",
  });
  assert.deepEqual(await transport(transportRequest({ bodyCap: Number.POSITIVE_INFINITY })), {
    reason: "internal",
  });
  assert.equal(calls.length, 0);
});

test("fails with deadline before connecting when the caller's signal is already aborted", async () => {
  const { fetch, calls } = recordingFetch(() => new Response("{}"));
  const controller = new AbortController();
  controller.abort();
  const outcome = await createTransport(fetch)(transportRequest({ signal: controller.signal }));
  assert.deepEqual(outcome, { reason: "deadline" });
  assert.equal(calls.length, 0);
});

test("sends GET, the adapter headers, accept and user-agent, with redirects unfollowed", async () => {
  const { fetch, calls } = recordingFetch(() => new Response("{}", { status: 200 }));
  await createTransport(fetch)(
    transportRequest({ headers: { authorization: "Bearer x", accept: "text/html" } }),
  );

  const call = calls[0];
  assert.ok(call);
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.redirect, "manual");
  assert.ok(call.init.signal instanceof AbortSignal);

  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("authorization"), "Bearer x");
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("user-agent"), "pi-dent-purse");
  assert.deepEqual([...headers.keys()].toSorted(), ["accept", "authorization", "user-agent"]);
});

test("keeps a request's own user-agent header in any letter case while replacing accept", async () => {
  const { fetch, calls } = recordingFetch(() => new Response("{}", { status: 200 }));
  await createTransport(fetch)(
    transportRequest({ headers: { "User-Agent": "custom-client/1.0", Accept: "text/plain" } }),
  );

  const call = calls[0];
  assert.ok(call);
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("user-agent"), "custom-client/1.0");
});

test("sends a POST with its verbatim body, and refuses a body without POST and a POST without one", async () => {
  const { fetch, calls } = recordingFetch(() => new Response("{}", { status: 200 }));
  const posted = await createTransport(fetch)(
    transportRequest({ method: "POST", body: '{"metadata":{}}' }),
  );
  if (!("status" in posted)) assert.fail("expected success");
  assert.equal(posted.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.init.body, '{"metadata":{}}');

  const bodyWithoutPost = await createTransport(fetch)(transportRequest({ body: "{}" }));
  assert.deepEqual(bodyWithoutPost, { reason: "internal" });

  const postWithoutBody = await createTransport(fetch)(transportRequest({ method: "POST" }));
  assert.deepEqual(postWithoutBody, { reason: "internal" });
  assert.equal(calls.length, 1);
});

test("fails with internal on a header name the platform rejects, without rejecting", async () => {
  const { fetch, calls } = recordingFetch(() => new Response("{}"));
  const outcome = await createTransport(fetch)(
    transportRequest({ headers: { "bad header": "x" } }),
  );
  assert.deepEqual(outcome, { reason: "internal" });
  assert.equal(calls.length, 0);
});

test("a 2xx body succeeds with its status, lowercase headers, and text", async () => {
  const { fetch } = recordingFetch(
    () =>
      new Response('{"a":1}', {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Trace": "abc" },
      }),
  );
  const outcome = await createTransport(fetch)(transportRequest());
  assert.deepEqual(outcome, {
    status: 200,
    headers: { "content-type": "application/json", "x-trace": "abc" },
    body: '{"a":1}',
  });
});

test("a bodyless 204 succeeds with an empty body", async () => {
  const { fetch } = recordingFetch(() => new Response(null, { status: 204 }));
  const outcome = await createTransport(fetch)(transportRequest());
  assert.deepEqual(outcome, { status: 204, headers: {}, body: "" });
});

test("a 3xx fails with redirect and its status, unfollowed", async () => {
  for (const status of [301, 302, 304, 307]) {
    const { fetch, calls } = recordingFetch(
      () => new Response(null, { status, headers: { location: "https://evil.example/" } }),
    );
    const outcome = await createTransport(fetch)(transportRequest());
    assert.deepEqual(outcome, { reason: "redirect", status });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init.redirect, "manual");
  }
});

test("maps statuses to reason codes and carries the status", async () => {
  const cases: ReadonlyArray<{ status: number; reason: string }> = [
    { status: 401, reason: "http-401" },
    { status: 403, reason: "http-403" },
    { status: 404, reason: "http-error" },
    { status: 418, reason: "http-error" },
    { status: 500, reason: "http-error" },
  ];
  for (const { status, reason } of cases) {
    const { fetch } = recordingFetch(() => new Response("error text", { status }));
    const outcome = await createTransport(fetch)(transportRequest());
    assert.deepEqual(outcome, { reason, status });
  }
});

test("a 401 with retry-after carries no retryAfter", async () => {
  const { fetch } = recordingFetch(
    () => new Response("error", { status: 401, headers: { "retry-after": "10" } }),
  );
  assert.deepEqual(await createTransport(fetch)(transportRequest()), {
    reason: "http-401",
    status: 401,
  });
});

test("a 429 carries retryAfter only when retry-after is a non-negative integer", async () => {
  const cases: ReadonlyArray<{ header: string | null; retryAfter?: number }> = [
    { header: "120", retryAfter: 120 },
    { header: "0", retryAfter: 0 },
    { header: "1.5" },
    { header: "-5" },
    { header: "later" },
    { header: "Wed, 21 Oct 2015 07:28:00 GMT" },
    { header: "999999999999999999999" },
    { header: null },
  ];
  for (const { header, retryAfter } of cases) {
    const { fetch } = recordingFetch(() =>
      header === null
        ? new Response("error", { status: 429 })
        : new Response("error", { status: 429, headers: { "retry-after": header } }),
    );
    const outcome = await createTransport(fetch)(transportRequest());
    const expected =
      retryAfter === undefined
        ? { reason: "http-429", status: 429 }
        : { reason: "http-429", status: 429, retryAfter };
    assert.deepEqual(outcome, expected, `retry-after: ${String(header)}`);
  }
});

test("a fetch that throws fails with network and leaks nothing", async () => {
  const fetch: FetchFunction = () => {
    throw new Error("connect ECONNREFUSED");
  };
  const outcome = await createTransport(fetch)(transportRequest());
  assert.deepEqual(outcome, { reason: "network" });
});

test("a 2xx body exactly at the default cap succeeds", async () => {
  const { fetch } = recordingFetch(() => new Response(text(DEFAULT_BODY_CAP)));
  const outcome = await createTransport(fetch)(transportRequest());
  assert.ok(!("reason" in outcome));
  assert.equal(outcome.body.length, DEFAULT_BODY_CAP);
});

test("a 2xx body over the default cap fails with response-too-large and keeps its status", async () => {
  const { fetch } = recordingFetch(() => new Response(text(DEFAULT_BODY_CAP + 1)));
  assert.deepEqual(await createTransport(fetch)(transportRequest()), {
    reason: "response-too-large",
    status: 200,
  });
});

test("a request body cap replaces the default for 2xx bodies, and the boundary holds", async () => {
  const atCap = recordingFetch(() => new Response(text(8)));
  const atCapOutcome = await createTransport(atCap.fetch)(transportRequest({ bodyCap: 8 }));
  assert.ok(!("reason" in atCapOutcome));
  assert.equal(atCapOutcome.body, text(8));

  const overCap = recordingFetch(() => new Response(text(9)));
  assert.deepEqual(await createTransport(overCap.fetch)(transportRequest({ bodyCap: 8 })), {
    reason: "response-too-large",
    status: 200,
  });
});

test("a zero body cap admits an empty body and refuses a non-empty one", async () => {
  const empty = recordingFetch(() => new Response(null, { status: 200 }));
  assert.deepEqual(await createTransport(empty.fetch)(transportRequest({ bodyCap: 0 })), {
    status: 200,
    headers: {},
    body: "",
  });

  const nonEmpty = recordingFetch(() => new Response("a"));
  assert.deepEqual(await createTransport(nonEmpty.fetch)(transportRequest({ bodyCap: 0 })), {
    reason: "response-too-large",
    status: 200,
  });
});

test("a request body cap above the default admits a larger body", async () => {
  const { fetch } = recordingFetch(() => new Response(text(DEFAULT_BODY_CAP + 1)));
  const outcome = await createTransport(fetch)(transportRequest({ bodyCap: 1024 * 1024 }));
  assert.ok(!("reason" in outcome));
  assert.equal(outcome.body.length, DEFAULT_BODY_CAP + 1);
});

test("counts body bytes rather than characters against the cap", async () => {
  const atCap = recordingFetch(() => new Response("\u00e9".repeat(2048)));
  const atCapOutcome = await createTransport(atCap.fetch)(transportRequest({ bodyCap: 4096 }));
  assert.ok(!("reason" in atCapOutcome));
  assert.equal(atCapOutcome.body, "\u00e9".repeat(2048));

  const overCap = recordingFetch(() => new Response("\u00e9".repeat(2049)));
  assert.deepEqual(await createTransport(overCap.fetch)(transportRequest({ bodyCap: 4096 })), {
    reason: "response-too-large",
    status: 200,
  });
});

test("enforces the cap while streaming, before the body ends", async () => {
  const { fetch } = recordingFetch(() => new Response(openStream([new Uint8Array(5)])));
  const outcome = await createTransport(fetch)(transportRequest({ bodyCap: 4 }));
  assert.deepEqual(outcome, { reason: "response-too-large", status: 200 });
});

test("never reads a non-2xx body, whatever its size", async () => {
  const large = recordingFetch(() => new Response(text(1024 * 1024), { status: 500 }));
  assert.deepEqual(await createTransport(large.fetch)(transportRequest()), {
    reason: "http-error",
    status: 500,
  });

  const open = recordingFetch(
    () => new Response(openStream([new Uint8Array(8192)]), { status: 502 }),
  );
  assert.deepEqual(await createTransport(open.fetch)(transportRequest()), {
    reason: "http-error",
    status: 502,
  });
});

test("a 429 with a large body keeps its retryAfter", async () => {
  const { fetch } = recordingFetch(
    () => new Response(text(100_000), { status: 429, headers: { "retry-after": "120" } }),
  );
  assert.deepEqual(await createTransport(fetch)(transportRequest()), {
    reason: "http-429",
    status: 429,
    retryAfter: 120,
  });
});

test("refuses a URL carrying userinfo before connecting", async () => {
  for (const url of [
    "https://user:pass@apikeys.googleapis.com/v2/keys",
    "https://user@apikeys.googleapis.com/v2/keys",
    "https://:pass@apikeys.googleapis.com/v2/keys",
  ]) {
    const { fetch, calls } = recordingFetch(() => new Response("{}"));
    assert.deepEqual(await createTransport(fetch)(transportRequest({ url })), {
      reason: "internal",
    });
    assert.equal(calls.length, 0, url);
  }
});

test("a small request body cap does not shrink the error cap", async () => {
  const { fetch } = recordingFetch(() => new Response(text(100), { status: 503 }));
  assert.deepEqual(await createTransport(fetch)(transportRequest({ bodyCap: 2 })), {
    reason: "http-error",
    status: 503,
  });
});

test(
  "its own deadline fails with timeout while the response is awaited",
  { timeout: 5000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = createTransport(fetchThatNeverSettles())(transportRequest());
    t.mock.timers.tick(REQUEST_DEADLINE_MS);
    assert.deepEqual(await pending, { reason: "timeout" });
  },
);

test("its own deadline fails with timeout during the body read", { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetch: FetchFunction = async () => new Response(hangingStream(), { status: 200 });
  const pending = createTransport(fetch)(transportRequest());
  t.mock.timers.tick(REQUEST_DEADLINE_MS);
  assert.deepEqual(await pending, { reason: "timeout" });
});

test("an error body that never ends does not hold the request", { timeout: 5000 }, async () => {
  const fetch: FetchFunction = async () => new Response(hangingStream(), { status: 500 });
  assert.deepEqual(await createTransport(fetch)(transportRequest()), {
    reason: "http-error",
    status: 500,
  });
});

test("a caller abort while the response is awaited fails with deadline", async () => {
  const controller = new AbortController();
  const pending = createTransport(fetchThatNeverSettles())(
    transportRequest({ signal: controller.signal }),
  );
  controller.abort();
  assert.deepEqual(await pending, { reason: "deadline" });
});

test("a caller abort during the body read fails with deadline", async () => {
  const controller = new AbortController();
  const fetch: FetchFunction = async () => new Response(hangingStream(), { status: 200 });
  const pending = createTransport(fetch)(transportRequest({ signal: controller.signal }));
  controller.abort();
  assert.deepEqual(await pending, { reason: "deadline" });
});

test("clears its deadline timer and abort listener after a success", async () => {
  const controller = new AbortController();
  const { fetch } = recordingFetch(() => new Response("{}"));
  const outcome = await createTransport(fetch)(transportRequest({ signal: controller.signal }));
  assert.ok(!("reason" in outcome));
  // A later caller abort must not reach the settled outcome.
  controller.abort();
  assert.ok(!("reason" in outcome));
});

function commandRequest(overrides: Partial<CommandRequest> = {}): CommandRequest {
  return Object.assign(
    {
      command: "gcloud",
      args: ["auth", "print-access-token", "--quiet", "--verbosity=error"],
      deadlineMs: 10_000,
      outputCap: 8192,
      signal: new AbortController().signal,
    },
    overrides,
  );
}

interface ExecCall {
  command: string;
  args: readonly string[];
  options: ExecOptions | undefined;
}

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return Object.assign(
    { stdout: "", stderr: "", code: 0, killed: false, truncated: false },
    overrides,
  );
}

function recordingExec(handler: (call: ExecCall) => ExecResult | Promise<ExecResult>): {
  exec: ExecFunction;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec: ExecFunction = async (command, args, options) => {
    const call: ExecCall = { command, args, options };
    calls.push(call);
    return handler(call);
  };
  return { exec, calls };
}

test("runs the command through exec in the home directory with its deadline and output cap", async () => {
  const request = commandRequest();
  const { exec, calls } = recordingExec(() =>
    execResult({ stdout: "stdout text", stderr: "stderr text" }),
  );
  const outcome = await createCommandRunner(exec)(request);

  assert.deepEqual(outcome, { code: 0, stdout: "stdout text", stderr: "stderr text" });
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.command, "gcloud");
  assert.deepEqual(call.args, ["auth", "print-access-token", "--quiet", "--verbosity=error"]);
  const options = call.options;
  assert.ok(options);
  assert.equal(options.signal, request.signal);
  assert.equal(options.timeout, 10_000);
  assert.equal(options.cwd, homedir());
  assert.equal(options.maxBuffer, 8192);
});

test("passes a mutable copy of the argument vector", async () => {
  const request = commandRequest();
  const { exec, calls } = recordingExec(() => execResult());
  await createCommandRunner(exec)(request);
  const call = calls[0];
  assert.ok(call);
  assert.notEqual(call.args, request.args);
  assert.deepEqual(call.args, request.args);
});

test("a command that exits non-zero is still a command success", async () => {
  const { exec } = recordingExec(() =>
    execResult({ code: 1, stderr: "executable not found: gcloud" }),
  );
  assert.deepEqual(await createCommandRunner(exec)(commandRequest()), {
    code: 1,
    stdout: "",
    stderr: "executable not found: gcloud",
  });
});

test("truncated output fails with response-too-large and carries nothing but the reason", async () => {
  const { exec } = recordingExec(() =>
    execResult({ stdout: "long output", code: 0, killed: true, truncated: true }),
  );
  assert.deepEqual(await createCommandRunner(exec)(commandRequest()), {
    reason: "response-too-large",
  });
});

test("a command killed by its deadline fails with timeout", async () => {
  const { exec } = recordingExec(() => execResult({ code: 1, killed: true }));
  assert.deepEqual(await createCommandRunner(exec)(commandRequest()), { reason: "timeout" });
});

test("a command killed after the caller's abort fails with deadline", async () => {
  const controller = new AbortController();
  const { exec } = recordingExec(() => {
    controller.abort();
    return execResult({ code: 1, killed: true });
  });
  assert.deepEqual(await createCommandRunner(exec)(commandRequest({ signal: controller.signal })), {
    reason: "deadline",
  });
});

test("fails with deadline without running anything when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const { exec, calls } = recordingExec(() => execResult());
  assert.deepEqual(await createCommandRunner(exec)(commandRequest({ signal: controller.signal })), {
    reason: "deadline",
  });
  assert.equal(calls.length, 0);
});

test("an exec that throws fails with internal instead of rejecting", async () => {
  const { exec } = recordingExec(() => {
    throw new Error("spawn failed");
  });
  assert.deepEqual(await createCommandRunner(exec)(commandRequest()), { reason: "internal" });
});

test("an exec that throws after the caller's abort fails with deadline", async () => {
  const controller = new AbortController();
  const exec: ExecFunction = () =>
    new Promise<ExecResult>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  const pending = createCommandRunner(exec)(commandRequest({ signal: controller.signal }));
  controller.abort();
  assert.deepEqual(await pending, { reason: "deadline" });
});
