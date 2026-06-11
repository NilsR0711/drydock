import { classifyOpenRouterFailure } from "./openrouter-limits";
import type { AgentProvider } from "./types";

/**
 * OpenRouter as a third agent (issue #169, ADR 032). Unlike claude/codex this
 * provider executes over HTTP — there is no CLI to spawn, so every CLI-shaped
 * method either returns the interface's documented "unsupported" value (null)
 * or fails fast. Call sites dispatch on `kind === "http"` before touching the
 * CLI surface; the actual execution lives in src/lib/openrouter/ (one-shot
 * runner and tool-loop session).
 */

const HTTP_ONLY =
  "openrouter is an HTTP provider; it has no CLI surface (dispatch on provider.kind)";

export const openrouterProvider: AgentProvider = {
  id: "openrouter",
  kind: "http",
  label: "OpenRouter",
  // No CLI binary: the empty command makes any accidental spawn fail loudly.
  defaultCommand: "",
  supportsResume: false,
  resumeModel: "",
  // Not dead despite supportsResume=false: the HTTP "resume" runs a fresh
  // tool-loop with the fix prompt, and this is that run's turn budget.
  resumeMaxTurns: 20,
  // No static default: OpenRouter models come from the synced catalog, the
  // effective model resolves from job → repo → settings.openrouterDefaultModel.
  defaultModel: "",
  buildStartArgs(): string[] {
    throw new Error(HTTP_ONLY);
  },
  buildResumeArgs(): string[] | null {
    return null; // no resume — CI retries fall back to a fresh context
  },
  buildOneShotArgs(): string[] {
    throw new Error(HTTP_ONLY);
  },
  buildStreamOneShotArgs(): string[] | null {
    return null;
  },
  createParser() {
    throw new Error(HTTP_ONLY);
  },
  classifyFailure: classifyOpenRouterFailure,
  /**
   * Always 0: OpenRouter cost comes from the stream's usage accounting
   * (usage.cost is exact USD); the session runner falls back to catalog
   * pricing when a stream dies before reporting usage. A static table here
   * would drift from the live catalog.
   */
  estimateCost(): number {
    return 0;
  },
};
