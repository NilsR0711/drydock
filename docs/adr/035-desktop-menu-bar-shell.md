# ADR 035: Native desktop menu-bar shell (Tauri)

- **Status:** accepted
- **Date:** 2026-06-19

## Context

Drydock is web-only: the dashboard is a Next.js app bound to `127.0.0.1:3737`.
To keep an eye on the dock you must keep a browser tab open. Issue #292 asks for
a **native macOS menu-bar shell** that wraps the existing dashboard and adds a
tray presence with live counts (active / queued / needs-human) and quick toggles
for global **pause/resume** and **drain mode** — glanceable and controllable
without a browser tab, while staying **single-user / local-only** (no change to
the loopback-only binding).

Two forces shaped the design:

1. **The tray needs HTTP.** Live counts already stream over `GET /api/sse/dashboard`
   and are summarized by `GET /api/health` (job counts per state + `paused` /
   `draining`). But pause/resume and drain were reachable **only** as Next.js
   Server Actions — there was no HTTP surface a native shell could call to flip
   them.
2. **A native shell means a second toolchain.** Tauri is Rust + a system webview.
   The repo ships as an npm package (`@nilsr0711/drydock`) and its CI builds and
   verifies the **web app** only; neither has a Rust toolchain.

## Decision

### 1. A token-light HTTP control surface for mutations

Add two endpoints the tray (or any local client) can call:

- `POST /api/control/pause` — body `{ "paused": boolean }`
- `POST /api/control/drain` — body `{ "draining": boolean }`

The state transition is extracted into `src/lib/settings/control.ts`
(`setPaused` / `setDraining`), and the dashboard's `togglePauseAction` Server
Action now delegates to it, so the one-click navbar toggle and the HTTP endpoint
share one implementation — including the resume→paused edge notification
(ADR 024).

Authorization (`authorizeControl`, a pure function next to `authorizeShutdown`)
is deliberately **lighter than shutdown**. Pause/drain are reversible and were
already freely reachable through the unauthenticated dashboard on the same
loopback interface, so hiding them behind a mandatory token (as shutdown does,
because shutdown is destructive) would be inconsistent and would break the
shell out of the box. Instead:

- A **custom request header** (`x-drydock-control`) is **required**. It is a
  non-simple header, so a browser must send a CORS preflight first; with no CORS
  headers in the response the preflight fails. This blocks a malicious web page
  on the same machine from forging the POST (the standard CSRF defense), while
  `curl` and the shell set it explicitly.
- When `DRYDOCK_CONTROL_TOKEN` **is** configured (daemon / headless lockdown),
  the `x-drydock-control-token` header must additionally match via constant-time
  compare — defense in depth for shared/headless hosts.

Reads reuse the existing `GET /api/health` (counts + `paused`/`draining`); no new
read endpoint is introduced.

### 2. The shell is a separate Tauri crate, not part of the npm package

The Tauri app lives under `desktop/` (`desktop/src-tauri`, a Rust crate). It is
**not** added to the npm package's `files` allowlist, so the published web
package is unchanged and web-only. The shell is built and distributed separately
(`.app` / `.dmg`).

The shell talks to the server **entirely over HTTP from Rust** — it polls
`/api/health` and posts to the control endpoints — and points a window at the
live dashboard URL. The wrapped page stays the ordinary Next.js app; no Tauri
APIs are injected into it. Pure logic (env-config resolution, health parsing,
tray formatting) is unit-tested with `cargo test --lib`.

### 3. Rust stays out of the repo's CI (for now)

CI continues to build and verify the web app only. The Rust crate is verified
locally (`cargo check`, `cargo test --lib`) and is purely additive — it cannot
break the Node pipeline. Wiring a Rust build into CI and Windows/Linux packaging
are explicit follow-ups (issue #292 "Out of scope").

## Consequences

**Positive**

- A glanceable, controllable dock without a browser tab, on a clean HTTP contract.
- Pause/drain now have a reusable, tested service layer; the navbar toggle and
  the HTTP endpoint can never drift apart.
- The control endpoints are usable by any local tool (scripts, future clients),
  not just the desktop shell.
- The web package and its CI are untouched; the desktop concern is fully isolated.

**Negative / trade-offs**

- A second toolchain (Rust) for contributors who build the desktop app; mitigated
  by isolating it under `desktop/` with its own README and keeping it optional.
- The desktop crate is not yet covered by CI, so a dependency or API break there
  is caught locally rather than on every PR — acceptable while the shell is
  macOS-first and additive, and revisited when packaging is wired up.
- The control endpoints rely on a custom-header CSRF guard rather than a token by
  default. This matches the dashboard's existing loopback trust model (the UI is
  already unauthenticated on the same interface); a token can be layered on via
  `DRYDOCK_CONTROL_TOKEN` where stronger isolation is wanted.
