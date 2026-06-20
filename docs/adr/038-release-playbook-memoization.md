# ADR 038: Prominent release button + per-repo release playbook memoization

- **Status:** accepted
- **Date:** 2026-06-20

## Context

ADR 034 added the **agent-driven release**: a job whose agent discovers how a
repo releases (CI workflows, `package.json` scripts, release-please config,
CHANGELOG, prior tags), determines the next version, and performs the release
with full shell access. Two limitations surfaced in use (issue #352):

1. **Discoverability.** The only trigger was a "Run release (agent)" button
   buried inside a collapsed "Releases" panel that renders only when the per-repo
   `releaseEnabled` opt-in is on. ADR 034 gated the manual action behind the same
   double opt-in as the deterministic auto-pipeline (ADR 028). But the per-repo
   opt-in is really the switch for the **background** auto-release sweep — it has
   no bearing on whether an operator may deliberately press a button. The gate
   made the manual action undiscoverable on the default-configured repo.

2. **Cost.** `.drydock/RELEASE.md` reports *this run's* tag/title/notes and is
   then discarded. Nothing persists *how* the repo releases, so the agent
   re-investigates the mechanism from scratch on every run — the most expensive
   part of the session, repeated needlessly.

## Decision

### 1. A prominent, always-visible "Create release" button

A new `ReleaseButton` client component sits in the repo workspace `PageHeader`
actions, **on every repo page**, independent of `releaseEnabled`. Click →
`ConfirmDialog` (a release is hard to reverse) → `startReleaseAction` → navigate
to the job's live log. `startReleaseAction` now resolves its release context with
`requireRepoOptIn: false`: the **global kill-switch**, **forge capability**, and
**CLI-agent** checks still apply, but the per-repo `releaseEnabled` opt-in does
not. The deterministic `previewReleaseAction` / `publishReleaseAction` are
unchanged — they keep the full double opt-in. The existing in-panel "Run release
(agent)" button stays for repos that have opted in.

### 2. Per-repo release playbook memoization

A new nullable `repos.release_playbook` text column (migration `0045`) stores the
repo's release procedure, following the `agentInstructions` column pattern — but
machine-written, not operator-edited, so it is **not** part of `repoInputSchema`
and is written through a dedicated `setReleasePlaybook` service function (a
partial repo update must never reset it). It is excluded from the portable
settings bundle: it is a learned cache, not configuration.

A new worktree artifact `.drydock/RELEASE_PLAYBOOK.md` (distinct from
`RELEASE.md`) carries the procedure out of the session, consumed by
`consumeReleasePlaybook` — mirroring `release-metadata.ts` (read, length-cap,
remove). A new `$RELEASE_PLAYBOOK` template variable injects the stored playbook
into the `release` prompt: present → follow it step by step, verifying each step
and only re-investigating a drifted one; absent → investigate from scratch as
before. In **both** cases the agent writes the corrected, up-to-date procedure
back to `.drydock/RELEASE_PLAYBOOK.md` — commands/steps only, **never secrets or
tokens**.

`runReleaseJob` captures the playbook on a **clean release only**: the
`needs_human` / aborted / interrupted paths all return before the capture, so a
parked run can never blank a known-good playbook, and a clean run that recorded
nothing leaves the existing playbook untouched (only a non-null capture is
persisted).

**Effect:** run 1 investigates (expensive) and records the playbook; runs 2+
follow the known steps with light verification, far cheaper.

## Consequences

- The manual agent-driven release is now reachable on any repo with the global
  release kill-switch on, a release-capable forge, and a CLI agent — the per-repo
  opt-in no longer hides it. This **amends** ADR 034's gating for the manual path
  only; the background sweep and the deterministic pipeline (ADR 028) are
  untouched.
- The playbook lives only in Drydock's DB, never committed to the watched repo,
  and holds no secrets by construction (the prompt forbids them and the column is
  length-capped). There is no multi-version history — a single current blob per
  repo, overwritten on each clean release.
- A playbook can drift (a workflow is renamed, a script changes). The prompt
  mitigates this by requiring per-step verification before relying on a recorded
  step, and a clean run rewrites the corrected procedure.
