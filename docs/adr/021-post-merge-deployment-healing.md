# ADR 021: Opt-in post-merge deployment healing via platform adapters

- **Status:** accepted
- **Date:** 2026-05-28

## Context

A merged Drydock PR can still break in production: a build error on Vercel, a
crash on Railway. Until now Drydock had no awareness of what happens after a
merge — green CI on the PR is where its responsibility ended. We want Drydock to
optionally watch a merged PR's deployment and, when it fails, open a follow-up
fix PR with the failure logs, without coupling the orchestrator to any one
hosting platform.

## Decision

Add an **opt-in**, per-repo post-merge deployment-healing stage
(`autoHealDeployments`, default off) built on a pluggable adapter so platforms
are added incrementally. It never auto-merges; a failed deployment produces a
follow-up PR for a human to review.

### 1. Deployment adapter abstraction

`src/lib/orchestrator/deployment/adapter.ts` defines a
`DeploymentPlatformAdapter` with `detect()`, `getStatus()` (normalised to
`building | deploying | ready | error | not_found`), and `getLogs()`. Concrete
`VercelAdapter` and `RailwayAdapter` drive their platform's CLI; a registry
iterates the adapter list for detection and dispatches by id. Adding Netlify,
Fly, or Render means implementing one adapter and adding it to the registry list
— **no core changes**, mirroring the existing forge abstraction (ADR 014/015).
Status parsing is pure and exhaustively tested; the CLI invocation and the
file-existence probe used by `detect` are injected so adapters are testable
without spawning a process or touching the filesystem.

### 2. Platform detection with explicit override

The platform is auto-detected from committed config (`vercel.json`/`.vercel`,
`railway.json`/`railway.toml`/`.railway`). A per-repo `deploymentPlatform`
override column wins when set, surfaced in the automation bar as an
"Auto-detect / Vercel / Railway" select. A repo with no detectable platform is
simply not monitored.

### 3. Healing session and state machine

A new `deployment_healing_sessions` table tracks one session per merged commit
(`(jobId, commitSha)` unique, so a merge is monitored exactly once). `status` is
a `DeploymentHealingStatus` walking:

```
monitoring → healthy                        (deployment went live)
monitoring → failed → repairing → repaired  (fix PR opened)
```

with `escalated` reachable from every active state (poll timeout, or no fix PR
could be opened). `healthy`, `repaired`, and `escalated` are terminal.

### 4. Non-blocking, budgeted polling

Rather than block a tick with a long sleep loop, monitoring advances one step
per driver tick. A pure `pollGate` decides `wait | poll | timeout` from the
configurable initial delay, interval, and timeout; `classifyDeploymentStatus`
collapses an adapter status into `pending | ready | error`. Only jobs merged
within a monitor window are picked up, so enabling the feature does not
retroactively monitor old merges. The sweep runs in the driver loop at **low
rate-limit priority** alongside review-feedback, with per-repo and per-session
error isolation.

### 5. Follow-up fix PR

On `error`, the adapter's logs are captured (bounded to `maxLogLines`) and a
follow-up fix PR is opened: a worktree is cut on a fresh branch from the default
branch, the agent is prompted with the deployment logs, and the result is
committed, pushed, and turned into a PR via the forge — reusing the same
worktree/agent/forge seams as the review-feedback lifecycle (ADR 019). The fix
PR number is recorded on the session and surfaced in the repo's Deployments
panel.

## Consequences

- Deployment failures after merge become actionable automatically, with the
  logs already attached to a fix PR.
- The feature is inert unless a repo opts in and a platform is detectable;
  ordinary repos are wholly unaffected (no sessions, no extra calls).
- New platforms are a one-adapter change, keeping the orchestrator
  platform-agnostic.
- Polling is bounded by the initial-delay/interval/timeout budgets and the
  monitor window, so it cannot run away with cost or API calls. Drydock never
  auto-merges the fix PR — a human always reviews it.
- Adapter status reflects each CLI's current output format; richer per-commit
  deployment correlation (beyond matching the commit SHA in `vercel list`) is a
  deliberate future refinement, not part of this change.
