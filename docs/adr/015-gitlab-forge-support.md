# ADR 015: Pluggable forge platforms (github + gitlab)

- **Status:** accepted
- **Date:** 2026-05-27

## Context

Drydock talked to GitHub only. Every platform operation went through
`GhClient` (`src/lib/github/gh.ts`), a wrapper around the `gh` CLI. To support
GitLab — both gitlab.com and self-hosted / company-hosted instances with a
custom base URL and access token — the platform-specific operations had to move
behind a single seam without regressing the GitHub path.

## Decision

Introduce a `ForgeClient` interface (`src/lib/forge/types.ts`) capturing the
platform-independent operations: list/read issues, ensure/add/remove labels,
read PR/MR status & checks, post comments, create issues, create/merge PRs/MRs,
and fetch failed-CI logs. Two implementations exist:

- **github** (`createGithubForge`) — a behaviour-preserving thin factory that
  returns the existing `GhClient`. `GhClient` already satisfies the interface
  structurally, so the GitHub code path is byte-identical and regression-guarded
  by the original `gh` tests.
- **gitlab** (`GitlabForge`) — talks to the **GitLab REST API v4** over `fetch`
  rather than the `glab` CLI. This decouples Drydock from an external binary and
  is what makes custom base URL + token (self-hosted) practical.

A registry (`src/lib/forge/registry.ts`) dispatches on `repos.platform` via
`getForge(repo)`; the orchestrator (`run-job`, `driver-loop`, `ci-babysitter`)
and the issue server actions depend only on `ForgeClient`. Connection settings
live on the repo row: `platform`, `api_base_url`, `api_token`.

### Why direct API, not `glab`

The `glab` CLI would mirror the `gh` approach but adds an install dependency and
its own auth/host configuration. The REST API lets us pass an explicit base URL
and `PRIVATE-TOKEN` per repo, which is exactly what self-hosted instances need.

### Term & data mappings

- **Pull Request → Merge Request.** `prNumber` / `createPr` / `mergePr` /
  `prChecks` map to a GitLab MR **iid**. Issue numbers map to the GitLab issue
  **iid** (the project-internal number users see), never the global `id`.
- **Checks → pipeline jobs.** `prChecks` reads the MR's latest pipeline jobs and
  maps GitLab statuses onto the uppercase vocabulary `classifyChecks` already
  buckets (`success→SUCCESS`, `failed→FAILURE`, `running→IN_PROGRESS`,
  `pending/created/…→PENDING`, `manual→MANUAL`, `skipped→SKIPPED`). No MR
  pipeline yet → `[]` → treated as pending, same as GitHub.
- **Labels stay labels.** `ensureLabel` lists project labels and creates the
  missing one; GitLab requires a `#`-prefixed color, so a default is supplied
  when none is given. A concurrent create (HTTP 409 / "already exists") is
  tolerated, matching the GitHub race handling.
- **Merge.** `mergePr` uses `squash=true` + `merge_when_pipeline_succeeds=true`,
  the GitLab equivalent of `gh pr merge --squash --auto`.

### Self-hosted: certs, proxies, compatibility

- **Base URL & token** are configured per repo when adding it (UI) and stored in
  the local SQLite DB (`data/drydock.db`, already gitignored as containing
  "repo data & tokens"). The token is never written to the repo or the package.
- **Self-signed certs / corporate proxies** are handled at the Node runtime
  level rather than in app code: set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` (or,
  as a last resort, `NODE_TLS_REJECT_UNAUTHORIZED=0`) and/or `HTTPS_PROXY` in the
  environment Drydock runs in.
- **Compatibility:** the endpoints used (`/projects/:id/issues`, `/labels`,
  `/merge_requests`, `/pipelines`, `/jobs`) are stable across GitLab CE and EE
  and have existed since well before v13. The project is addressed by the
  URL-encoded path derived from the `origin` git remote (https and ssh forms).

### Assumptions

- The local checkout's `origin` remote points at the GitLab project; the project
  path is parsed from it (no separate "project id" config needed).
- Git push authentication (HTTPS token / SSH key) is handled by git itself in
  the worktree, out of scope for the forge client.
- Rate-limit/pagination differences vs. GitHub are bounded here by `per_page`
  caps mirroring the GitHub limits; deeper pagination is a future concern.

## Consequences

- New forges are added by implementing one interface plus fixture-based tests —
  no orchestrator changes.
- Existing GitHub repos default to `platform="github"` with null connection
  fields, so behaviour is unchanged with no migration data work.
- The forge metadata (`listForges`, `isForgeId`) lives in `types.ts` with no
  Node-only imports, so React components can render the platform selector without
  pulling `child_process` into the client bundle.
