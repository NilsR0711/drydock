# ADR 041: DNS-rebinding guard on the API surface via `proxy.ts`

- **Status:** accepted
- **Date:** 2026-07-03

## Context

Drydock binds `127.0.0.1` by default and treats that bind as the only access
control for its read-only GET routes (`/api/sse/dashboard`,
`/api/sse/jobs/[id]`, `/api/cost/export`, `/api/health`). Loopback binding
stops non-loopback *connections*, but it does nothing against DNS rebinding: a
web page the operator has open can rebind an attacker-controlled hostname to
`127.0.0.1` mid-session and issue same-origin `fetch()`/`EventSource` requests
from its own script. The browser sends these happily and CORS never blocks
them (same-origin from the page's perspective). Neither `next dev` nor `next
start` validates the `Host` header, so the rebound requests are served, and the
existing `assertSafeHost` gate in `bin/drydock.mjs` only guards the *bind*
address — it does nothing once the process is already listening (issue #382).

The mutating routes already authenticate themselves per-endpoint (webhook HMAC
signature, `DRYDOCK_CONTROL_TOKEN` constant-time compare, a CSRF-guard header
that forces a blocked CORS preflight), so this gap is specific to GET. Any fix
needs to cover not just the four routes named in the issue but *future* GET
routes too, without relying on every new route remembering to opt in.

## Decision

Add a **Host/Origin allowlist**, enforced by a single `src/proxy.ts` (the
Next.js 16 file convention that replaced `middleware.ts` — see [Next's
migration notice](https://nextjs.org/docs/messages/middleware-to-proxy);
`middleware.ts` still works but prints a deprecation warning on Next 16.2.9,
so this project uses the new name directly rather than starting on a
soon-obsolete convention).

- **Matcher: `/api/:path*`.** Every request under `/api` runs through the
  guard by construction — a new route handler added tomorrow is covered
  without touching this file, satisfying the issue's "not by per-route
  opt-in" requirement.
- **Method-scoped: only `GET`/`HEAD` are checked.** Every mutating route
  already has its own auth (see above), and one of them — the webhook
  receiver (`POST /api/webhooks/[repoId]`) — is deliberately called from
  outside the operator's browser (the forge's servers), so a same-origin
  check there would break legitimate deliveries. Gating only the
  unauthenticated methods keeps the guard purely additive.
- **Policy lives in `src/lib/security/host-guard.ts`**, a pure module
  (`authorizeHost`) mirroring the style of
  `src/lib/orchestrator/control.ts`: no I/O, so every branch — valid
  loopback, spoofed `Host`, cross-origin `Origin`, missing `Origin`,
  malformed `Origin`, the `DRYDOCK_ALLOW_REMOTE` allowlist — is
  unit-tested directly. `authorizeHostRequest` is a thin `Request` wrapper
  the proxy calls.
- **Allowlist:** the loopback literals (`127.0.0.1`, `localhost`, `::1`,
  `[::1]`, case-insensitive, port ignored — DNS rebinding can't change what
  port the browser connects to) plus, when set, `process.env.HOSTNAME`. That
  env var is only ever non-loopback once `assertSafeHost` in
  `bin/drydock.mjs` already required `DRYDOCK_ALLOW_REMOTE=1` and the
  operator passed `--host`, which the launcher threads straight into
  `HOSTNAME` for the standalone server process — so trusting it here doesn't
  introduce a new authority, it reuses an existing one.
- **`Origin`, when present, is checked independently of `Host`** against the
  same allowlist; when absent (ordinary navigations and many same-origin
  `fetch()` calls omit it) only the `Host` check applies. A cross-origin
  `Origin` is rejected even with a valid `Host`, closing the case where an
  attacker's rebound page still manages to conjure a matching `Host` header.
- **Response:** `403` with a short explanatory body and `Cache-Control:
  no-store` on rejection; otherwise `NextResponse.next()`.

## Consequences

- The dashboard, SSE streams, and cost export continue to work unchanged over
  `http://127.0.0.1:PORT` and `http://localhost:PORT`; `DRYDOCK_ALLOW_REMOTE`
  deployments keep working because the configured host is allowlisted.
- Any future route added under `/api` with a GET/HEAD handler is
  automatically covered — there is no convention to remember or lint for.
- The webhook receiver and the token/CSRF-guarded control endpoints are
  unaffected (all POST); page routes (`/`, `/jobs`, …) are intentionally out
  of scope here, matching the issue's own scoping — Next's Server Action CSRF
  check covers those mutations, and their GETs carry no secret data beyond
  what this same rebinding class already reaches through the gated JSON APIs.
- This is the project's first `proxy.ts`/middleware-class file. It's pure
  routing logic with no shared module state, matching Next's guidance to keep
  Proxy side-effect-free.
