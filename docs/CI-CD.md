# CI/CD Pipeline

All automation lives in `.github/workflows/`. Workflows are scoped to the
`master` branch and pull requests targeting it.

## `ci.yml` — Verify

Runs on every push to `master` and every PR over an OS × Node matrix —
`ubuntu-latest`, `macos-latest`, and `windows-latest` — so the cross-platform
daemon lifecycle (`drydock start`/`stop`/`status`/`restart`, issue #216) is
exercised on every target OS. Installs with a frozen lockfile, then: ubuntu
(Node 22 & 24) and macOS (Node 24) run the full test suite; Windows (Node 24)
runs the daemon lifecycle subset (`pnpm test:daemon`), since the rest of the
legacy suite has Unix-only tests — real `false`/`printenv` spawns and POSIX
signal timing — that predate and are unrelated to this work. The OS-independent
lint, typecheck, build, and standalone smoke test run on ubuntu only.
Superseded runs on the same ref are cancelled (`concurrency` with
`cancel-in-progress: true`).

A separate **coverage** step (`pnpm test:coverage`, issue #389) runs on a single
leg (ubuntu, Node 24) so the full suite is not re-instrumented across the whole
matrix. It uses the `v8` provider scoped to `src/lib/**` (config in
`vitest.config.ts`), prints a per-file summary to the job log, and uploads
`coverage/lcov.info` as the `coverage-lcov` artifact. It is **non-blocking**
(`continue-on-error: true`) for now — a baseline signal, not a merge gate. Once a
baseline is captured, modest per-directory thresholds for `src/lib/orchestrator`
and `src/lib/github` (see the commented block in `vitest.config.ts`) flip it
blocking. Plain `pnpm test` stays uninstrumented and fast.

The smoke step (`pnpm smoke` → `scripts/smoke-standalone.mjs`) boots the built
`.next/standalone/server.js` and requires it to serve the homepage. A clean
`next build` can still emit a bundle that crashes on boot when the file tracer
drops a runtime module it cannot follow — typecheck and the unit suite never
exercise a real boot, so this is the only check that catches it (issue #209).

## `codeql.yml` — Security analysis

CodeQL static analysis on push, PR, and a weekly schedule. Skipped on private
repositories (CodeQL needs GitHub Advanced Security there); runs unconditionally
once the repo is public.

## `release-please.yml` — Releases

Turns Conventional Commits into release PRs. Releases stay **deliberate**: you
trigger this workflow manually (Actions tab or
`gh workflow run release-please.yml`) and [release-please][rp] opens/updates a
single "release" PR that bumps the version in `package.json` and updates
`CHANGELOG.md`. No release PR appears just because a feature merged.

Merging that release PR pushes the version bump and `CHANGELOG.md` to `master`,
and the workflow also runs on that push — scoped with a `paths` filter to
`CHANGELOG.md` and `.release-please-manifest.json`, the only two files a release
PR touches, so ordinary feature merges never trigger it. That run creates the
matching git tag and GitHub release **and** dispatches `npm-publish.yml` (see
below) with the new tag to publish to npm. So the changelog entry, tag, GitHub
release, and npm publish all happen from that one merge — no second manual
dispatch.

Configuration:

- `release-please-config.json` — single Node package at the repo root
  (`@nilsr0711/drydock`), releases tagged without a component prefix (`vX.Y.Z`).
  Pre-1.0 bumps stay in the minor range (`bump-minor-pre-major`).
- `.release-please-manifest.json` — tracks the last released version.

Because we already commit conventionally (`feat:`, `fix:`, `chore:` …), no extra
discipline is needed. Commits that should appear in the changelog use `feat:` or
`fix:`; everything else is grouped under "Miscellaneous".

When release-please reports that a release was created (`release_created`), it
**dispatches** the **`npm-publish.yml`** workflow (via `gh workflow run`, a
`workflow_dispatch` that is exempt from the `GITHUB_TOKEN` recursion guard) with
the new tag to publish it — see below. It dispatches rather than calls that
workflow so npm validates the workflow that actually runs the publish; only
`npm-publish.yml` is registered as a trusted publisher.

## `npm-publish.yml` — npm publish

The single source of truth for publishing `@nilsr0711/drydock`, and the only
workflow registered as an npm trusted publisher for the package. Triggered by
`workflow_dispatch`: the first release and ad-hoc/recovery publishes run it by
hand (publishing the version on the chosen `ref`), and `release-please.yml`
dispatches it with the freshly cut tag after it cuts a release. It upgrades npm
to `>= 11.5.1` and runs `npm publish --access public`; `npm publish` first runs
the `prepublishOnly` gate (`pnpm test && pnpm build && pnpm smoke`), so a build
that fails to boot the standalone server never ships (issue #209).
Authentication is tokenless via **npm trusted publishing** (OIDC,
`id-token: write`) — no `NPM_TOKEN` secret — and provenance is attached
automatically. npm validates the workflow that runs the publish, so this is
deliberately not a reusable (`workflow_call`) workflow: it must be the workflow
that actually runs, not one called by another. See
[ADR 026](adr/026-npm-package-and-cli-launcher.md).

## `doc-review.yml` — Documentation reminder

On PRs, compares the changed files against the base. If files under `src/`
changed but nothing under `docs/` did, it posts a single reminder comment to
update the docs. The comment is **idempotent**: it is keyed by a hidden marker,
so re-runs update the existing comment instead of posting a new one. If a later
push adds docs, the reminder is replaced with a confirmation. This is a nudge,
not a merge blocker.

[rp]: https://github.com/googleapis/release-please-action
