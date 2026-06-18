import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Worktree-relative path the agent writes to file follow-up issues for work it
 * consciously left out of scope (issue #261). Mirrors the `.drydock/PR.md`
 * (`pr-metadata.ts`) and `.drydock/QUESTIONS.md` (`questions-metadata.ts`)
 * convention: Drydock reads the entries, opens a real issue for each, then
 * removes the file so the scratch never lands in the commit.
 *
 * Format: one `## <title>` heading per follow-up; everything until the next
 * heading is that entry's body. A headless agent under `acceptEdits` cannot run
 * `gh issue create` (the call blocks on an approval that never comes), so this
 * file is its only path to spin off tracked work.
 */
export const FOLLOWUPS_METADATA_PATH = join(".drydock", "FOLLOWUPS.md");

/** A single agent-authored follow-up issue: a title (issue summary) and body. */
export interface FollowupIssue {
  title: string;
  body: string;
}

// Bound the agent-authored text and entry count so a pathological file cannot
// open an unbounded number of issues or blow GitHub's title/body limits. The
// title is hard sliced (an issue title reads cleanly without a marker); the
// body keeps a truncation marker so a reader knows it was cut — matching
// `parsePrMetadata`.
const TITLE_MAX_CHARS = 300;
const BODY_MAX_CHARS = 60_000;
const MAX_ENTRIES = 20;

const HEADING = /^##\s+(.*)$/;

/**
 * Parse the raw `.drydock/FOLLOWUPS.md` contents into follow-up entries. Each
 * `## <title>` heading starts an entry; the lines until the next heading are its
 * body. Headings with no title text are skipped, duplicate titles collapse to
 * their first occurrence, and the list is capped at `MAX_ENTRIES`. Returns an
 * empty list when there is no usable heading, so callers treat it as "nothing to
 * file".
 */
export function parseFollowups(raw: string): FollowupIssue[] {
  const entries: FollowupIssue[] = [];
  const seen = new Set<string>();
  let title: string | null = null;
  let bodyLines: string[] = [];

  const flush = (): void => {
    if (title === null) return;
    if (title !== "" && !seen.has(title) && entries.length < MAX_ENTRIES) {
      seen.add(title);
      const body = bodyLines.join("\n").trim();
      const cappedBody =
        body.length > BODY_MAX_CHARS ? `${body.slice(0, BODY_MAX_CHARS)}\n… (truncated)` : body;
      entries.push({ title, body: cappedBody });
    }
    title = null;
    bodyLines = [];
  };

  for (const line of raw.split("\n")) {
    const match = line.match(HEADING);
    if (match) {
      flush();
      title = (match[1] ?? "").trim().slice(0, TITLE_MAX_CHARS);
    } else if (title !== null) {
      bodyLines.push(line);
    }
  }
  flush();
  return entries;
}

/** Read and parse `.drydock/FOLLOWUPS.md` from a worktree, or [] if absent. */
export function readFollowups(worktreePath: string): FollowupIssue[] {
  let raw: string;
  try {
    raw = readFileSync(join(worktreePath, FOLLOWUPS_METADATA_PATH), "utf8");
  } catch {
    return [];
  }
  return parseFollowups(raw);
}

/**
 * Read and parse `.drydock/FOLLOWUPS.md`, then remove the file so it is excluded
 * from the commit Drydock makes (mirrors `consumePrMetadata`). The file is
 * deleted whenever it exists, even if it held no entries, so leftover scratch
 * never lands in the PR. Returns the parsed entries, or [] when absent/unusable.
 */
export function consumeFollowups(worktreePath: string): FollowupIssue[] {
  const entries = readFollowups(worktreePath);
  rmSync(join(worktreePath, FOLLOWUPS_METADATA_PATH), { force: true });
  return entries;
}
