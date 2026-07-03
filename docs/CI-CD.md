# CI/CD Pipeline

All automation lives in `.github/workflows/`. Workflows are scoped to the
`master` branch and pull requests targeting it.

## Action pinning

Every external `uses:` reference is pinned to a full 40-character commit SHA with
a trailing `# vX.Y.Z` comment, e.g. `actions/checkout@9c091bb…e0 # v7.0.0`
(issue #391). A mutable major tag (`@v7`) can be moved or force-pushed, which
would let a compromised action repo run attacker-controlled code with whatever
permissions the job holds — most sensitive in `npm-publish.yml` (`id-token:
write`, the OIDC token that publishes to npm) and `release-please.yml`
(`contents: write` / `pull-requests: write`). Pinning to a SHA removes that
trust assumption entirely. Dependabot's weekly `github-actions` group
(`.github/dependabot.yml`) understands SHA pins and bumps the SHA and its version
comment together, so the pins stay current for free. Local reusable-workflow
references (`uses: ./.github/workflows/npm-publish.yml`) resolve within this repo
at the checked-out commit and are intentionally left as paths. The
`workflow-action-pins` test guards the convention against regression.

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

The suite runs with a small **CI-only retry budget** (`retry: 2` when `CI` is
set, `0` locally — see `vitest.retry.ts`, issue #393). A few
timing/parallelism-sensitive suites — real filesystem watchers and `:memory:`
databases exercised under load — occasionally fail as false negatives on shared
runners; a retry lets an intermittent flake re-run instead of blocking a merge.
Because the same suite gates `npm publish` through `prepublishOnly`, this also
stops a lone flake from aborting a release mid-flow. Locally the budget is `0`,
so flakiness surfaces immediately, and a genuinely failing test still fails on
every attempt — the publish gate is unchanged.

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
(reused by `release-please.yml` after it cuts a release). It installs a pinned
npm (`>= 11.5.1`, an exact version rather than a floating `npm@latest`, so
releases stay reproducible and immune to a future npm major — issue #395) and
runs `npm publish --access public`; `npm publish` first runs the
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

**Fork PRs** run with a read-only `GITHUB_TOKEN` — GitHub caps it regardless of
the job's `pull-requests: write` request — so the comment API would `403`. To
keep the check green for outside contributors, the reminder degrades gracefully:
on a fork PR it is written to the **job summary** (and the run log) instead of a
PR comment. The write path is also wrapped so any future permission surprise
logs a warning rather than failing the job. The reminder logic lives in
[`.github/scripts/doc-review-reminder.mjs`](../.github/scripts/doc-review-reminder.mjs)
so it can be unit-tested (`tests/doc-review-reminder.test.ts`).

[rp]: https://github.com/googleapis/release-please-action
