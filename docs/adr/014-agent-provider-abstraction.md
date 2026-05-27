# ADR 014: Pluggable agent providers (claude + codex)

- **Status:** accepted
- **Date:** 2026-05-27

## Context

Drydock was hardwired to the `claude` CLI: invocation flags, the `stream-json`
parser, and the cost model all assumed Claude Code. To let a repo (or job) be
processed by a different coding agent — starting with the OpenAI Codex CLI — the
agent-specific concerns had to move behind a single seam without regressing any
existing claude behavior.

## Decision

Introduce an `AgentProvider` interface (`src/lib/agents/types.ts`) that captures
everything agent-specific: `buildStartArgs` / `buildResumeArgs`, a
`createParser()` factory returning a normalized `StreamParser`, `estimateCost`,
and metadata (`defaultCommand`, `supportsResume`, `resumeModel`, `defaultModel`).
Two implementations exist:

- `claudeProvider` — a behavior-preserving move of the original logic. The
  SPEC §6.2/§6.3 invocations are byte-identical; `spawnClaudeSession` /
  `resumeClaudeSession` remain as thin wrappers that pin this provider.
- `codexProvider` — invokes `codex exec --json` (resume via
  `codex exec resume <thread_id>`), parses the JSONL event stream
  (`thread.started`, `item.completed`, `turn.completed`, `turn.failed`) into the
  same `ParsedEvent` shape, and prices tokens from `CODEX_PRICING`.

The orchestrator runs through a generic `agent-session.ts`
(`spawnAgentSession` / `resumeAgentSession`) that resolves the provider from
`jobs.agent` and the CLI path from settings. The agent is configurable per repo
(`repos.agent`, inherited by its jobs) with a global default
(`settings.defaultAgent`). A `checkAgent` preflight probes `<cli> --version` so a
missing/misconfigured CLI surfaces an actionable message instead of an opaque
spawn failure.

### Mappings & assumptions

- **Permissions:** claude's `--permission-mode acceptEdits` maps to codex's
  `--sandbox workspace-write` (auto-apply edits inside the worktree).
- **Resume:** both agents support session resume, so the CI-retry path is
  unchanged. Providers that cannot resume fall back to a fresh, context-less fix
  attempt (`buildResumeArgs` returns `null`).
- **Cost:** codex omits a USD cost from its stream, so cost is always estimated
  from token counts. `CODEX_PRICING` is dated and must be verified against the
  current rate card.
- **Worktree isolation** is agent-independent and unchanged.

## Consequences

- New agents are added by implementing one interface plus a pricing table and
  fixtures — no orchestrator changes.
- `ParsedEvent.raw` widened from the claude union to `unknown`; stream/logs,
  token and cost display work uniformly for every agent.
- Existing claude paths stay green and behavior-identical (regression-guarded by
  the original claude/resume tests, which still exercise the wrappers).
