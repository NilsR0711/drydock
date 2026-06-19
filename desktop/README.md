# Drydock Desktop (menu-bar shell)

A native **macOS** menu-bar shell that wraps the local Drydock dashboard so the
dock is glanceable and controllable without keeping a browser tab open
([#292](https://github.com/NilsR0711/drydock/issues/292)).

It is a thin [Tauri 2](https://tauri.app) app:

- A window pointing at the running dashboard (`http://127.0.0.1:3737` by default).
- A **tray icon** whose title shows live counts — active / queued, with a `⚠`
  badge for `needs_human` — and `⏸`/`⤓` glyphs for paused / draining.
- Tray toggles for **global pause/resume** and **drain mode**.
- "Show Dashboard" (focus the window) and "Open in Browser".

The shell talks to the server entirely over HTTP from Rust — it reads
`GET /api/health` for counts and state, and posts to `POST /api/control/pause`
and `POST /api/control/drain` to flip the toggles. The wrapped dashboard page is
the ordinary, untouched Next.js app; no Tauri APIs are injected into it.

It stays **single-user / local-only**: nothing changes the dashboard's
loopback-only binding model.

## Prerequisites

- A running Drydock server (`drydock` or `pnpm dev`) on the configured URL.
- [Rust](https://rustup.rs) (stable) and Xcode Command Line Tools for the native
  build. The web app needs neither — this is desktop-only.

## Develop & build

From the repo root:

```bash
pnpm desktop:install   # one-time: install the Tauri CLI in desktop/
pnpm tauri:dev         # run the shell against the running dashboard
pnpm tauri:build       # produce a .app / .dmg under desktop/src-tauri/target
```

(Equivalently, run `npm run dev` / `npm run build` inside `desktop/`.)

## Configuration

All optional; sensible defaults target a local foreground server.

| Env var                        | Default                 | Purpose                                                   |
| ------------------------------ | ----------------------- | -------------------------------------------------------- |
| `DRYDOCK_DESKTOP_URL`          | `http://127.0.0.1:3737` | Dashboard origin to wrap and poll. Loopback-only (`127.0.0.1` / `localhost` / `::1`); a non-loopback value falls back to the default. |
| `DRYDOCK_DESKTOP_POLL_SECONDS` | `4`                     | Tray refresh interval.                                   |
| `DRYDOCK_CONTROL_TOKEN`        | _(unset)_               | Only needed when the server was started with one (daemon/headless lockdown). |

The pause/drain endpoints require a custom request header that the shell always
sends; a browser cannot forge it (it forces a CORS preflight that the server
never satisfies). When `DRYDOCK_CONTROL_TOKEN` is set, the shell additionally
sends the matching token. See ADR 036.

## Layout

```
desktop/
  package.json          Tauri CLI + dev/build/icon scripts
  dist/index.html       fallback splash (the window normally loads the live URL)
  src-tauri/
    Cargo.toml          Rust crate (tauri, reqwest, serde, tokio)
    tauri.conf.json      window + bundle config
    capabilities/        webview permissions
    icons/               app icons (regenerate: pnpm --prefix desktop run icon)
    src/
      main.rs            binary entry
      lib.rs             builder + setup (tray + poll loop)
      config.rs          env-resolved runtime config (unit-tested)
      health.rs          /api/health parsing + tray formatting (unit-tested)
      tray.rs            menu, tray, toggle POSTs, poll loop
```

## Why Rust isn't in the repo's CI

CI builds and verifies the **web app** only; the Rust toolchain is not installed
there. The desktop crate is verified locally with `cargo check` and
`cargo test --lib` (the pure `config`/`health` logic is unit-tested). Wiring a
Rust build into CI and Windows/Linux packaging are deliberate follow-ups
(see [#292](https://github.com/NilsR0711/drydock/issues/292) "Out of scope").
