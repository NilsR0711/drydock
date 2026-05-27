import { CLAUDE_RESUME_MODEL, claudeProvider } from "@/lib/agents/claude";
import type { Job } from "@/lib/db/schema";
import {
  type AgentSessionDeps,
  type AgentSessionResult,
  resumeAgentSession,
  spawnAgentSession,
} from "./agent-session";

/**
 * Backward-compatible claude entry points. The orchestrator now drives agents
 * through the generic agent-session runner (see agent-session.ts); these thin
 * wrappers pin the claude provider so existing call sites and the SPEC §6.2/§6.3
 * invocations stay behavior-identical.
 */
export type ClaudeSessionDeps = AgentSessionDeps;
export type ClaudeSessionResult = AgentSessionResult;

/** SPEC §6.2 invocation. */
export function buildClaudeArgs(prompt: string, model: string, maxTurns: number): string[] {
  return claudeProvider.buildStartArgs({ prompt, model, maxTurns });
}

/** SPEC §6.3 CI-retry invocation: resume the session with Haiku, fewer turns. */
export function buildResumeArgs(
  prompt: string,
  sessionId: string,
  model = CLAUDE_RESUME_MODEL,
  maxTurns = 15,
): string[] {
  // claudeProvider always returns args (supportsResume); the assertion documents that.
  return claudeProvider.buildResumeArgs({ prompt, sessionId, model, maxTurns }) as string[];
}

export function spawnClaudeSession(
  job: Job,
  prompt: string,
  cwd: string,
  deps: ClaudeSessionDeps = {},
): Promise<ClaudeSessionResult> {
  return spawnAgentSession(job, prompt, cwd, { ...deps, provider: claudeProvider });
}

export function resumeClaudeSession(
  job: Job,
  sessionId: string,
  failedLog: string,
  cwd: string,
  deps: ClaudeSessionDeps = {},
): Promise<ClaudeSessionResult> {
  return resumeAgentSession(job, sessionId, failedLog, cwd, { ...deps, provider: claudeProvider });
}
