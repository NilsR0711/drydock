/**
 * Per-repo custom agent instructions (issue #56).
 *
 * Operators can steer agent behavior per project — coding conventions, "always
 * run pnpm test", "don't touch legacy/", preferred PR style — via a free-text
 * field, without editing global prompts or code. The text is injected into the
 * issue-work prompt as a dedicated, length-capped section. Empty by default, so
 * unset repos see no change to their prompt.
 */

/** Upper bound on injected instruction characters, keeping the prompt bounded. */
export const AGENT_INSTRUCTIONS_MAX_CHARS = 4000;

/**
 * Build the fenced "Repository-specific agent instructions" prompt section.
 * Returns an empty string when there is nothing to inject (null/empty/blank),
 * leaving the prompt unchanged. Otherwise the (trimmed, length-capped) text is
 * wrapped in a clearly labelled section appended to the work prompt.
 */
export function agentInstructionsPromptSection(instructions: string | null | undefined): string {
  const trimmed = instructions?.trim();
  if (!trimmed) return "";
  const capped = trimmed.slice(0, AGENT_INSTRUCTIONS_MAX_CHARS);
  return [
    "",
    "",
    "## Repository-specific agent instructions",
    "",
    "The operator of this repository has provided the following instructions. Follow them",
    "in addition to the task above, unless they conflict with explicit safety constraints:",
    "",
    capped,
  ].join("\n");
}
