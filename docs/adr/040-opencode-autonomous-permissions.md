# ADR 040: opencode autonomous permission mapping

- **Status:** accepted
- **Date:** 2026-06-20
- **Supersedes:** [ADR 038 §4](038-opencode-cli-agent.md) (opencode's permissive defaults)

## Context

Drydock spawns agents **headless** — there is no human at the prompt. If an
agent stops to ask for a permission (a file edit, a shell command), the job
hangs forever: a hung prompt is a hung job. Every CLI agent must therefore be
told up front how much it may do without asking. Drydock models this per repo
via `bypassPermissions` (full, unprompted access, ADR 034 / issue #256) and an
`allowedCommands` allowlist (issue #329) — the safer middle ground that
pre-approves only specific shell commands while leaving everything else blocked.

claude maps these to `--dangerously-skip-permissions` vs `acceptEdits` +
`--allowedTools`; codex maps them to its `--sandbox` modes. ADR 038 §4 deferred
the equivalent for opencode, reasoning that opencode's defaults are already
permissive (`edit` and `bash` both `allow`), so headless work "just runs" and
the `allowedCommands` allowlist "does not apply." That reasoning has a hole
(issue #350):

- It conflates *"does not hang"* with *"is safe."* In the non-bypass path a repo
  owner who set `bypassPermissions: false` and an `allowedCommands` allowlist
  expects **only those commands** to run. opencode's permissive default instead
  grants **unrestricted bash**, silently defeating the allowlist's purpose.
- `external_directory` and `doom_loop` default to `ask`, not `allow`. Left
  alone they *can* still block a headless run — exactly the hang the design is
  meant to prevent.

## Decision

Map opencode onto the same two-mode permission model as claude/codex, with a
hard invariant: **opencode never waits on a permission prompt under either
mode.** A blocked action is always resolved to `allow` or `deny`, never `ask`.

### 1. Bypass path → `--dangerously-skip-permissions`

`bypassPermissions === true` keeps passing opencode's
`--dangerously-skip-permissions` flag (`buildStartArgs` / `buildResumeArgs`),
which auto-approves everything not explicitly denied — the direct `{"*":"allow"}`
equivalent. No env config is injected on this path; the flag covers it,
including the `ask`-default tools. As ADR 033 notes, the safest place to grant
full access is inside a Docker sandbox.

### 2. Non-bypass path → an injected `OPENCODE_PERMISSION` config

The orchestrator injects an inlined-JSON permission map into the spawned
opencode process via its environment (`opencodePermissionEnv` →
`agentSpawnEnv`), the autonomous-safety analogue of claude's `acceptEdits` +
`--allowedTools`:

```json
{
  "edit": "allow",
  "bash": { "*": "deny", "<cmd>": "allow", "<cmd> *": "allow", … },
  "external_directory": "deny",
  "doom_loop": "deny"
}
```

- **Edits** are auto-approved.
- Each `allowedCommands` entry becomes two bash `allow` rules — the bare command
  and the command with arguments — mirroring claude's `Bash(<cmd>:*)`.
- All other bash is **`deny`, not `ask`**: a non-allowlisted command fails fast
  instead of hanging. This is the safer middle ground — it does **not** grant
  the unrestricted bash opencode permits by default.
- `external_directory` and `doom_loop` (which default to `ask`) are pinned to
  `deny` for the same never-hang reason.
- opencode resolves rules last-match-wins, so the catch-all `"*": "deny"` is
  emitted first and the specific allow rules layered after it win. Every other
  tool keeps opencode's permissive (`allow`) default — reads never hang.

### 3. Side sessions inherit the same setting

The review-feedback, branch-janitor and deployment-healing side sessions already
thread the repo's `bypassPermissions` / `allowedCommands` into
`spawnAgentSession`, so they get the same env config as the main job — closing
the side-session bypass gap that was a real bug for claude (issue #328). One-shot
probes (issue decomposition) pass no permission context and keep opencode's
defaults: they only read and exit, so they neither need the restriction nor risk
a hang.

## Consequences

- A `bypassPermissions: true` repo runs an opencode job end-to-end with zero
  permission prompts (unchanged).
- A `bypassPermissions: false` repo with an `allowedCommands` list runs those
  commands without prompting **and without** granting full bash access — the
  allowlist is now honored for opencode, not ignored (reversing ADR 038 §4).
- **Behaviour change:** a non-bypass opencode repo with an *empty* allowlist can
  no longer run arbitrary bash (it is denied, not asked). This matches claude's
  model — non-bypass repos that need a build/test step must list it in
  `allowedCommands` or enable `bypassPermissions`. opencode was days old when
  this landed, so no established workflow depended on the prior full-bash default.
- The permission map is a partial override; opencode's built-in per-tool
  defaults still apply to unlisted tools, which are all `allow` reads — so the
  config cannot introduce a new hang.
