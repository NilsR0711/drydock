# ADR 033: Opt-in sandboxed agent execution in a container

- **Status:** accepted
- **Date:** 2026-06-18

## Context

Agent sessions run directly on the host in a per-job git worktree with the CLI
in `--permission-mode acceptEdits` (ADR 004/006). With auto-process enabled on a
public repo, a crafted issue body becomes a prompt-injection vector that can
reach the host through the test/build scripts the agent legitimately runs:
`pnpm test`, `make`, a `postinstall`, an arbitrary `run_command` tool call. The
author-association gate (ADR 016) narrows *who* can trigger a job but does not
constrain *what* a triggered job can touch — once the agent runs, it has the
orchestrator user's full filesystem and network access.

An opt-in container mode is the strongest isolation story available without
re-architecting execution, and is the first control security-conscious
operators ask for (issue #182). It is architecturally significant: it
introduces a security boundary around the most privileged part of the system
and a hard external platform dependency (a container runtime), with real
macOS/Linux variance — hence this ADR.

## Decision

Add a **per-repo opt-in `sandbox` mode** (`none` | `docker`, default `none`).
When `docker`, the agent CLI session for that repo runs **inside a container**
instead of directly on the host. Off by default; with it off, execution is
byte-for-byte the pre-#182 behavior.

### 1. The bind-mounted worktree is the only writable host path

The job's worktree is bind-mounted at a fixed in-container workdir
(`/workspace`) and is the container's working directory. Nothing else on the
host is writable from inside. The agent reads and writes the repository through
the mount, so the host-side `commitAndPush` (ADR 004) sees its changes exactly
as today. This directly satisfies the acceptance criterion that the agent
"cannot read host paths outside the worktree mount."

### 2. The orchestrator still owns git, so no host keys enter the container

Commit and push happen on the **host** after the session ends (unchanged). The
container never needs the host's SSH keys or git remote credentials, so none
are mounted. This keeps the most dangerous secret class entirely outside the
sandbox.

### 3. Minimal, read-only auth passthrough

The agent CLI still needs its own credentials to call its model API. Only the
minimum is mounted, **read-only**: the agent's config dir (`~/.claude` /
`~/.claude.json` for Claude, `~/.codex` for Codex) and, when present in the
orchestrator environment, a `GH_TOKEN`/`GITHUB_TOKEN` passed as an env var (the
agent reads issues; it never pushes). Each mount is added only if the host path
exists, so a Codex repo does not fail because a Claude config is absent.

### 4. Image selection: repo override → devcontainer.json → configurable default

The container image is resolved per job: an explicit per-repo image wins; else
the repo's `.devcontainer/devcontainer.json` (or `.devcontainer.json`) `image`
field if present; else a global default image setting. The image is the
operator's responsibility and **must** carry the agent CLI plus the repo's
toolchain — the ADR documents this rather than shipping a magic image that
would silently be wrong. If no image can be resolved, the job fails preflight
with a clear reason rather than spawning a broken container.

### 5. Isolation knobs: network off by default, optional CPU/memory caps

The container runs with `--network none` unless the repo opts into network
access (some toolchains fetch dependencies during tests). Optional `--cpus` and
`--memory` caps bound a runaway session's blast radius. `--init` runs a
real PID 1 inside the container so the agent's grandchildren (test runners, dev
servers) are reaped rather than orphaned.

### 6. Reliable teardown: named container, force-removed on abort

The container is named deterministically per job (`drydock-job-<id>`) and run
with `--rm`. The existing wall-clock timeout and per-job cost cap (ADR 009,
issues #47/#57) and operator abort/emergency-stop all flow through the stream
runner's `abort`. The sandboxed runner extends `abort` to additionally
force-remove the named container (`<runtime> rm -f`), because SIGKILLing the
`docker run` *client* does not necessarily stop the container the daemon owns.
This satisfies the acceptance criterion that timeout/abort kill the container
reliably with no orphans, mirroring the process-group semantics of #171
conceptually.

### 7. Preflight detects the runtime and fails clearly when missing

Before a sandboxed session starts, the orchestrator probes for a usable runtime
(`docker`, then `podman`; an operator override pins one). If the sandbox is
requested but no runtime responds, the job transitions to `needs_human` with an
actionable message instead of failing opaquely at spawn time.

The seam is the injectable `StreamRunner` (ADR 004): a sandboxed runner wraps
the agent command/args into a `docker run …` invocation. `spawnAgentSession`
and the CI-fix/limit resumes are unchanged — they receive the wrapped runner
and a bare in-container command, so timeout, cost cap, abort registration,
limit gating, and usage persistence all keep working without sandbox-specific
branches in the session code.

## Consequences

- Security-conscious operators get a real isolation boundary for the riskiest
  surface (auto-processed public-repo issues), opt-in per repo.
- A new hard dependency exists *only* for sandboxed repos: a container runtime
  and an image that carries the agent CLI + toolchain. Both are the operator's
  responsibility; misconfiguration fails preflight with a clear message rather
  than silently.
- macOS/Linux variance is handled by the runtime itself (Docker Desktop / a
  Linux daemon / Podman); Drydock only shells out to the client, so no
  platform-specific code paths are needed.
- The container needs the agent CLI installed in the image — Drydock cannot
  inject the host binary, because the host path does not exist inside the
  container. The bare command name is run on the image's PATH.
- Network-off by default may break toolchains that fetch during tests; those
  repos opt into network access explicitly.
- Off by default: with `sandbox: none`, behavior is identical to before #182.

### Deliberate boundaries (first cut)

- **Only the implement and CI-fix/limit resume sessions are containerized.** These are the runs that write code and execute the repo's build/test scripts — the injection surface this ADR targets. The read-only one-shot passes (plan, verify, PR audit, decomposition) are *not* sandboxed here: decomposition and PR-question run at the driver-sweep level with no worktree to mount, and verify/audit run on a captured diff. Extending the sandbox to the worktree-backed one-shots (the plan stage) is a clean follow-up; it is intentionally out of scope for this first cut and called out so the boundary is not mistaken for total.
- **File ownership on Linux + rootful Docker.** A container running as root writes worktree files owned by root, which the host orchestrator user then cannot remove (worktree cleanup logs the failure but does not crash). Naively adding `--user <uid>:<gid>` would fix ownership but break the read-only auth mount (mode-600 config becomes unreadable to a different in-container identity) and the image's HOME/toolchain assumptions, so it is deliberately not forced. The recommended setups avoid the issue entirely: **rootless Podman** (maps the container root to the host user, so files are host-owned) or **Docker Desktop** (handles UID mapping in its VM); a devcontainer that defines a non-root user matching the host also works. This is documented rather than papered over.
