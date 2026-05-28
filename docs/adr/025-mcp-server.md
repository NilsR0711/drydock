# ADR 025: Expose Drydock over a local stdio MCP server

- **Status:** accepted
- **Date:** 2026-05-28

## Context

Drydock is operated through its dashboard. Exposing its capabilities over the
Model Context Protocol (MCP) lets any MCP host — Claude Desktop, or a
higher-level orchestrating agent — drive Drydock directly: list repos, queue and
dequeue issues, inspect/requeue/abort jobs, and control system state, without
speaking the dashboard's HTTP. See issue #21.

## Decision

Ship a local **stdio** MCP server that wraps the existing service layer, adding
no business logic of its own.

### 1. Transport & entrypoint

The server runs over stdio (`StdioServerTransport`), launched by a small CLI:
`drydock mcp` (via the new `drydock` bin) or `pnpm mcp`. stdio is a
process-local transport — no socket is opened — so the server is reachable only
by the parent MCP host on the same machine. This satisfies the localhost-only
requirement by construction; there is no HTTP/TCP surface to bind or firewall.

`src/lib/cli.ts` holds an injectable `runCli(argv, deps)` dispatcher (tested
without real stdio); `scripts/drydock.ts` is the thin executable that forwards
`process.argv` and keeps stdout clean for the host (diagnostics go to stderr).

### 2. Tool registry (`src/lib/mcp/tools.ts`)

The 15 initial tools are a flat registry of typed handlers, each declaring a Zod
input shape and returning plain JSON-serialisable data:

- **Repos:** `list_repos`, `add_repo`, `sync_repo_issues`
- **Issues:** `list_issues`, `add_to_queue`, `remove_from_queue`, `set_issue_labels`
- **Jobs:** `list_jobs`, `get_job`, `requeue_job`, `abort_job`
- **System:** `get_settings`, `update_settings`, `set_drain_mode`, `get_logs`

Every handler routes through an existing service-layer function (`listRepos`,
`addRepo`, `listIssues`, `listJobs`, `transitionJob`, `getSettings`,
`saveSettings`, `setDrainMode`, the broker's `replay`, …). The forge
orchestration the dashboard actions used to own (ensure-label → add/remove
labels → cache; fetch → reconcile) was first extracted into reusable
`issues/service.ts` functions (`queueIssue`, `dequeueIssue`, `applyIssueLabels`,
`syncRepoIssues`) so the actions and the MCP server share one source of truth.

`src/lib/mcp/server.ts` wires the registry onto `McpServer.registerTool`:
results are serialised to a text block; a thrown handler error becomes an MCP
tool error (`isError`) with a clean message rather than a transport failure.

### 3. Safety — same gates as the UI

Work-initiating tools (`add_to_queue`, `requeue_job`) call `assertWorkAllowed`,
which mirrors the driver loop's gate: it refuses while the orchestrator is
**draining**, globally **paused**, over the **daily cost limit**, or the repo is
over **its own limit**. Read-only and recovery tools (`get_settings`,
`update_settings`, `set_drain_mode`) are intentionally never gated, so an
operator can always un-pause or un-drain through the host.

`get_settings`/`update_settings` redact credential fields
(`telegramBotToken`, `slackWebhookUrl`, `smtpPass`) to `***`, and
`update_settings` only accepts an operational subset — credentials cannot be set
over MCP at all.

## Consequences

- Any MCP host can operate Drydock locally with no HTTP; the dashboard and the
  MCP server share the same DB, orchestrator and single-instance lock.
- Adds the `@modelcontextprotocol/sdk` runtime dependency. The MCP modules are
  not reachable from the Next.js app graph, so they add nothing to the web
  bundle.
- New tools are a single registry entry wrapping a service function; the server,
  CLI and gate paths need no changes.
