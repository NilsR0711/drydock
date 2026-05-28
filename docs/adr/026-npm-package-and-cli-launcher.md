# ADR 026: Publish Drydock as an npm package with a terminal launcher

- **Status:** accepted
- **Date:** 2026-05-28

## Context

Drydock could only be run from a source checkout (`pnpm dev`/`pnpm start`). To
ship it as a finished tool it must be installable from npm and startable with a
single command that boots the local server and opens the dashboard, without a
repo checkout or manual setup. See issue #12.

The unscoped `drydock` name is already taken on npm, so the package is published
scoped as **`@nilsr0711/drydock`** (`npx @nilsr0711/drydock`); the launcher's bin
command stays `drydock` regardless, so the run/`update` UX is unchanged.

Three constraints shape the design:

1. **Native dependency.** `better-sqlite3` is a compiled addon; the distributed
   artifact must carry a working `.node` binary.
2. **Local-first.** The DB holds GitHub/GitLab tokens. It must live in the user's
   home directory, never inside the (potentially read-only, multi-user) install
   location, and never be published.
3. **No runtime toolchain.** The launcher must run from the published tarball
   with plain Node — no `tsx`/TypeScript, no build step.

## Decision

### 1. Standalone server bundle

Build with Next's `output: "standalone"`, which file-traces the minimal runtime
(including `better-sqlite3`'s native binary) into `.next/standalone`. We pin
`outputFileTracingRoot` to the project so the entrypoint lands at
`.next/standalone/server.js` instead of being nested under an inferred ancestor.

Next does not copy static assets into the standalone output, and its tracer
**over**-copies the project root because our DB/migration reads use dynamic
`process.cwd()` paths it cannot follow. `scripts/package-standalone.mjs` (run at
the end of `build`) therefore (a) copies `.next/static` and `public/` into the
bundle and (b) **prunes** dev-only and secret paths — most importantly the local
`data/` DB and `.git`. `outputFileTracingExcludes` handles the same set at trace
time; the prune is the hard guarantee. Verified with `npm pack --dry-run`.

### 2. Terminal launcher (`bin/drydock.mjs`)

A plain-ESM launcher (shebang `#!/usr/bin/env node`) is the package `bin`. It:

- parses `--port`/`-p`, `--host`/`-H`, `--open`, `--version`/`-v`, `--help`/`-h`
  with local-first defaults (`127.0.0.1:3737`);
- resolves the data directory (`~/.drydock`, override `DRYDOCK_DATA_DIR`), sets
  `DRYDOCK_DB` and `DRYDOCK_MIGRATIONS`, and `mkdir -p`s the data dir;
- spawns `node .next/standalone/server.js` with those env vars, forwarding
  `SIGINT`/`SIGTERM` and exit codes;
- with `--open`, polls the URL and opens the platform browser once ready.

The arg parser and path resolvers are exported and unit-tested; the file only
runs `main()` when executed directly, so importing it in tests has no side
effects. Migrations run automatically on first start via the existing
auto-migrating `getDb()`, so first run needs no setup command.

The MCP server keeps its development entrypoint (`pnpm mcp` →
`scripts/drydock.ts`, ADR 025). Packaging the MCP CLI into the published binary
is deferred: it would require bundling the service layer separately from the
Next build, which is out of scope for issue #12.

### 3. Packaging metadata & publish

`package.json` drops `private`, adds `description`/`keywords`/`license`/
`repository`/`homepage`/`bugs`, a lean `files` whitelist (build artifacts +
`bin` only — no sources or tests), `publishConfig.access: public` with
provenance, and a `prepublishOnly` gate (`pnpm test && pnpm build`).

Publishing is automated from the release workflow: when release-please cuts a
release, a `publish` job runs `npm publish` with npm **provenance** via OIDC
(`id-token: write`), so artifacts are cryptographically linked to the workflow
and no long-lived npm token is required once trusted publishing is configured.

## Consequences

- `npx @nilsr0711/drydock` runs the tool from a fresh directory; the DB is created and
  migrated under `~/.drydock` on first start; `--help`/`--version` work.
- The tarball ships build artifacts only — no sources, tests, `.git`, or the
  local token DB (enforced by the prune step).
- Native-module portability depends on `better-sqlite3` prebuilds for the user's
  Node ABI; `engines.node >= 20.9` documents the floor.
- Migration SQL must ship with the package (`files` includes `drizzle`) and is
  located at runtime via `DRYDOCK_MIGRATIONS`, decoupled from the cwd.
