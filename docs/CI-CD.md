# CI/CD Pipeline

All automation lives in `.github/workflows/`. Workflows are scoped to the
`master` branch and pull requests targeting it.

## `ci.yml` — Verify

Runs on every push to `master` and every PR. Installs with a frozen lockfile,
then runs the test suite across an OS × Node matrix — `ubuntu-latest`,
`macos-latest`, and `windows-latest` on Node 20/22 — so the cross-platform
daemon lifecycle (`drydock start`/`stop`/`status`/`restart`, issue #216) is
exercised on every target OS. The OS-independent lint, typecheck, build, and
standalone smoke test run on ubuntu only; macOS and Windows are pinned to a
single Node version (22) so the slowest runners don't double. Superseded runs
on the same ref are cancelled (`concurrency` with `cancel-in-progress: true`).

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

Turns Conventional Commits into release PRs. Releases are **manual**: this
workflow runs on `workflow_dispatch` only (Actions tab or
`gh workflow run release-please.yml`). When you trigger it, [release-please][rp]
opens/updates a single "release" PR that bumps the version in `package.json` and
updates `CHANGELOG.md`; merging that PR creates the matching git tag and GitHub
release.

So releasing stays a deliberate, manual step — no release PR appears just because
a feature merged. But once you decide to release, the changelog is generated for
you: trigger release-please → review the release PR → merge it → the changelog
entry, tag, GitHub release, **and** the npm publish all happen from that one
merge.

Configuration:

- `release-please-config.json` — single Node package at the repo root
  (`@nilsr0711/drydock`), releases tagged without a component prefix (`vX.Y.Z`).
  Pre-1.0 bumps stay in the minor range (`bump-minor-pre-major`).
- `.release-please-manifest.json` — tracks the last released version.

Because we already commit conventionally (`feat:`, `fix:`, `chore:` …), no extra
discipline is needed. Commits that should appear in the changelog use `feat:` or
`fix:`; everything else is grouped under "Miscellaneous".

When release-please reports that a release was created (`release_created`), it
reuses the **`npm-publish.yml`** workflow (via `workflow_call`) to publish the
new tag — see below.

## `npm-publish.yml` — npm publish

The single source of truth for publishing `@nilsr0711/drydock`. Triggered two
ways: `workflow_dispatch` (manual publish of the version on the chosen ref —
used for the first release and ad-hoc/recovery publishes) and `workflow_call`
(reused by `release-please.yml` after it cuts a release). It upgrades npm to
`>= 11.5.1` and runs `npm publish --access public`; `npm publish` first runs the
`prepublishOnly` gate (`pnpm test && pnpm build && pnpm smoke`), so a build that
fails to boot the standalone server never ships (issue #209).
Authentication is tokenless via **npm trusted publishing** (OIDC,
`id-token: write`) — no `NPM_TOKEN` secret — and provenance is attached
automatically. For reusable workflows npm validates the *calling* workflow, so
both `release-please.yml` and `npm-publish.yml` are registered as trusted
publishers for the package on npmjs. See
[ADR 026](adr/026-npm-package-and-cli-launcher.md).

## `doc-review.yml` — Documentation reminder

On PRs, compares the changed files against the base. If files under `src/`
changed but nothing under `docs/` did, it posts a single reminder comment to
update the docs. The comment is **idempotent**: it is keyed by a hidden marker,
so re-runs update the existing comment instead of posting a new one. If a later
push adds docs, the reminder is replaced with a confirmation. This is a nudge,
not a merge blocker.

[rp]: https://github.com/googleapis/release-please-action
