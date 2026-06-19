import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

export interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export interface BrowseResult {
  path: string;
  /** null when `path` is the browse root or a filesystem root. */
  parent: string | null;
  isGitRepo: boolean;
  entries: DirEntry[];
}

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/**
 * Canonicalize a path: resolve `..` segments AND symlinks. `resolve()` alone is
 * not enough for a containment check — it never follows symlinks, while the
 * readdir/stat calls below do, so a symlink inside the root could otherwise
 * smuggle an out-of-root directory past a lexical prefix check. A path that
 * cannot be canonicalized (e.g. it does not exist) keeps its lexical form; it
 * cannot escape because listing it yields nothing.
 */
function canonicalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Returns the configured browse root (always canonicalized, no trailing sep). */
function browseRoot(): string {
  const raw = process.env.DRYDOCK_BROWSE_ROOT?.trim();
  return canonicalize(resolve(raw || homedir()));
}

/**
 * Returns true iff `child` is equal to `root` or is a strict descendant of it,
 * using path-segment comparison to avoid `/home/user-evil` matching `/home/user`.
 */
function isWithinRoot(child: string, root: string): boolean {
  return child === root || child.startsWith(root + sep);
}

/**
 * List the immediate subdirectories of `target` (default: browse root) for the
 * directory picker. Hidden folders and entries we cannot stat (permissions)
 * are skipped. Server-only: relies on node:fs, never reaches the client bundle.
 *
 * Browsing is confined to `DRYDOCK_BROWSE_ROOT` (default: home directory).
 * Any path outside the root throws so the Server Action cannot be used as a
 * filesystem enumeration oracle. Both the target and the root are
 * canonicalized (symlinks resolved) before the containment check, and listed
 * entries whose symlink target escapes the root are skipped, so a symlink
 * inside the root cannot be used to enumerate directories outside it.
 */
export function browseDirectory(target?: string): BrowseResult {
  const root = browseRoot();
  const path = canonicalize(resolve(target?.trim() ? target : root));

  if (!isWithinRoot(path, root)) {
    throw new Error(
      `Path "${path}" is outside the browse root "${root}". ` +
        "Set DRYDOCK_BROWSE_ROOT to allow a different base directory.",
    );
  }

  const entries: DirEntry[] = [];

  for (const name of safeReaddir(path)) {
    if (name.startsWith(".")) continue;
    const full = join(path, name);
    try {
      // statSync/readdirSync follow symlinks, so confine by the entry's REAL
      // path: a symlink pointing outside the browse root is not listed. Stat the
      // already-resolved real path (not `full`) so the symlink is followed only
      // once — closing the TOCTOU window where it could be swapped between the
      // containment check and the stat.
      const real = realpathSync(full);
      if (!isWithinRoot(real, root)) continue;
      if (!statSync(real).isDirectory()) continue;
    } catch {
      continue; // permission denied / vanished / broken symlink
    }
    entries.push({ name, path: full, isGitRepo: isGitRepo(full) });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  // Suppress parent at or above the browse root.
  const atRoot = path === root;
  return {
    path,
    parent: atRoot ? null : dirname(path),
    isGitRepo: isGitRepo(path),
    entries,
  };
}

/** Suggested repo name from a path (its basename). */
export function suggestRepoName(path: string): string {
  return basename(resolve(path));
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
