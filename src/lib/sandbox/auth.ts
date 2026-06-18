import { join } from "node:path";
import type { AgentId } from "@/lib/agents/types";

/** A read-only host→container bind mount carrying agent credentials. */
export interface AuthMount {
  host: string;
  container: string;
}

export interface AuthPassthroughInput {
  agent: AgentId;
  /** The orchestrator user's home directory (where agent CLI config lives). */
  home: string;
  /** The orchestrator process environment, for the gh token passthrough. */
  env: Record<string, string | undefined>;
  /** Whether a host path exists; injectable so resolution is unit-testable. */
  exists: (path: string) => boolean;
}

export interface AuthPassthrough {
  /** Host paths to bind-mount read-only into the container (ADR 033 §3). */
  mounts: AuthMount[];
  /** Env var names to pass through (e.g. GH_TOKEN) — values come from the host. */
  env: string[];
}

/** Candidate (host-relative, container-absolute) auth paths per agent. */
function candidatesFor(agent: AgentId, home: string): AuthMount[] {
  switch (agent) {
    case "codex":
      return [{ host: join(home, ".codex"), container: "/root/.codex" }];
    case "openrouter":
      // HTTP provider: no CLI session is sandboxed, so no config mount applies.
      return [];
    default:
      return [
        { host: join(home, ".claude"), container: "/root/.claude" },
        { host: join(home, ".claude.json"), container: "/root/.claude.json" },
      ];
  }
}

/**
 * Resolve the minimum credential passthrough for a sandboxed session (ADR 033
 * §2–3): the agent CLI's own config mounted read-only, plus a gh token via env
 * when the orchestrator has one. Git push happens on the host, so no SSH keys
 * or git remotes ever enter the container. Only existing host paths are
 * mounted, so a Codex repo never fails because a Claude config is absent.
 */
export function resolveAuthPassthrough(input: AuthPassthroughInput): AuthPassthrough {
  const mounts = candidatesFor(input.agent, input.home).filter((m) => input.exists(m.host));

  const env: string[] = [];
  if (input.env.GH_TOKEN?.trim()) env.push("GH_TOKEN");
  else if (input.env.GITHUB_TOKEN?.trim()) env.push("GITHUB_TOKEN");

  return { mounts, env };
}
