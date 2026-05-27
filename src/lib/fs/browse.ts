import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

export interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export interface BrowseResult {
  path: string;
  /** null when `path` is a filesystem root. */
  parent: string | null;
  isGitRepo: boolean;
  entries: DirEntry[];
}

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/**
 * List the immediate subdirectories of `target` (default: home dir) for the
 * directory picker. Hidden folders and entries we cannot stat (permissions)
 * are skipped. Server-only: relies on node:fs, never reaches the client bundle.
 */
export function browseDirectory(target?: string): BrowseResult {
  const path = resolve(target?.trim() ? target : homedir());
  const entries: DirEntry[] = [];

  for (const name of safeReaddir(path)) {
    if (name.startsWith(".")) continue;
    const full = join(path, name);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue; // permission denied / vanished
    }
    entries.push({ name, path: full, isGitRepo: isGitRepo(full) });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  const atRoot = parse(path).root === path;
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
