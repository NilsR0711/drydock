# ADR 034: Agent-driven release (manual, per repo)

- **Status:** accepted
- **Date:** 2026-06-18

## Context

The opt-in release manager (ADR 028) is **deterministic**: a manual publish
forces a patch bump, computes notes from the PRs merged since the last tag, and
cuts a GitHub Release at the default-branch tip via `forge.createRelease`. It
cannot model how a repo *actually* releases — e.g. Drydock's own flow is
release-please via `workflow_dispatch` in two steps, npm publish, changelog
conventions. The deterministic path can only ever cut a GitHub Release; it does
not let an agent inspect a repo and execute its real release mechanism.

Issue #256 asks for a **manual button** that spawns an **agent-driven** release:
the agent discovers how *this* repo releases (CI workflows, `package.json`
scripts, release-please config, CHANGELOG, prior tags), determines the next
version, and **performs the release the way the repo expects** —
committing/triggering as needed — with its steps streamed to a job log, and a
`needs_human` handoff when it is unsure. Nothing happens without the press.

## Decision

Add a **manual, per-repo "Run release (agent)" action**, gated by the same
global (`settings.releaseManagementEnabled`) and per-repo (`repos.releaseEnabled`)
opt-in as ADR 028, plus the forge's release capability. It is **never automatic**
— a release is hard to reverse, so it only ever runs on an explicit button press.

### 1. A release is a job of a new `kind`

The issue-implementation flow (`run-job.ts`) is PR/CI-shaped (view issue →
implement → PR → babysit CI → merge) and does not fit a release. Rather than
thread a release branch through that 900-line function, a release is a **job
with `jobs.kind = "release"`** that `runJob` dispatches to a **separate runner**
(`release-job.ts`) at the top; the issue flow is untouched. Reusing the jobs
table buys the whole machinery for free: background execution via the driver
loop, live log streaming via the broker + job detail page, and the existing
`needs_human` park state. Release jobs carry the sentinel `issueNumber = 0` —
`kind` is the source of truth, so `issue_number` stays `NOT NULL` and no
nullable-column blast radius spreads across the issue-flow code.

### 2. New terminal job state `released`

The job state machine's only terminal success is `merged`, reachable only via
`ci_running`. A release has no PR/CI. Adding a `working → merged` shortcut would
weaken the issue-job invariant (a reviewer could no longer trust that `merged`
implies CI ran) and would count releases as merged PRs in analytics. So a
dedicated terminal **`released`** is added (`working → released`), excluded from
PR-merge analytics, and folded into every terminal-aware set (dedupe index,
`TERMINAL_STATES`, log-viewer stream-end, branch janitor, badge tone).

### 3. Full shell access for the release session only

Issue-implementation sessions run under `--permission-mode acceptEdits`, where
arbitrary `Bash`/`gh`/`git` blocks on an approval that never comes headlessly —
fine, because Drydock does the commit/push/PR itself. An agent-driven release
must run the repo's *actual* release commands, so its session runs with
`--dangerously-skip-permissions` (threaded as an opt-in `bypassPermissions` flag
through `spawnAgentSession` → the Claude provider's start args; off everywhere
else). This is bounded: manual-only trigger, the same double opt-in, the host's
already-authenticated `gh`/git credentials (the same trust as the operator
running the commands by hand), and full log streaming for auditability. v1
supports the **Claude** agent only (the verified bypass flag); codex/openrouter
error clearly and are a follow-up.

### 4. Execution and recording

`runReleaseJob` prepares a throwaway worktree on the default branch (branch
label `release`), renders the per-repo-editable **release prompt**
(`TEMPLATE_NAMES.release`), spawns the full-access session, and maps the
outcome: a clean run settles the job `released` and a linked `release_runs` row
(`mode: "agent"`, walked to `published`) stamped with whatever the agent
reported in an optional `.drydock/RELEASE.md`; a `.drydock/QUESTIONS.md` (reusing
the #251 mechanism) or any failure (timeout / cost cap / spawn / provider limit /
non-zero exit) lands the job in `needs_human` and the run in `error`. A provider
limit is **not** auto-waited — re-running a partly-done release unattended could
double-cut it, so an operator decides. Drydock never commits/pushes the worktree;
the agent performs its own pushes/triggers, and the throwaway checkout is removed
on cleanup. The `release_runs` row links back to the job (`release_runs.job_id`)
so the panel deep-links to the live log.

## Consequences

- The agent closes the autonomy loop past merge for repos whose release flow the
  deterministic path could not model, while the deterministic preview/publish
  (ADR 028) stays for repos that want a fixed GitHub Release.
- The release session has full shell access — the irreducible cost of "the agent
  performs the release itself". Mitigated by manual-only trigger, double opt-in,
  the host-credential trust model, and full log streaming.
- The release-run state machine (ADR 028) is reused as-is; an agent run walks
  `detected → evaluating → … → published`, or `→ error` on failure/handoff. The
  `error` state doubles as the human-handoff lane for agent runs (the job's own
  `needs_human` status and log carry the detail).
- v1 is Claude-only and a parked release blocks a new one until aborted (same as
  issue jobs) — both deliberate first-cut boundaries, not permanent limits.
