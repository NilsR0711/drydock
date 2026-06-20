# ADR 038: opencode as a third CLI agent with provider/model ids

- **Status:** accepted
- **Date:** 2026-06-20

## Context

Drydock drives two local CLIs — `claude` and `codex` (ADR 014) — and an
HTTP-backed OpenRouter provider (ADR 032). Each CLI agent's models come from
the hardcoded `MODELS[]` catalog with hand-maintained pricing. Users want
"any model, any provider" without Drydock owning a catalog or HTTP tool loop:
[opencode](https://opencode.ai) (SST's open-source terminal coding agent) is a
spawned CLI with a non-interactive `run` mode that routes through
[models.dev](https://models.dev) to 75+ providers (Anthropic, OpenAI, Google,
local via Ollama/LM Studio, **and** OpenRouter) behind one `provider/model`
id (issue #349). It emits JSONL on `run --format json` — the same
incrementally-parseable shape the orchestrator already consumes for
Claude/Codex — and reports exact per-step USD cost and token usage natively.

This is the low-risk first step (Step 1) of issue #349. Retiring the custom
OpenRouter HTTP integration in favour of opencode+OpenRouter (Step 2) is
deliberately **out of scope** here: OpenRouter stays exactly as-is.

## Decision

Add **`opencode` as a fourth `AgentId`** — the **third CLI agent**, next to
`claude`/`codex` and alongside the HTTP-backed `openrouter` — reusing the
existing spawn/stream/cost machinery. Opt-in per repo like the others; no
behaviour change for existing repos.

### 1. CLI provider on the existing spawn path

`opencodeProvider` (`kind: "cli"`) builds `opencode run --format json --model
<provider/model> <prompt>` for a fresh session and `--session <id>` to resume.
It rides the same `spawnStreamRunner` → `spawnAgentSession` path as the other
CLIs, so wall-clock timeout (issue #47), abort registration, pre-spawn
limit-latch refusal, and job usage persistence all apply unchanged. Turn
budget is intentionally not passed: `opencode run` has no `--max-turns` flag
(like codex, issue #48); a runaway run is bounded by the wall-clock timeout.

### 2. JSONL parser with per-step cost/token accumulation

`OpencodeStreamParser` consumes the `type`-tagged JSONL events: `step_start`
(carries the resumable `ses_…` session id), `text` and `tool_use` parts
(normalized to the shared chunk shape), `step_finish` (per-API-call `cost` and
`tokens.{input,output,reasoning,cache.{read,write}}`), and `error`. opencode
reports cost/usage **per step**, so a multi-step tool loop is **summed** across
every `step_finish` — not assigned-last like Claude's single authoritative
`result` event. Reasoning tokens fold into output (billed as output, like
codex). Malformed lines are skipped via the shared `onParseError` hook (issue
#46). Only the terminal `step_finish` (`reason: "stop"`) surfaces as a single
`result` event.

### 3. Cost cap for free

Because the parser accumulates `costUsd` from the stream, the orchestrator's
existing generic per-job cost guard (`makeCostGuard`, issue #57) enforces the
budget against opencode with no new code — it already prices from
`parser.costUsd` when present. `provider.estimateCost` returns 0 by design: a
static pricing table would drift from the live models.dev catalog across 75+
providers (same rationale as OpenRouter, ADR 032 §4). Accumulating per step
also hardens cost against the known `run --format json` bug where the final
`step_finish` can be dropped — prior steps' costs are already counted.

### 4. Permissions: opencode's permissive defaults

opencode starts from permissive defaults (`edit` and `bash` both `allow`),
which already covers headless work inside the worktree, so no acceptEdits-style
flag is needed. `bypassPermissions` (the agent-driven release path, ADR 034 /
issue #256) adds `--dangerously-skip-permissions` to also auto-approve the few
`ask` permissions (e.g. `external_directory`). The per-repo command allowlist
(issue #329) does not apply — opencode allows bash by default — and is ignored.

### 5. Free-text provider/model ids; resume reuses the session model

opencode validates the model against models.dev itself at spawn time, so repo
`agent`/`defaultModel` validation only enforces the `provider/model` **shape**
(must contain `/`) rather than checking a static `MODELS[]` entry or a synced
catalog — there is no catalog sync in Step 1 (deferred). The UI offers a
free-text model field for opencode (vs the static dropdown / OpenRouter
catalog picker). Resume deliberately omits `--model` so the session continues
on its original provider/model — forcing one could resume on a provider the
user has not configured credentials for. The global `defaultAgent` stays a
static-catalog CLI agent (claude/codex), matching how OpenRouter is excluded
(ADR 032 §5); opencode is chosen per repo, where its model entry lives.

### 6. No usage-limit detection (yet)

opencode has no `classifyFailure`, so it never latches in the provider-limit
machinery (ADR 030); the limit-edge records are keyed by a `LimitAgentId`
subset rather than carrying a dead opencode entry. A failed opencode session
escalates generically to `needs_human`. Provider-limit gating and a model
catalog/picker for opencode are tracked as future work (issue #349 open
questions), not blockers for Step 1.

## Consequences

- Users reach "any model, any provider" (incl. OpenRouter, local models)
  through one externally-maintained agent, opt-in per repo.
- No DB migration: `agent` is a free-text column and `opencodePath` lives in
  the JSON settings blob.
- A fourth agent dimension exists everywhere `AgentId` flows; CLI-only
  surfaces that deliberately exclude it for now (global `defaultAgent`,
  PR-audit agent override) can adopt it later.
- Off by default: existing repos are byte-for-byte unchanged. OpenRouter is
  untouched — Step 2 (retiring the custom integration) remains a separate,
  independently-shippable decision.
- opencode usage limits are not auto-waited yet; such failures escalate to a
  human until limit detection is added.
