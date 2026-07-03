/**
 * DNS-rebinding guard for the unauthenticated GET API surface (issue #382).
 *
 * Drydock binds `127.0.0.1` by default and treats that bind as its only
 * access control for read-only routes (dashboard SSE, cost export, health).
 * Loopback binding stops non-loopback *connections*, but it does nothing
 * against DNS rebinding: a page the operator has open in a browser tab can
 * rebind an attacker-controlled hostname to `127.0.0.1` mid-session and then
 * issue same-origin `fetch()`/`EventSource` requests from its own script,
 * which the browser happily sends and CORS never blocks (same-origin).
 * Neither `next dev` nor `next start` validates the `Host` header, so those
 * requests are served — the victim's browser is the client, not the network.
 *
 * The defense is a Host/Origin allowlist, applied in `middleware.ts` to
 * every `/api/*` GET/HEAD request so it covers new routes by construction
 * rather than relying on each handler to opt in. This module is pure so the
 * policy is exhaustively unit-testable; the caller owns reading the request.
 */

/** Outcome of a Host/Origin check: the HTTP status to return and whether to act. */
export interface HostGuardDecision {
  /** HTTP status the caller should respond with. */
  status: number;
  /** True only when both the Host and (if present) Origin are allowlisted. */
  authorized: boolean;
}

// Loopback hostnames a browser can put in a Host/Origin header when talking to
// this process directly — never attacker-registrable, so always allowed.
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Strip a trailing `:port` from a `Host`-style `host[:port]` value, unwrapping
 * a bracketed IPv6 literal (`[::1]:3737` → `[::1]`) rather than splitting on
 * its internal colons. Lowercased so comparisons are case-insensitive per the
 * hostname grammar (RFC 3986 §3.2.2).
 */
function hostnameOf(hostHeader: string): string {
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    return (close === -1 ? trimmed : trimmed.slice(0, close + 1)).toLowerCase();
  }
  const colon = trimmed.lastIndexOf(":");
  return (colon === -1 ? trimmed : trimmed.slice(0, colon)).toLowerCase();
}

/** Parse an `Origin` header's hostname, or null when it isn't a valid URL. */
function originHostname(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isAllowedHostname(hostname: string, allowedHost: string | undefined): boolean {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  return allowedHost !== undefined && hostname === allowedHost.toLowerCase();
}

/**
 * Decide whether an inbound request's `Host` (and, if present, `Origin`)
 * headers are trustworthy.
 *
 * - No `Host` header, or a `Host` outside the allowlist (loopback literals
 *   plus, when configured, the operator's `--host` under `DRYDOCK_ALLOW_REMOTE`)
 *   → reject.
 * - An `Origin` header, when present, must independently resolve to the same
 *   allowlist. Simple same-origin GETs and EventSource connects from a real
 *   browser tab either omit Origin or send one that matches; only a
 *   cross-origin request sends a mismatched one.
 * - Missing `Origin` is not itself suspicious (plain navigations and
 *   same-origin `fetch()` commonly omit it) — the `Host` check alone gates it.
 *
 * @param host The `Host` header value (or null).
 * @param origin The `Origin` header value (or null).
 * @param allowedHost The operator's configured bind host beyond the loopback
 *   literals (mirrors `HOSTNAME`, only ever non-loopback once `assertSafeHost`
 *   in `bin/drydock.mjs` has already required `DRYDOCK_ALLOW_REMOTE=1`).
 */
export function authorizeHost(params: {
  host: string | null;
  origin: string | null;
  allowedHost?: string;
}): HostGuardDecision {
  if (!params.host || !isAllowedHostname(hostnameOf(params.host), params.allowedHost)) {
    return { status: 403, authorized: false };
  }
  if (params.origin !== null) {
    const hostname = originHostname(params.origin);
    if (hostname === null || !isAllowedHostname(hostname, params.allowedHost)) {
      return { status: 403, authorized: false };
    }
  }
  return { status: 200, authorized: true };
}

/**
 * Convenience wrapper that authorizes straight from an inbound {@link Request}
 * (or `NextRequest`), pulling `Host`/`Origin` from its headers and the
 * allowlisted remote host from `HOSTNAME` — the same env var
 * `bin/drydock.mjs` sets to the operator's `--host` value for the standalone
 * server (see {@link authorizeHost}).
 */
export function authorizeHostRequest(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): HostGuardDecision {
  return authorizeHost({
    host: request.headers.get("host"),
    origin: request.headers.get("origin"),
    allowedHost: env.HOSTNAME,
  });
}
