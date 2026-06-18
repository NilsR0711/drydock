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
