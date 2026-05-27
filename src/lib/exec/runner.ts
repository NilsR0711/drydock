import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Abstraction over `node:child_process` execution. Production uses
 * `spawnRunner`; tests inject a fake so no real `gh`/`claude` CLI is invoked.
 */
export type CommandRunner = (cmd: string, args: string[], cwd?: string) => Promise<CommandResult>;

export const spawnRunner: CommandRunner = (cmd, args, cwd) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
