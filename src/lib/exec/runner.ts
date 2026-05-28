import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptions {
  /** Wall-clock timeout in ms; the process is killed and the call rejects on breach. */
  timeoutMs?: number;
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
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutMs = opts?.timeoutMs ?? ONE_SHOT_TIMEOUT_MS;
    // Hard wall-clock bound: a hung subprocess (network stall, stdin prompt) is
    // SIGKILLed and the call rejects rather than blocking the caller forever.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
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
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`\`${cmd}\` timed out after ${timeoutMs}ms`));
        return;
      }
      resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
