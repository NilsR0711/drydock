# Feature reference

The complete, detailed catalogue of every Drydock capability. For a scannable
overview, see the [README](../README.md#features); this document is the deep dive,
with the architecture decision record (ADR) and issue links behind each feature.

> Most features are **per repo** and many are **off by default** — see
> [Configuration](../README.md#configuration) for the safe-by-default posture.

## Table of contents

- [Queue & orchestration](#queue--orchestration)
- [Autonomous implementation](#autonomous-implementation)
- [Agents & execution](#agents--execution)
- [CI, merge & branch hygiene](#ci-merge--branch-hygiene)
- [Review & verification](#review--verification)
- [Beyond merge](#beyond-merge)
- [Issue intelligence](#issue-intelligence)
- [Platform & forge](#platform--forge)
- [Cost & limits](#cost--limits)
- [Notifications & visibility](#notifications--visibility)
- [Surfaces](#surfaces)
- [Operations](#operations)

---

## Queue & orchestration

### 🗂️ Backlog & queue board

Drag issues from a synced backlog into a sortable, priority-ordered queue. The board
reflects actual scheduler state: an issue with a live job (queued, working, CI, …)
shows in the queue with its status badge regardless of how it got there — manual queue
label or the auto `ready` path. One issue or many in flight, per repo.

### 🧱 Crash-safe lease queue

Jobs are claimed from a SQLite-backed queue with a lease token kept alive by heartbeats.
A crashed worker's `working` jobs are requeued (with attempt-scaled backoff) on the next
startup instead of getting stuck, CI-babysitting states park as `interrupted`, finalizing
with a stale lease is rejected, a dedupe key prevents double-enqueuing the same issue, and
a PID lockfile stops a second instance racing the queue. Graceful shutdown drains then
SIGKILLs after 5s. See [ADR 022](adr/022-lease-based-job-queue.md).

### ⏯️ Global pause & per-repo controls

Pause or resume the whole dock with one click from the navbar, pick an agent and model
per repo, toggle serial vs. parallel processing, and customize the queue label.

---

## Autonomous implementation

### 🤖 Autonomous implementation

Spawns a coding agent (`claude` or the `codex` CLI), streams its work, and opens a pull
request. The default prompts steer **senior-level, test-driven** work: read the repo's
conventions (`CLAUDE.md`/`AGENTS.md`) and match the surrounding code, write a failing test
first then implement to green, update docs when behaviour changes, and **verify before
finishing** (tests, typecheck, lint, build) without weakening tests or security to pass —
all editable per repo in `/prompts`. The agent is steered to land focused, thematic
Conventional-Commit commits with **no AI attribution**; Drydock also scrubs any
`Co-Authored-By: Claude` / `Generated with Claude Code` trailer from the branch before
pushing, so the guarantee holds even if a model ignores the prompt. The agent describes its
own change in a `.drydock/PR.md` (a Conventional Commit subject plus a body that, by default,
leads with a TL;DR and then Problem/Solution/Tests/Risks — the body shape is its own per-repo
editable `PR format` template); Drydock uses it for the commit message and the PR title/body,
appends `Closes #N`, and excludes the file from the commit — falling back to `Fix #N` /
`Closes #N` when it's absent.

### 🙋 Autonomous question handoff

When the agent hits a decision only a human can make, it writes its open questions to a
`.drydock/QUESTIONS.md` (same convention as `PR.md`). Drydock then preserves the branch and
any partial commits, posts the questions as an issue comment, sets the `needs-human` label,
and parks the job in `needs_human` instead of opening a PR — so a real blocker is handed off
cleanly without anyone watching the dashboard, while everything else stays fully autonomous.

### 🗂️ Autonomous follow-up filing

When the agent consciously leaves something out of scope, it appends the deferred work to a
`.drydock/FOLLOWUPS.md` (one `## title` block per item, same convention as `PR.md`). Drydock
opens a real GitHub issue for each entry, records it against the originating job (so a rerun
never double-files), links them from the PR body (`Spun off: #N, #M`), and excludes the file
from the commit — turning a deferred idea into tracked work with zero human action.

---

## Agents & execution

### 🔌 Pluggable agents

Choose `claude`, `codex`, or `opencode` per repo (with a global default in settings); a
preflight check verifies the selected CLI is installed.

### 🧭 Opt-in opencode agent

Drive [opencode](https://opencode.ai) as a third CLI agent to reach **any model from any
provider** (Anthropic, OpenAI, Google, OpenRouter, local Ollama/LM Studio — 75+ via
[models.dev](https://models.dev)) behind one `provider/model` id, without Drydock owning a
catalog. It rides the same spawn/stream path as the Claude/Codex CLIs: `opencode run
--format json` emits JSONL that Drydock parses incrementally, and **per-step USD cost and
token usage are read straight from the stream**, so per-job cost caps, daily budgets, and the
dashboards work unchanged. Models are entered as free text (`provider/model`); the binary path
is set in Settings. Permissions use opencode's permissive defaults (edits + bash), with
`--dangerously-skip-permissions` reserved for the agent-driven release path. **OpenRouter** is
reached through opencode as `openrouter/<model>` — Drydock bridges a stored OpenRouter API key
onto the opencode process (`OPENROUTER_API_KEY`), so its hosted/free-tier models work without
separate opencode auth. This replaces the former bespoke OpenRouter HTTP backend (now retired).
Off by default — pick `opencode` per repo. See
[ADR 038](adr/038-opencode-cli-agent.md) and [ADR 039](adr/039-retire-openrouter-for-opencode.md).

### 📦 Opt-in sandboxed execution

Per repo, run the agent CLI session **inside a container** (Docker or Podman) instead of
directly on the host. The job's worktree is bind-mounted as the only writable host path, so a
prompt-injected issue cannot reach host files through the test/build scripts the agent runs;
networking is **off by default** (`--network none`), with optional CPU/memory caps. The image
is resolved per job (explicit per-repo override → repo `devcontainer.json` → a configurable
global default) and must carry the agent CLI plus the repo's toolchain. Only the minimum
credentials are mounted **read-only** (the agent CLI's config; a `GH_TOKEN` via env) — git push
still happens on the host, so no SSH keys enter the container. Timeout/abort **force-remove** the
named container, so none is orphaned, and a missing runtime fails preflight with a clear reason.
Off by default — zero behavior change for existing repos. See
[ADR 033](adr/033-sandboxed-agent-execution.md).

### ⚠️ Opt-in unrestricted shell access

Per repo, run the agent's jobs with full, unsandboxed shell access (Claude's
`--dangerously-skip-permissions` / Codex's `--dangerously-bypass-approvals-and-sandbox`) instead
of the default edits-only mode (Claude's `acceptEdits` / Codex's `--sandbox workspace-write`).
Headless jobs normally auto-accept file edits but **cannot** run Bash that isn't allowlisted — no
human is there to approve it — which breaks repos whose tests/builds need shell access that can't
run in a Docker sandbox (e.g. **native Xcode**: `xcodebuild` / `simctl` / `xcrun`). When enabled,
the agent can execute any command unsupervised across its implement, resume, and CI-fix sessions.
This is a deliberately **dangerous escape hatch** — it grants full shell access with no approval
gate — so it is **off by default**, labelled as such in the repo's settings, and best combined
with the container sandbox above. Reuses the same bypass plumbing as agent-driven releases (see
[ADR 034](adr/034-agent-driven-release.md)).

### ✅ Per-repo command allowlist

A safer middle ground than the all-or-nothing bypass above. Pre-approve specific commands (e.g.
`git`, `xcodebuild`, `xcrun`, `swift`) so they run headlessly via Claude Code's `--allowedTools`
(`Bash(<cmd>:*)`), while everything else stays in the default edits-only mode. Applies on **every**
session path — implement, CI-fix/limit/instruction resume, and PR review-feedback side sessions.
**Empty by default** (no headless Bash); orthogonal to the bypass flag, and ignored when full bypass
is on. Caveats: `Bash(git:*)` allows **all** git subcommands (including `git push --force`), and
**chained** commands (`xcodebuild && foo`) may still be blocked — so list the single invocations a
build/test actually needs.

### 🧠 claude-mem memory consolidation

Every job runs in a throwaway per-job git worktree. [claude-mem](https://github.com/thedotmack/claude-mem)
keys its memory off the worktree, so without help each job's observations would be stranded in a
one-off `<repo>/<worktree>` bucket instead of accumulating under the real project. As a job settles,
Drydock runs claude-mem's `adopt` for the worktree — while it still exists — so the memory is
consolidated into the **parent** project (`<repo>`). This happens **by default, on every outcome**:
merged, `needs_human` (including a preserved worktree that is deliberately kept for resume), CI-failed,
and abandoned/unmerged branches alike. It is strictly **best-effort** and needs no configuration: if
the claude-mem plugin is not installed it is a visible no-op, and any failure is logged (never blocking
worktree cleanup or changing the job's outcome). The per-job **worktree isolation** itself is unchanged —
only the memory is carried back to the parent.

---

## CI, merge & branch hygiene

### 🔧 CI babysitting & auto-merge

Polls `gh pr checks`, merges on green (optionally after a per-repo **merge gate**: a settle window
that holds the merge so late bot/human reviews can land and feed the review-feedback loop first; any
regression re-arms the window), and on red resumes the session with a CI-fix prompt (up to **3
retries**), then files a follow-up issue and hands off. The failed log is classified by failure type
(test, type error, lint, build, dependency, timeout, flaky) and reduced to a focused, line-capped
evidence slice so the fix prompt targets the actual failure. The merge itself — the one irreversible
step — is **guarded**: a branch that fell **behind** its base is updated and re-polled instead of
merged blind (so strict-check auto-merge cannot silently queue forever), a **conflicted** PR is
escalated rather than merged, and a merge that outright fails parks the job as `needs_human` with an
actionable reason rather than reporting a false `merged`.

### 🩹 CI auto-heal

Per repo, turn the failure path into a structured classify → fix → verify loop: failing checks are
bucketed (healable / external / flaky / unknown), only healable ones get a targeted fix, and each
attempt is verified for a real, improving change. Flaky checks get a plain re-run instead of a code
edit (GitHub; on forges without re-run support they escalate to a human). External and AI-review
checks are never code-healed. Hard budgets (per-session and per-fingerprint attempts, a cooldown, and
a concurrency cap) keep it bounded. **On by default** (issue #254); opt-out per repo; never auto-merges.

### 🧹 Branch & PR janitor

A periodic background sweep keeps the remote tidy: the remote branch of a merged Drydock PR is
**deleted within one sweep** (idempotent across restarts — each cleanup is stamped on the job's event
log), an open PR that fell **behind** the default branch is updated automatically while conflict-free,
and a **conflicted** PR is **auto-rebased onto the default branch** when the repo's
`autoResolveMergeConflicts` flag is on (a bounded, single-attempt rebase that force-pushes only what it
rewrites). When that plain rebase hits a **genuine content conflict** and the repo opts into
`resolveConflictsWithAgent` (off by default, riskier than a plain rebase and independent of the flag
above), an **agent resolves the conflict markers in the worktree** before the rebase continues —
bounded by a small per-rebase budget, force-pushed with a lease, never merged, and accompanied by an
auditable PR comment listing what it resolved. Only if every enabled repair fails (or both flags are
off) does the job park as *needs a human* with an explicit "rebase needed: conflicts with `<default
branch>`" reason instead of letting CI polling time out. Only branches under the `drydock/` prefix are
ever deleted or updated.

### 🔗 Babysit any PR by URL

Point Drydock at an *existing* pull request (yours or someone else's) and it watches its CI, runs the
review-feedback loop, heals failing checks on branches it owns, and hands off to a human on a conflict
or a fork it can't push to — all the machinery that backs Drydock's own PRs, now decoupled from an
originating issue. Add one from the repo dashboard or the `track_pr` MCP tool; it stays tracked
regardless of whether the repo's *issues* are watched. **Auto-merge is opt-in per PR and only ever
applies to clean, green branches we own** — externally-authored and fork PRs are never merged or
pushed to. See [ADR 037](adr/037-tracked-pr-babysitting.md).

### 💬 PR review-feedback

Per repo, ingest review threads on a Drydock PR and run the mechanical iteration: only **trusted
reviewers** and explicitly **allowlisted bots** are acted on — unlisted bots are ignored, each comment
walks a lifecycle (`pending → queued → in_progress → resolved`, with `failed` / `rejected` / `flagged`
branches), and the agent applies the change on the PR branch, replies, and resolves the thread. Status
replies are marker-based and idempotent (updated in place, not duplicated), with bounded per-sweep and
per-item budgets. **On by default** for autonomous operation, seeded with well-known review bots
(`cursor[bot]`, `coderabbitai[bot]`) and opt-out per repo; never auto-merges. See
[ADR 019](adr/019-pr-review-feedback.md).

---

## Review & verification

### 🔎 Post-PR verification

Per repo, run a **read-only** pass right after a PR opens that checks whether the diff actually
satisfies the issue and each decomposed subtask. A one-shot agent is given the issue, its subtasks, and
the (length-capped) diff and returns a strict JSON verdict (`done` / `pending` / `deferred`) per
subtask; the result updates subtask status and posts a verification summary flagging what remains. It
runs in a throwaway dir with a tight timeout, and on any failure (non-zero exit, non-JSON output,
exception) leaves status unchanged — never corrupting state. **On by default** (issue #254); opt-out per
repo; never auto-merges. See [ADR 027](adr/027-post-pr-verification.md).

### 🔍 AI PR audit

Per repo, run a **read-only, whole-PR review** (Bugbot/CodeRabbit style) right after a PR opens, or on
demand from the job page / `run_pr_audit` MCP tool. A one-shot agent — its **agent and model selectable
per repo** (defaults inherit the repo's agent/model) — reviews the length-capped diff, CI conclusions,
and the linked issue with its subtasks across six dimensions (correctness, security, tests,
API/compatibility, maintainability, issue fit) and returns strict JSON, rendered as a severity-ranked
markdown comment on the **PR** itself — where the diff and the other review bots live (optionally
mirrored on the issue, issue #317). Re-runs update the same marker comment in place; oversized PRs get a
partial audit with a truncation notice; the review language is configurable (`en` default). Failures
post a short note and never touch job state; provider usage limits defer the audit via the ADR 030
latch; a global pause skips it. Cost-tracked like other one-shots. **Off by default** (issue #316) — a
repo already running an external reviewer (CodeRabbit, Cursor BugBot) shouldn't pay for a duplicate
whole-PR review; opt in per repo. **Advisory by default** — never merges or blocks. An **opt-in
auto-fix** (issue #318, off by default, gated on the audit) closes the loop without an external review
bot: the agent addresses its own high-severity findings (`blocker`/`major`, never nits) in the job's
worktree and pushes a follow-up commit to the PR branch. It reuses the
[ADR 019](adr/019-pr-review-feedback.md) review-feedback ledger for idempotency and bounded budgets, is
idempotent across re-runs, and **never auto-merges** — the fix re-triggers CI and goes through the
normal merge gate. See [ADR 031](adr/031-pr-audit.md).

### 💬 Ask about this PR

On a job's detail view, ask a free-text question ("why did this change X?", "is the failing test
related?", "what's left to do?") and a **read-only** agent answers from a length-capped context bundle
Drydock already has: PR metadata, check pass/fail state, a review-feedback summary, the recent activity
log, and the PR diff. Each question is persisted with a visible lifecycle (`answering → answered |
error`), scoped to the PR it was asked about, and empty or failed responses are recorded as an error
rather than crashing. Also reachable over REST and MCP (`ask_pr_question`).

---

## Beyond merge

### 🚀 Opt-in post-merge deployment healing

Per repo, watch a merged PR's deployment via pluggable platform adapters (Vercel and Railway today;
adding Netlify/Fly/Render is one adapter, no core changes). The platform is auto-detected from repo
config or set explicitly. The merged commit's deployment is polled with bounded delay/interval/timeout
budgets, and on failure the logs are captured and a follow-up **fix PR** is opened for a human to review.
Sessions are surfaced in the repo's Deployments panel. Off by default; never auto-merges. See
[ADR 021](adr/021-post-merge-deployment-healing.md).

### 🏷️ Opt-in release management

Per repo, extend autonomy past merge to shipping: evaluate the PRs merged since the last tag, decide
whether a release is warranted and the semver bump, generate notes, and publish a release. The auto path
is **idempotent** (one run per merge commit, never a duplicate release for a tag) and a failed run is
retryable; a **dry-run preview** shows the proposed version and included PRs with no side effects; a
**manual publish** forces a release through the same evaluation pipeline. Gated by both a global
kill-switch and a per-repo opt-in, off by default; releases at the default-branch tip and never
auto-merges. See [ADR 028](adr/028-release-management.md).

A prominent **"Create release"** button at the top of every repo page spawns an **agent-driven** release
instead: the agent inspects how _this_ repo releases (CI workflows, `package.json` scripts, release-please
config, CHANGELOG, prior tags), determines the next version, and **performs the release the way the repo
expects** — triggering a `workflow_dispatch`, pushing a tag, opening a release PR, or running a publish —
with full shell access, every step streamed to a job log, and a `needs_human` handoff (via
`.drydock/QUESTIONS.md`) when it is unsure. As a deliberate operator action it sits behind a confirm
dialog and is gated by the global kill-switch and a release-capable forge — but **not** the per-repo
opt-in, which only governs the background auto-release. Every agent is a local CLI with shell access, so
all (claude/codex/opencode) can drive a release. On a clean release the agent records how the repo
releases to a per-repo **playbook** (`.drydock/RELEASE_PLAYBOOK.md` → `repos.release_playbook`,
commands/steps only, never secrets); later runs follow the known steps with light verification instead of
re-investigating from scratch, far cheaper. See [ADR 034](adr/034-agent-driven-release.md) and
[ADR 038](adr/038-release-playbook-memoization.md).

---

## Issue intelligence

### 🛂 Autonomous triage

Per repo, let Drydock label incoming issues (deterministic keyword classifier, whitelist-only output)
and auto-process the ones that are *ready* and not blocked. **Off by default** — opt in per repo (issue
#285), since turning either on acts on the whole backlog; gated by author association for public repos, a
per-issue attempt limit, and all the usual cost/concurrency limits. Never auto-merges.

### 🧩 Issue decomposition

Per repo, split a large issue ("fix these 5 bugs", "implement X with A/B/C") into ordered, tracked
subtasks. A deterministic heuristic handles GitHub task lists (`- [ ]`) and "Bug N —" headings for free;
prose falls back to a one-shot agent. Decomposition is idempotent (keyed on the issue body hash, redone
only when the body changes), subtasks are surfaced in the agent prompt and worked in order, and progress
is reflected on the issue and in the UI. **Off by default** — opt in per repo (issue #285): it fires slow
agent one-shots across the backlog. See [ADR 020](adr/020-issue-decomposition.md).

### 🪜 Opt-in model escalation on retry

Per repo, retry failed jobs one rung up the model ladder: when a job parked in *needs a human* is
requeued, the next attempt runs the **next-stronger model** of the repo's agent (e.g. Haiku → Sonnet →
Opus), capped at the strongest. The escalated model is persisted on the job, so each attempt is **priced
at the model that actually ran** and the job page shows which rung an attempt used (a `model_escalated`
event on the timeline). Limit-parked jobs resuming their session and interrupted jobs are never escalated.
Off by default.

### 📋 Opt-in plan-first

Per repo, run a **read-only planning pass** before implementation: a one-shot agent explores the codebase
and produces a step-by-step plan, which is posted on the issue (an audit trail you can react to) and
embedded in the implementation prompt as a dedicated section. The plan template is editable like the other
prompts, plan cost is tracked like other one-shots, and any failure (non-zero exit, empty plan) falls back
to the normal single-stage run. Off by default.

### 📝 Per-repo agent instructions

Give each watched repo free-text guidance (coding conventions, "always run `pnpm test`", "don't touch
`legacy/`", preferred PR style) from the automation panel. The text is injected into the issue-work prompt
as a dedicated, length-capped section, so you steer agent behavior per project without editing global
prompts or code. Empty by default; an unset value leaves the prompt unchanged.

---

## Platform & forge

### 🦊 GitHub & GitLab

Choose the platform per repo. GitLab (gitlab.com or self-hosted) uses the REST API v4 with a per-repo
base URL + access token — no extra CLI to install.

### 🪝 Webhook-driven sync & nudges

Opt in per repo to receive forge events instead of waiting for the next poll. Set a secret on a repo and
Drydock exposes a signature-verified receiver (`/api/webhooks/<id>`): a validated issue event triggers a
targeted, debounced sync so new issues surface near-instantly; a finished `check_suite`/`check_run`
(GitLab: pipeline) wakes the CI babysitter so green PRs merge within seconds instead of at the next poll;
a new PR review or review comment triggers the review-feedback sweep right away. Polling stays on as the
default fallback and shares the same idempotent reconcile, so a change is never double-processed. Since
Drydock binds `127.0.0.1`, expose the URL through a tunnel (e.g. `cloudflared`, `ngrok`). See
[ADR 029](adr/029-webhook-issue-sync.md).

### ⚖️ Rate-limit budgeting

A priority-aware governor meters every GitHub call: the background sweep runs at *low* priority and yields
once the budget drops below a reserve fraction, while interactive actions stay *high*; a hard floor stops
anything from draining the budget to zero, a 429 backs off until reset, and unchanged single-page issue
lists are fetched with conditional ETag requests so they cost nothing (multi-page lists are always
refetched — GitHub's ETag only validates the first page). See [ADR 018](adr/018-rate-limit-governor.md).
That back-pressure is now **visible**: a navbar pill and dashboard card show the per-resource (REST/GraphQL)
remaining budget, its reset countdown, and a distinct **"sweeps deferred"** state below the reserve
fraction, and `GET /api/health` exposes the same per-resource snapshots for monitoring probes (issue #408).

### 📦 Export/import repo settings

From a repo's automation panel, export its configuration plus its per-repo prompt-template overrides as a
**versioned, human-readable JSON bundle** (download or copy), then import it into another repo to reuse a
dialled-in setup, keep a portable backup, or share a sanitized starting template. Import previews exactly
what will change before applying. Identity and secrets — `path`, `name`, `defaultBranch`, `apiToken`,
`webhookSecret`, `apiBaseUrl` — are **never exported and never overwritten on import**; unknown or future
fields are skipped with a warning instead of failing the whole import, and a round-trip into a fresh repo
reproduces the same effective config.

---

## Cost & limits

### 💸 Cost tracking

Per-job and aggregate spend from the agent's reported `total_cost_usd` (or estimated from tokens), with a
**daily cost limit** and a **monthly cost limit** that gate the driver loop (global + per-repo, all
**`0` = off / unlimited**) and an optional **per-job cost ceiling** that aborts a single runaway session
mid-stream (global default + per-repo override; off when unset). The monthly gate measures month-to-date
spend (jobs + one-shot costs) the same way the daily one measures today. Every cost ceiling can be turned
off with `0`, leaving only the per-job cap, provider usage-limit auto-wait, and pause/drain as stops. The
**Costs** page complements the retrospective view with a **month-end projection** from the trailing 7-day
run rate (flagged when it would exceed the monthly budget) and a **daily pacing** readout (how much of
today's budget is spent, and by what time), so overspend is visible before a gate trips. Spend is
**exportable** to CSV or JSON from the cost dashboard — line items (jobs plus one-shot agent calls) or
aggregates by repo/model, scoped to a date range and repo, with totals that reconcile with the dashboard.

### 📊 Proactive OAuth usage gauges

The agents stream their subscription-quota state on every run Drydock already parses, so the dashboard
warns *before* a job hits the wall. A navbar pill and a right-rail card show, per provider, how much of the
window is left and when it resets, escalating tone toward the cap and folding the reactive parked state in
as the terminal "limited" case. Codex (issue #189) reports exact `used_percent` for its 5-hour and weekly
windows; Claude (issue #188) reports its qualitative subscription tier. Both degrade to "usage unknown"
when the CLI reports nothing, and only numbers are persisted — never raw output. The forward-looking
complement to the reactive `waiting_limit` latch.

---

## Notifications & visibility

### 📡 Live logs over SSE

The agent's NDJSON output is parsed incrementally, persisted, and streamed to the browser in real time.

### 🔔 External notifications

Get pinged on Telegram, Slack (incoming webhook) and email (SMTP) for the lifecycle events you care about
(job needs human, job failed, PR opened, PR merged, release published, daily cost limit reached,
credentials expired/restored, automation paused/draining). Each channel is configured independently, every
event has a per-event opt-in, and a one-click test button verifies setup. Delivery is best-effort and never
blocks the loop; secrets are redacted from logs. See [ADR 024](adr/024-external-notifications.md).

### 🙋 Needs-human visibility on the issue

Whenever a job parks for a human (timeout, cost cap, non-zero exit, ADR gate, empty diff, exhausted CI
retries, merge conflict, …), Drydock makes it visible on the forge issue itself, not just the dashboard:
it sets the repo's needs-human label, drops the queue label, and posts a comment with the reason. The
comment is idempotent (a requeued job edits the same comment instead of stacking new ones) and every forge
call is best-effort, so a forge hiccup never changes the parked job's outcome.

### 🧵 Readable issue threads

Every Drydock lifecycle comment is idempotent: triage, post-PR verification, PR audit, merge-conflict park
and needs-human each carry a hidden per-job (or per-issue) marker, so a re-run — or a job worked twice —
edits one comment in place instead of stacking a wall of bot comments. Verbose bodies collapse behind
`<details>`, and a per-repo **Quiet issue comments** toggle suppresses the purely-informational notes (the
auto-triage label note and the verification summary, both mirrored by labels/status already on the issue)
while always keeping the high-signal ones. Builds on the [ADR 019](adr/019-pr-review-feedback.md) marker
pattern.

### 🔑 Credential watchdog

Periodic auth probes (on startup, then every 15 minutes) catch expired credentials *before* the queue dies
overnight: `gh auth status` for GitHub repos, a cheap authenticated API call per configured GitLab base
URL, and the agent CLIs. On failure a persistent navbar banner names the dead credential, a notification
fires once per outage, and new job starts are gated while in-flight jobs finish; the next healthy probe
resumes the queue automatically — no manual toggle. Only definitive auth failures (non-zero `gh auth
status`, HTTP 401/403, missing CLI/key) trip the gate; network hiccups, 5xx and timeouts never pause the
queue, and the GitHub probe yields to the rate-limit governor so it never burns budget jobs are waiting on.

---

## Surfaces

### 🖥️ Native menu-bar shell (macOS)

An optional [Tauri](https://tauri.app) desktop app wraps the dashboard and adds a tray with live counts
(active / queued / needs-human) and quick toggles for global pause/resume and drain mode, so the dock is
glanceable without a browser tab. It drives the server over HTTP-only control endpoints and keeps the
loopback-only model. See [Desktop app](../README.md#desktop-app) and
[ADR 036](adr/036-desktop-menu-bar-shell.md).

### 👋 First-run onboarding

A fresh install is greeted by a welcome checklist that verifies everything Drydock needs in one place:
each agent CLI (driven off the agent registry, so a newly added provider like `opencode` appears
automatically) with its install + sign-in status, the GitHub (`gh`) and GitLab (`glab` / API token)
clients, plus git and a configured repository. Every item carries a plain-language "what is this / why"
blurb, a live status badge (ready / needs attention / missing), and a one-click link to the right
install/auth docs in a new tab. A **Re-check** re-runs every probe live; **Skip** dismisses it. It
auto-opens only until finished or dismissed (persisted in settings), and stays reachable any time from
**Settings → Setup & diagnostics**. Probes are honest — only a definitive failure (CLI absent, `gh auth
status` non-zero, a rejected key) shows red; transient network errors never raise a false alarm.

### 🆙 Update-available notice

A passive, dismissible navbar banner appears when a newer Drydock release is published. The check queries
the latest stable GitHub release (drafts/prereleases skipped), is cached for an hour, and dedupes
concurrent checks onto a single upstream call; any network or parse error advertises no update, so a
transient hiccup never raises a false alarm. Global installs get a `drydock update` hint.

### 📐 ADR review queue

A file watcher surfaces new `docs/adr/*.md` decisions for approve/reject.

### 🎨 Polished UX

Light/dark theme, confirm dialogs on destructive actions, toast feedback, and accessible primitives. Open modals lock background scroll and mark the rest of the page `inert`, so the page behind never scrolls away and screen readers stay scoped to the dialog.

---

## Operations

### Backups & restore

`drydock backup [path]` writes a consistent SQLite snapshot (default target `<data
dir>/backups/`, never prunes); `drydock restore <path>` rolls back — it refuses while a drydock
instance is running and clears stale WAL/SHM sidecars. Both are WAL-aware via better-sqlite3's
native `.backup()`, so a backup taken under a live server is still consistent. From a source
checkout, `pnpm backup` writes into `data/backups/` and prunes anything older than 7 days
(schedule it daily via cron/launchd).

### Diagnostics — `drydock doctor`

Prints one line per probe (gh auth, claude/codex CLIs, GitLab token validity per configured base
URL, free disk space at the data dir, `PRAGMA integrity_check`, instance lock) and exits non-zero
on any failed probe, so it drops straight into cron/CI scripts.

### Health endpoint

`GET /api/health` returns a machine-readable liveness snapshot for Uptime-Kuma/Prometheus probes:
`status` (`ok`/`degraded`) with `reasons`, `version`, `uptimeSeconds`, `driver` (whether this
instance holds the driver lock, paused/draining flags, last tick timestamp), `queue` (job counts
per state), `budget` (today's spend vs the daily limit), and `github` (per-resource GitHub API
rate-limit budget for `core`/`graphql` — `remaining`, `limit`, ISO-8601 `reset`, and a `gated` flag
when background sweeps are being deferred; `null` per resource until one is observed, issue #408).
HTTP 200 while the driver loop ticks; 503 when the loop is stalled (no tick within 3 poll intervals),
not running, or the DB is unreachable. Read-only and secret-free — the `github` section is read from
the in-process governor with no forge call, so it survives even a `db_unreachable` degrade.

### Tick watchdog

Every scheduler tick races a hard deadline (`maxTickSeconds`, default 120s; 0 disables). A single
hung tick — e.g. a `gh` call stalling on a dead connection with an expired token — is abandoned at
the deadline, the loop reschedules, and queued jobs keep being claimed, so a wedged loop self-heals
once GitHub is reachable again instead of needing a manual restart.

### Control endpoints

`POST /api/control/pause` (`{ "paused": boolean }`) and `POST /api/control/drain` (`{ "draining":
boolean }`) flip global pause/resume and drain mode over HTTP, so the desktop shell and local
scripts can toggle automation without the dashboard. Both require a custom `x-drydock-control: 1`
header (a CSRF guard — a browser cannot forge it), and additionally a matching
`x-drydock-control-token` when `DRYDOCK_CONTROL_TOKEN` is set. See
[ADR 036](adr/036-desktop-menu-bar-shell.md).

### Host/Origin guard

Loopback binding stops non-loopback network connections, but not DNS rebinding: a page open in the
operator's browser can rebind an attacker hostname to `127.0.0.1` and query the unauthenticated GET
API surface (dashboard SSE, job SSE, cost export, health) from its own script. `src/proxy.ts` rejects
any `/api/*` GET/HEAD request whose `Host` (and, if present, `Origin`) isn't `127.0.0.1`, `localhost`,
`[::1]`, or the host configured via `DRYDOCK_ALLOW_REMOTE`'s `--host`, with `403`. Mutating routes are
unaffected (they already authenticate themselves) and normal browser access is unaffected. See
[ADR 041](adr/041-dns-rebinding-guard.md).

### Background daemon

`drydock start` launches the server detached from the terminal and returns immediately, so closing
the shell or losing the SSH session no longer kills it. `drydock status` reports whether it is
running (pid, url, uptime; exit 3 when stopped), `drydock stop` shuts it down gracefully — draining
in-flight jobs first — and `drydock restart` does both. It works identically on macOS, Windows, and
Linux: stop asks the server to drain over a loopback control endpoint (the only portable mechanism
on Windows, which has no usable POSIX signals) and only falls back to a signal if that endpoint is
unreachable. Single-instance: starting while a daemon already runs is refused, and a stale state
file left by a crash is taken over. Daemon state lives in `<data dir>/daemon.json` and the detached
process logs to `<data dir>/drydock.log`.

### Run at login

`drydock service install` generates and loads a launchd agent (macOS) or systemd user unit (Linux)
that runs `drydock serve` at login and restarts it on crashes; `drydock service uninstall` removes
it. (For an ad-hoc background run without a login service, use `drydock start`.)

### Retention & pruning

Finished jobs' verbose log events are pruned past the **log retention** window (default 30 days;
cost summary rows are kept). A daily in-process sweep runs automatically; for a manual run use
`pnpm db:prune [--days <n>] [--no-vacuum]`, which deletes expired events and runs `VACUUM` to
reclaim disk. See [ADR 023](adr/023-log-retention-and-pruning.md).

### Secret redaction

GitHub/GitLab tokens, `Bearer`/`Basic` values, Anthropic/OpenAI API keys, and Telegram bot tokens
echoed in agent output are scrubbed before any log event is persisted or streamed.
