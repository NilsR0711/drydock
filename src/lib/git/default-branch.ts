import { type CommandRunner, spawnRunner } from "@/lib/exec/runner";

/**
 * Last-resort branch when a clone exposes no detectable default (e.g. a brand
 * new repo with no commits and no remote). Matches the DB column default.
 */
export const DEFAULT_BRANCH_FALLBACK = "main";

/** Run a `git -C <repoPath> …` and return trimmed stdout, or null on any failure. */
async function tryGit(
  run: CommandRunner,
  repoPath: string,
  args: string[],
): Promise<string | null> {
  try {
    const res = await run("git", ["-C", repoPath, ...args]);
    if (res.exitCode !== 0) return null;
    return res.stdout.trim() || null;
  } catch {
    // No git binary, or the path is not a usable repository — let the caller fall back.
    return null;
  }
}

/**
 * Detect a local clone's default branch so repos on `master` (or anything other
 * than `main`) work without manual configuration (issue #210).
 *
 * Resolution order, all offline and forge-agnostic:
 *  1. `origin/HEAD` symbolic ref — set by `git clone`, yields e.g. `origin/master`.
 *  2. The currently checked-out branch — for a fresh clone this is the remote
 *     default; for an established working copy it is at least a real branch.
 *  3. {@link DEFAULT_BRANCH_FALLBACK}.
 */
export async function detectDefaultBranch(
  repoPath: string,
  run: CommandRunner = spawnRunner,
): Promise<string> {
  const head = await tryGit(run, repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) {
    const branch = head.replace(/^origin\//, "");
    if (branch) return branch;
  }
  // `--abbrev-ref HEAD` prints the literal "HEAD" on a detached checkout; that
  // is not a branch we can base worktrees on, so treat it as undetectable.
  const current = await tryGit(run, repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current && current !== "HEAD") return current;
  return DEFAULT_BRANCH_FALLBACK;
}

/**
 * Resolve the default branch for a repo being added: honor an explicit
 * (non-blank) value, otherwise detect it from the local clone (issue #210).
 */
export async function resolveDefaultBranch(
  input: { path: string; defaultBranch?: string | null },
  run: CommandRunner = spawnRunner,
): Promise<string> {
  const explicit = input.defaultBranch?.trim();
  if (explicit) return explicit;
  return detectDefaultBranch(input.path, run);
}
