/**
 * Opt-in bridge to claude-mem's "worktree adoption" (issue #274).
 *
 * claude-mem keys memory per git worktree: a Drydock job session running inside
 * `.claude/worktrees/<name>` stores its observations under the project key
 * `<repo>/<worktree-name>`, not the parent repo. claude-mem already ships an
 * `adopt` command that migrates a merged worktree's memory into the parent
 * project — but its background scan only sees *live* worktrees, and Drydock
 * removes the worktree the moment a job settles. So adoption almost never fires.
 *
 * This module invokes that `adopt` command for a job's worktree right before
 * Drydock removes it, while the worktree still exists. It is strictly
 * best-effort: a missing plugin, a spawn failure, or a non-zero exit is logged
 * and swallowed so it can never block or fail worktree cleanup.
 *
 * There is no stable `claude-mem` bin on PATH; the plugin is invoked the way
 * claude-mem's own hooks do — `node <root>/scripts/bun-runner.js
 * <root>/scripts/worker-service.cjs adopt …` — with the plugin root resolved
 * from the versioned cache dir (newest first), falling back to the marketplace
 * checkout.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CommandRunner, spawnRunner } from "@/lib/exec/runner";
import { logError } from "@/lib/log/logger";

/** Wall-clock bound for the adopt subprocess; it must not stall job cleanup. */
const ADOPT_TIMEOUT_MS = 60_000;

/** The default Claude config dir, overridable for tests and `CLAUDE_CONFIG_DIR`. */
function defaultConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/** Descending semver-ish comparison so the newest version dir sorts first. */
function compareVersionDesc(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
}

/** A candidate root holds the plugin directly, or nests it under `plugin/`. */
function normalizeRoot(root: string): string {
  return existsSync(join(root, "plugin", "scripts")) ? join(root, "plugin") : root;
}

/** Both scripts must be present for the worker invocation to succeed. */
function hasWorkerScripts(pluginDir: string): boolean {
  return (
    existsSync(join(pluginDir, "scripts", "bun-runner.js")) &&
    existsSync(join(pluginDir, "scripts", "worker-service.cjs"))
  );
}

/**
 * Resolve the claude-mem plugin directory that holds `scripts/bun-runner.js`
 * and `scripts/worker-service.cjs`, mirroring claude-mem's own hook resolution:
 * an explicit `CLAUDE_PLUGIN_ROOT`/`PLUGIN_ROOT` override wins, then the newest
 * cached version, then the marketplace checkout. Returns `null` when claude-mem
 * is not installed (or its scripts are incomplete).
 */
export function resolveClaudeMemPlugin(configDir: string = defaultConfigDir()): string | null {
  const candidates: string[] = [];

  const envRoot = process.env.CLAUDE_PLUGIN_ROOT ?? process.env.PLUGIN_ROOT;
  if (envRoot) candidates.push(envRoot);

  const cacheDir = join(configDir, "plugins", "cache", "thedotmack", "claude-mem");
  if (existsSync(cacheDir)) {
    let versions: string[] = [];
    try {
      versions = readdirSync(cacheDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d/.test(e.name))
        .map((e) => e.name)
        .sort(compareVersionDesc);
    } catch {
      versions = [];
    }
    for (const version of versions) candidates.push(join(cacheDir, version));
  }

  candidates.push(join(configDir, "plugins", "marketplaces", "thedotmack", "plugin"));

  for (const root of candidates) {
    const pluginDir = normalizeRoot(root);
    if (hasWorkerScripts(pluginDir)) return pluginDir;
  }
  return null;
}

export interface AdoptOptions {
  /** Resolve the plugin dir; injectable for tests. */
  resolvePlugin?: (configDir?: string) => string | null;
  /** Run the adopt subprocess; injectable for tests. Defaults to {@link spawnRunner}. */
  run?: CommandRunner;
  /** Config dir passed to the resolver; defaults to `CLAUDE_CONFIG_DIR`/`~/.claude`. */
  configDir?: string;
  /** Wall-clock bound for the subprocess. */
  timeoutMs?: number;
}

/**
 * Best-effort: trigger claude-mem adoption for a job's worktree before it is
 * removed. `adopt` checks the merge condition itself, so an unmerged branch is
 * a safe no-op — Drydock calls it unconditionally and lets claude-mem decide.
 * Never throws: a missing plugin, spawn failure, or non-zero exit is logged.
 */
export async function adoptWorktreeMemory(
  input: { branch: string; cwd: string },
  opts: AdoptOptions = {},
): Promise<void> {
  const resolvePlugin = opts.resolvePlugin ?? resolveClaudeMemPlugin;
  const run = opts.run ?? spawnRunner;
  try {
    const pluginDir = resolvePlugin(opts.configDir);
    if (!pluginDir) {
      logError(`[claude-mem] adoption skipped for ${input.branch}: plugin not installed`);
      return;
    }
    const args = [
      join(pluginDir, "scripts", "bun-runner.js"),
      join(pluginDir, "scripts", "worker-service.cjs"),
      "adopt",
      "--branch",
      input.branch,
      "--cwd",
      input.cwd,
    ];
    const result = await run("node", args, input.cwd, {
      timeoutMs: opts.timeoutMs ?? ADOPT_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      logError(
        `[claude-mem] adoption for ${input.branch} exited ${result.exitCode}: ${result.stderr.trim()}`,
      );
    }
  } catch (err) {
    logError(`[claude-mem] adoption failed for ${input.branch}`, err);
  }
}
