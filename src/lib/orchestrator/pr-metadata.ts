import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Worktree-relative path the agent writes to describe its change for the PR
 * (issue #212). First non-blank line is the Conventional Commit subject / PR
 * title; the remainder is the structured PR body. Drydock consumes it, then
 * removes the file so it never lands in the commit.
 */
export const PR_METADATA_PATH = join(".drydock", "PR.md");

/** Agent-authored PR metadata: a commit subject / PR title plus a body. */
export interface PrMetadata {
  title: string;
  body: string;
}

// Bound the agent-authored text so a pathological file cannot produce an
// oversized commit subject or blow GitHub's PR-body limit. The title is hard
// sliced (a commit subject reads cleanly without a marker); the body keeps a
// truncation marker so a reader knows it was cut.
const TITLE_MAX_CHARS = 300;
const BODY_MAX_CHARS = 60_000;

/**
 * Parse the raw `.drydock/PR.md` contents into a title + body. Returns null when
 * there is no usable title (empty or whitespace-only), so callers fall back to
 * the issue-based defaults.
 */
export function parsePrMetadata(raw: string): PrMetadata | null {
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  if (i >= lines.length) return null;

  const title = (lines[i] ?? "").trim().slice(0, TITLE_MAX_CHARS);
  if (title === "") return null;

  const body = lines
    .slice(i + 1)
    .join("\n")
    .trim();
  const cappedBody =
    body.length > BODY_MAX_CHARS ? `${body.slice(0, BODY_MAX_CHARS)}\n… (truncated)` : body;
  return { title, body: cappedBody };
}

/** Read and parse `.drydock/PR.md` from a worktree, or null if absent/unusable. */
export function readPrMetadata(worktreePath: string): PrMetadata | null {
  let raw: string;
  try {
    raw = readFileSync(join(worktreePath, PR_METADATA_PATH), "utf8");
  } catch {
    return null;
  }
  return parsePrMetadata(raw);
}

/**
 * Read and parse `.drydock/PR.md`, then remove the file so it is excluded from
 * the commit Drydock makes (issue #212). The file is deleted whenever it
 * exists, even if its content did not parse, so leftover scratch never lands in
 * the PR. Returns the parsed metadata, or null when absent/unusable.
 */
export function consumePrMetadata(worktreePath: string): PrMetadata | null {
  const meta = readPrMetadata(worktreePath);
  rmSync(join(worktreePath, PR_METADATA_PATH), { force: true });
  return meta;
}
