import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-repo release playbook memoization (issue #352).
 *
 * The agent-driven release (issue #256) re-investigates how a repo releases on
 * every run, which is expensive. To make runs 2+ cheap, a *clean* release writes
 * the corrected, up-to-date procedure to `.drydock/RELEASE_PLAYBOOK.md` (distinct
 * from `RELEASE.md`, which only reports this run's tag/title/notes). Drydock reads
 * that file, removes it, and persists it to `repos.release_playbook`. The next run
 * receives it via the `$RELEASE_PLAYBOOK` prompt variable and follows the known
 * steps with light verification instead of starting from scratch.
 *
 * The playbook holds commands/steps only — the prompt forbids secrets/tokens.
 */

/** Worktree-relative path the agent writes the recorded release procedure to. */
export const RELEASE_PLAYBOOK_PATH = join(".drydock", "RELEASE_PLAYBOOK.md");

/** Upper bound on stored/injected playbook characters, keeping the prompt bounded. */
export const RELEASE_PLAYBOOK_MAX_CHARS = 12_000;

/**
 * Parse raw `.drydock/RELEASE_PLAYBOOK.md` contents: the trimmed, length-capped
 * procedure, or null when there is nothing usable (absent/blank). An oversized
 * playbook is capped with a visible truncation marker so a pathological file
 * cannot bloat the prompt or the column.
 */
export function parseReleasePlaybook(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.length > RELEASE_PLAYBOOK_MAX_CHARS
    ? `${trimmed.slice(0, RELEASE_PLAYBOOK_MAX_CHARS)}\n… (truncated)`
    : trimmed;
}

/** Read and parse `.drydock/RELEASE_PLAYBOOK.md` from a worktree, or null if absent/unusable. */
export function readReleasePlaybook(worktreePath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(worktreePath, RELEASE_PLAYBOOK_PATH), "utf8");
  } catch {
    return null;
  }
  return parseReleasePlaybook(raw);
}

/**
 * Read and parse `.drydock/RELEASE_PLAYBOOK.md`, then remove the file (mirrors
 * `consumeReleaseMetadata`). Best-effort: the file is deleted whenever it exists,
 * so leftover scratch never lingers in the throwaway worktree. Returns the parsed
 * playbook, or null when absent/blank.
 */
export function consumeReleasePlaybook(worktreePath: string): string | null {
  const playbook = readReleasePlaybook(worktreePath);
  rmSync(join(worktreePath, RELEASE_PLAYBOOK_PATH), { force: true });
  return playbook;
}

/**
 * Build the `$RELEASE_PLAYBOOK` injection value for the release prompt. With no
 * recorded playbook (null/blank), instruct a from-scratch investigation; with one,
 * embed it under a follow-and-verify-each-step instruction so the agent reuses the
 * known procedure but still catches a drifted step.
 */
export function releasePlaybookPromptValue(playbook: string | null | undefined): string {
  const trimmed = playbook?.trim();
  if (!trimmed) {
    return "No release playbook has been recorded for this repository yet — investigate the release mechanism from scratch (step 1 below).";
  }
  return [
    "A release playbook was recorded from a previous successful release of THIS repository.",
    "Follow it step by step, verifying that each step still applies before relying on it; only",
    "re-investigate a step that no longer matches what you observe:",
    "",
    trimmed,
  ].join("\n");
}
