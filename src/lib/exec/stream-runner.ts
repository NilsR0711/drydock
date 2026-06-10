import { type ChildProcess, spawn } from "node:child_process";

export interface StreamHandle {
  /** Resolves with the process exit code once it closes. */
  done: Promise<number>;
  /** Send SIGTERM, then SIGKILL after `graceMs` if still alive (SPEC §8). */
  abort: (graceMs?: number) => void;
  /**
   * Set to the OS error when the child process fails to spawn (e.g. ENOENT —
   * the CLI binary is not installed or the path is wrong). Undefined on a
   * normal exit. Readable only after `done` resolves.
   */
  spawnError?: Error;
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

  // SIGKILL timer is stored here so the close listener — registered once at
  // spawn time — can clear it when the process exits naturally before SIGKILL.
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const handle: StreamHandle = {
    done: new Promise<number>((resolve) => {
      child.on("close", (code) => {
        if (killTimer) clearTimeout(killTimer);
        resolve(code ?? 0);
      });
      child.on("error", (err) => {
        // Spawn failure (e.g. ENOENT): surface the error on the handle so
        // callers can distinguish "CLI not found" from a real non-zero exit.
        handle.spawnError = err;
        resolve(1);
      });
    }),
    abort: (graceMs = 5000) => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), graceMs);
      // Don't let the SIGKILL timer keep the event loop alive on shutdown.
      killTimer.unref?.();
    },
  };

  return handle;
};
