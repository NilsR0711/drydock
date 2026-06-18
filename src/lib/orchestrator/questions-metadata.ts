import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Worktree-relative path the agent writes when it hits a decision only a human
 * can make (issue #251). Mirrors the `.drydock/PR.md` convention
 * (`pr-metadata.ts`): Drydock reads the questions, hands them to the human, then
 * removes the file so the scratch never lands in the preserved branch.
 */
export const QUESTIONS_METADATA_PATH = join(".drydock", "QUESTIONS.md");

// Bound the agent-authored text so a pathological file cannot blow GitHub's
// comment-body limit. The block keeps a truncation marker so a reader knows it
// was cut — matching `parsePrMetadata`'s body cap.
const QUESTIONS_MAX_CHARS = 60_000;

/**
 * Normalize the raw `.drydock/QUESTIONS.md` contents into a trimmed, length-
 * capped question block. Returns null when the file holds no usable text (empty
 * or whitespace-only), so callers treat it as "no open questions".
 */
export function parseQuestions(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return trimmed.length > QUESTIONS_MAX_CHARS
    ? `${trimmed.slice(0, QUESTIONS_MAX_CHARS)}\n… (truncated)`
    : trimmed;
}

/** Read and parse `.drydock/QUESTIONS.md` from a worktree, or null if absent/empty. */
export function readQuestions(worktreePath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(worktreePath, QUESTIONS_METADATA_PATH), "utf8");
  } catch {
    return null;
  }
  return parseQuestions(raw);
}

/**
 * Read and parse `.drydock/QUESTIONS.md`, then remove the file so it is excluded
 * from the branch Drydock preserves (mirrors `consumePrMetadata`). The file is
 * deleted whenever it exists, even if its content was empty, so leftover scratch
 * never lands in a commit. Returns the parsed questions, or null when
 * absent/empty.
 */
export function consumeQuestions(worktreePath: string): string | null {
  const questions = readQuestions(worktreePath);
  rmSync(join(worktreePath, QUESTIONS_METADATA_PATH), { force: true });
  return questions;
}
