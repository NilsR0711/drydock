import { type ChildProcess, spawn } from "node:child_process";

/**
 * Children are spawned detached (own process group, POSIX only) so a kill can
 * reach the whole tree: agent CLIs routinely start long-lived grandchildren
 * (test runners, dev servers) that would survive a SIGKILL of the direct child
 * as orphans, burning CPU and holding files inside the worktree.
 */
export const SPAWN_DETACHED = process.platform !== "win32";

/**
 * Signal a spawned child and its whole process group. Falls back to signalling
 * just the direct pid when the group is already gone (ESRCH) or on platforms
 * without process groups.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined && SPAWN_DETACHED) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Group already reaped or not signalable — fall back to the direct pid.
    }
  }
  child.kill(signal);
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptions {
  /** Wall-clock timeout in ms; the process is killed and the call rejects on breach. */
  timeoutMs?: number;
  /**
   * Extra environment variables merged over `process.env` for the child only
   * (issue #349). Used to bridge an OpenRouter key onto an `opencode` one-shot
   * so `openrouter/*` models authenticate without separate opencode auth.
   */
  env?: Record<string, string>;
}

/**
 * Abstraction over `node:child_process` execution. Production uses
 * `spawnRunner`; tests inject a fake so no real `gh`/`claude` CLI is invoked.
 */
export type CommandRunner = (
  cmd: string,
  args: string[],
  cwd?: string,
  opts?: CommandOptions,
) => Promise<CommandResult>;

/**
 * Default wall-clock bound for one-shot `git`/`gh` invocations (issue #47).
 * Short by design: these calls are not long agent sessions, so a multi-minute
 * stall almost always means a hung network call or a prompt waiting on stdin.
 */
export const ONE_SHOT_TIMEOUT_MS = 5 * 60 * 1000;

export const spawnRunner: CommandRunner = (cmd, args, cwd, opts) =>
  new Promise((resolvePromise, reject) => {
    const env = opts?.env ? { ...process.env, ...opts.env } : process.env;
    const child = spawn(cmd, args, { cwd, env, detached: SPAWN_DETACHED });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutMs = opts?.timeoutMs ?? ONE_SHOT_TIMEOUT_MS;
    // Hard wall-clock bound: a hung subprocess (network stall, stdin prompt) is
    // SIGKILLed — together with its process group, so helpers like credential
    // helpers or ssh are not orphaned — and the call rejects rather than
    // blocking the caller forever.
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`\`${cmd}\` timed out after ${timeoutMs}ms`));
        return;
      }
      // A signal death reports code=null; map it to a non-zero exit so callers
      // never mistake an externally killed command for a success.
      resolvePromise({ stdout, stderr, exitCode: code ?? (signal ? 1 : 0) });
    });
  });
