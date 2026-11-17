/**
 * Transport and command runner per specs/adapter-contract.md, Sections 4 and 5: the security
 * envelope every adapter request and command passes through.
 *
 * Both are factories over the one effect they perform — `createTransport` takes the `fetch` to
 * call, `createCommandRunner` takes the host's `pi.exec` — so tests reach no network and spawn
 * nothing. Neither rejects: a thrown fetch, an abort, a body over its cap, and invalid input all
 * resolve to a failure outcome with the reason code Section 4 or 5 assigns. A failure carries no
 * response text, header, or stderr; no credential is read or written here.
 *
 * The allowlist is bound when the transport is created (`createTransport(fetch, allowlist)`):
 * the refresh layer creates one per adapter from its `hostAllowlist`, so no adapter states its
 * own allowed origins.
 */

import { homedir } from "node:os";

import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

import {
  REQUEST_DEADLINE_MS,
  type CommandOutcome,
  type CommandRequest,
  type CommandRunner,
  type Transport,
  type TransportFailure,
  type TransportOutcome,
  type TransportRequest,
} from "./adapter.ts";
import type { ReasonCode } from "./state.ts";

/** The `fetch` the transport calls; `globalThis.fetch` satisfies it. */
export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;

/** The host's exec API (docs/development.md, Exec); `pi.exec` satisfies it. */
export type ExecFunction = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

/** Section 4: every request carries these two headers. */
const ACCEPT_HEADER = "application/json";
const USER_AGENT_HEADER = "pi-dent-purse";

function failure(reason: ReasonCode, status?: number, retryAfter?: number): TransportFailure {
  const outcome: TransportFailure = { reason };
  if (status !== undefined) outcome.status = status;
  if (retryAfter !== undefined) outcome.retryAfter = retryAfter;
  return outcome;
}

/**
 * The origin an `https:` URL identifies, normalized for comparison (adapter-contract.md
 * Sections 3–4): lowercased host without trailing dots, default port omitted. `null` for
 * anything that is not an `https:` URL, and for a URL carrying userinfo.
 */
export function originOf(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase().replace(/\.+$/u, "");
  if (host === "") return null;
  return `https://${host}${url.port === "" ? "" : `:${url.port}`}`;
}

/** The `retry-after` value as seconds when it is a non-negative integer, else `undefined` (Section 4). */
function retryAfterSeconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

/** Status-to-reason mapping (Section 4); a response arrived, so the failure carries `status`. */
function statusFailure(status: number, headers: Headers): TransportFailure {
  if (status === 401) return failure("http-401", status);
  if (status === 403) return failure("http-403", status);
  if (status === 429) {
    return failure("http-429", status, retryAfterSeconds(headers.get("retry-after")));
  }
  return failure("http-error", status);
}

const ABORTED: unique symbol = Symbol("aborted");

type BodyRead =
  | { kind: "text"; text: string }
  | { kind: "too-large" }
  | { kind: "aborted" }
  | { kind: "error" };

function decode(chunks: readonly Uint8Array[]): string {
  let size = 0;
  for (const chunk of chunks) size += chunk.byteLength;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Reads a body up to `cap` bytes while it streams (Section 4): the cap is enforced on the
 * chunks, never after buffering, and an abort interrupts a pending read. The text is returned
 * only on success; a failure keeps nothing.
 */
async function readBody(response: Response, cap: number, signal: AbortSignal): Promise<BodyRead> {
  const body = response.body;
  if (body === null) return { kind: "text", text: "" };

  const reader = body.getReader();
  let stopListening: (() => void) | undefined;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    if (signal.aborted) {
      resolve(ABORTED);
      return;
    }
    const onAbort = (): void => resolve(ABORTED);
    stopListening = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next === ABORTED) return { kind: "aborted" };
      if (next.done) return { kind: "text", text: decode(chunks) };
      total += next.value.byteLength;
      if (total > cap) return { kind: "too-large" };
      chunks.push(next.value);
    }
  } catch {
    return { kind: "error" };
  } finally {
    stopListening?.();
    reader.cancel().catch(() => {});
  }
}

/**
 * The transport (Section 4) bound to one adapter's host allowlist: one `GET`, the request
 * deadline, the body cap, and the status mapping; never a redirect, never a failure that
 * rejects.
 */
export function createTransport(
  fetchFunction: FetchFunction,
  allowedOrigins: readonly string[],
): Transport {
  const allowlist = new Set(
    allowedOrigins.map(originOf).filter((origin): origin is string => origin !== null),
  );
  return async (request: TransportRequest): Promise<TransportOutcome> => {
    // Section 4: the URL is checked before anything connects.
    const origin = originOf(request.url);
    if (origin === null || !allowlist.has(origin)) return failure("internal");

    const cap = request.bodyCap;
    if (!Number.isFinite(cap) || cap < 0) return failure("internal");
    if (request.signal.aborted) return failure("deadline");

    const controller = new AbortController();
    // Whichever deadline aborts first names the failure: the caller's refresh deadline
    // (`deadline`) or this request's own eight seconds (`timeout`).
    let cause: "timeout" | "deadline" | null = null;
    const onAbort = (): void => {
      if (cause === null) cause = "deadline";
      controller.abort();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      if (cause === null) cause = "timeout";
      controller.abort();
    }, REQUEST_DEADLINE_MS);

    try {
      let headers: Headers;
      try {
        headers = new Headers(request.headers);
        headers.set("accept", ACCEPT_HEADER);
        headers.set("user-agent", USER_AGENT_HEADER);
      } catch {
        return failure("internal");
      }

      let response: Response;
      try {
        response = await fetchFunction(request.url, {
          method: "GET",
          headers,
          // Never follow: a 3xx is the answer to report.
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        return failure(cause ?? "network");
      }

      const status = response.status;
      // A fetch may hand a manual redirect back opaque (status 0); either way it is unfollowed.
      if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) {
        return failure("redirect", status === 0 ? undefined : status);
      }

      // Section 4: a non-2xx body is never read; the status and headers decide.
      if (status < 200 || status >= 300) {
        response.body?.cancel().catch(() => {});
        return statusFailure(status, response.headers);
      }
      const body = await readBody(response, cap, controller.signal);
      if (body.kind === "aborted") return failure(cause ?? "deadline");
      if (body.kind === "too-large") return failure("response-too-large", status);
      if (body.kind === "error") return failure("network");
      return { status, headers: Object.fromEntries(response.headers), body: body.text };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * The command runner (Section 5): one command through the host exec API, without a shell, in the
 * user's home directory, with the adapter's deadline and output cap.
 */
export function createCommandRunner(execFunction: ExecFunction): CommandRunner {
  return async (request: CommandRequest): Promise<CommandOutcome> => {
    if (request.signal.aborted) return { reason: "deadline" };

    let result: ExecResult;
    try {
      result = await execFunction(request.command, [...request.args], {
        signal: request.signal,
        timeout: request.deadlineMs,
        cwd: homedir(),
        maxBuffer: request.outputCap,
      });
    } catch {
      return { reason: request.signal.aborted ? "deadline" : "internal" };
    }

    if (result.truncated) return { reason: "response-too-large" };
    if (result.killed) return { reason: request.signal.aborted ? "deadline" : "timeout" };
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  };
}
