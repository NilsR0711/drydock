import { type ChildProcess, spawn } from "node:child_process";

export interface StreamHandle {
  /** Resolves with the process exit code once it closes. */
  done: Promise<number>;
  /** Send SIGTERM, then SIGKILL after `graceMs` if still alive (SPEC §8). */
  abort: (graceMs?: number) => void;
}

export interface StreamCallbacks {
  onStdout: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/**
 * Spawn a long-running process, streaming stdout line-buffered by the caller.
 * Injectable (see ADR 004) so tests can drive a fake stream without `spawn`.
 */
export type StreamRunner = (
  cmd: string,
  args: string[],
  cwd: string,
  cb: StreamCallbacks,
) => StreamHandle;

export const spawnStreamRunner: StreamRunner = (cmd, args, cwd, cb) => {
  const child: ChildProcess = spawn(cmd, args, { cwd, env: process.env });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => cb.onStdout(d));
  child.stderr?.on("data", (d: string) => cb.onStderr?.(d));

  const done = new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });

  return {
    done,
    abort: (graceMs = 5000) => {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
      child.on("close", () => clearTimeout(timer));
    },
  };
};
