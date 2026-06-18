import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Worktree-relative path an agent-driven release writes to report what it cut
 * (issue #256). Mirrors the `.drydock/PR.md` convention (`pr-metadata.ts`):
 * optional, best-effort. Drydock reads it to stamp the release run's
 * tag/title/notes for the panel, then removes the file. Absent or unusable just
 * means "no reported version" — the release itself already happened via the
 * agent's own commands.
 */
export const RELEASE_METADATA_PATH = join(".drydock", "RELEASE.md");

/** Agent-reported release outcome: the cut tag (if any), a title, and notes. */
export interface ReleaseMetadata {
  tag: string | null;
  title: string;
  notes: string;
}

// Bound the agent-authored text so a pathological file cannot produce an
// oversized title or notes blob. Matches the PR-metadata caps.
const TITLE_MAX_CHARS = 300;
const NOTES_MAX_CHARS = 60_000;

// A leading `Tag:`/`tag:` line names the cut tag explicitly.
const TAG_LINE = /^tag:\s*(\S+)\s*$/i;
// A title that itself looks like a semver tag (v1.2.3 / 1.2.3) doubles as the tag.
const VERSION_TITLE = /^v?\d+\.\d+\.\d+/;

/**
 * Parse the raw `.drydock/RELEASE.md` contents. The first `Tag:` line (if any)
 * names the cut tag; the first remaining non-blank line is the title; the rest
 * are the notes. A version-looking title with no explicit tag line is itself
 * used as the tag. Returns null when there is no usable title.
 */
export function parseReleaseMetadata(raw: string): ReleaseMetadata | null {
  let tag: string | null = null;
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    const match = line.match(TAG_LINE);
    if (match && tag === null) {
      tag = match[1] ?? null;
      continue;
    }
    lines.push(line);
  }

  let i = 0;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  if (i >= lines.length) {
    // Only a tag line, no title: still usable — title falls back to the tag.
    return tag ? { tag, title: tag, notes: "" } : null;
  }

  const title = (lines[i] ?? "").trim().slice(0, TITLE_MAX_CHARS);
  if (title === "") return null;
  if (tag === null && VERSION_TITLE.test(title)) tag = title;

  const notes = lines
    .slice(i + 1)
    .join("\n")
    .trim();
  const cappedNotes =
    notes.length > NOTES_MAX_CHARS ? `${notes.slice(0, NOTES_MAX_CHARS)}\n… (truncated)` : notes;
  return { tag, title, notes: cappedNotes };
}

/** Read and parse `.drydock/RELEASE.md` from a worktree, or null if absent/unusable. */
export function readReleaseMetadata(worktreePath: string): ReleaseMetadata | null {
  let raw: string;
  try {
    raw = readFileSync(join(worktreePath, RELEASE_METADATA_PATH), "utf8");
  } catch {
    return null;
  }
  return parseReleaseMetadata(raw);
}

/**
 * Read and parse `.drydock/RELEASE.md`, then remove the file (mirrors
 * `consumePrMetadata`). Best-effort: the file is deleted whenever it exists, so
 * leftover scratch never lingers in the throwaway worktree. Returns the parsed
 * metadata, or null when absent/unusable.
 */
export function consumeReleaseMetadata(worktreePath: string): ReleaseMetadata | null {
  const meta = readReleaseMetadata(worktreePath);
  rmSync(join(worktreePath, RELEASE_METADATA_PATH), { force: true });
  return meta;
}
