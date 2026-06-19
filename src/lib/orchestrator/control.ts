import { timingSafeEqual } from "node:crypto";

/**
 * Authorization for the portable shutdown control endpoint (issue #216). The
 * daemon CLI (`drydock stop`) cannot rely on POSIX signals on Windows, so it
 * asks the running server to drain and exit over HTTP instead. This module is
 * pure so the token check is exhaustively unit-testable; the route owns the
 * actual process exit.
 */

/** Constant-time string compare that never short-circuits on length. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch; compare against a same-length
  // buffer so the early return doesn't leak the secret length via timing.
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Outcome of a shutdown request: the HTTP status to return and whether to act. */
export interface ShutdownDecision {
  /** HTTP status the route should respond with. */
  status: number;
  /** True only when the caller proved knowledge of the control token. */
  authorized: boolean;
}

/**
 * Decide whether an inbound shutdown request may stop the server.
 *
 * Fail-closed in three tiers:
 * - No token configured → the endpoint is disabled and indistinguishable from a
 *   missing route (404), so an ordinary `drydock`/dev run never exposes a way to
 *   kill the process.
 * - Wrong/absent token → 403 via constant-time compare (no length leak).
 * - Exact match → 202 Accepted; the route schedules the graceful drain.
 *
 * @param provided The `x-drydock-control-token` header value (or null).
 * @param expected The server's configured token (DRYDOCK_CONTROL_TOKEN).
 */
export function authorizeShutdown(
  provided: string | null,
  expected: string | undefined,
): ShutdownDecision {
  if (!expected) return { status: 404, authorized: false };
  if (!provided || !safeEqual(provided, expected)) return { status: 403, authorized: false };
  return { status: 202, authorized: true };
}

/** Outcome of a control-mutation request (pause/drain): status + whether to act. */
export interface ControlDecision {
  /** HTTP status the route should respond with. */
  status: number;
  /** True only when the caller cleared the CSRF guard (and token, if set). */
  authorized: boolean;
}

/**
 * Authorize a control mutation (global pause/resume, drain mode) for the desktop
 * tray (issue #292). Unlike {@link authorizeShutdown}, these toggles are
 * reversible and already freely reachable through the unauthenticated dashboard
 * on the same loopback interface, so they are not hidden behind a mandatory
 * token. The gate is two-tier:
 *
 * - A custom request header is REQUIRED. It is a non-simple header, so a browser
 *   must send a CORS preflight before the real request; with no CORS headers in
 *   the response the preflight fails, blocking same-machine web pages from
 *   forging these POSTs (the standard CSRF defense). curl and the Tauri shell
 *   set it explicitly and are unaffected.
 * - If DRYDOCK_CONTROL_TOKEN is configured (daemon/headless lockdown), the
 *   `x-drydock-control-token` header must additionally match via constant-time
 *   compare. When unset, the guard header alone authorizes the call.
 *
 * Pure so the policy is exhaustively unit-testable; the route owns the effect.
 */
export function authorizeControl(params: {
  /** Presence of the `x-drydock-control` guard header (value is ignored). */
  controlHeader: string | null;
  /** The `x-drydock-control-token` header value (or null). */
  token: string | null;
  /** The server's configured token (DRYDOCK_CONTROL_TOKEN), if any. */
  expectedToken: string | undefined;
}): ControlDecision {
  if (!params.controlHeader) return { status: 403, authorized: false };
  if (params.expectedToken) {
    if (!params.token || !safeEqual(params.token, params.expectedToken)) {
      return { status: 403, authorized: false };
    }
  }
  return { status: 200, authorized: true };
}

/**
 * Convenience wrapper that authorizes a control mutation straight from an
 * inbound {@link Request}, pulling the guard/token headers and the configured
 * token from the environment. Keeps the pause/drain route handlers DRY while
 * leaving the pure {@link authorizeControl} policy independently testable.
 */
export function authorizeControlRequest(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): ControlDecision {
  // Trim both sides symmetrically so a token carrying a trailing newline (a
  // common `$(cat tokenfile)` artifact) on the env, the header, or both still
  // matches — and an all-whitespace token reads as "no token configured".
  const token = request.headers.get("x-drydock-control-token")?.trim() ?? null;
  const expectedToken = env.DRYDOCK_CONTROL_TOKEN?.trim() || undefined;
  return authorizeControl({
    controlHeader: request.headers.get("x-drydock-control"),
    token,
    expectedToken,
  });
}
