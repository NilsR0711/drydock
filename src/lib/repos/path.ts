import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * True when `path` is an existing directory that contains a `.git` entry —
 * either a `.git` directory (normal clone) or a `.git` file (a linked
 * worktree's gitdir pointer). Used to reject bogus paths at the MCP `add_repo`
 * boundary (issue #110) where a remote host could otherwise register a
 * non-repository directory.
 */
export function isGitRepoPath(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
  } catch {
    return false;
  }
  return existsSync(join(path, ".git"));
}
