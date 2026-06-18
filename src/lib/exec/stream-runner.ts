import { type ChildProcess, spawn } from "node:child_process";
import { killProcessTree, SPAWN_DETACHED } from "./runner";

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
  // Detached: the agent CLI leads its own process group, so abort() can signal
  // the whole tree. A SIGKILLed CLI would otherwise orphan its grandchildren
  // (test runners, dev servers started via the agent's tools), which keep
  // running, hold files in the worktree, and outlive Drydock on shutdown.
  //
  // stdin is wired to /dev/null ("ignore"): the agent CLI takes its prompt as an
  // argv flag and reads no input, but on the default inherited pipe its stdin
  // stays open and the `claude` CLI emits a benign "no stdin data received in 3s,
  // proceeding without it" warning to stderr — which Drydock then surfaces as a
  // red ERROR log line (issue #233). A /dev/null stdin returns EOF immediately,
  // so the warning never fires; stdout/stderr stay piped for streaming.
  const child: ChildProcess = spawn(cmd, args, {
    cwd,
    env: process.env,
    detached: SPAWN_DETACHED,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => cb.onStdout(d));
  child.stderr?.on("data", (d: string) => cb.onStderr?.(d));

  // SIGKILL timer is stored here so the close listener — registered once at
  // spawn time — can clear it when the process exits naturally before SIGKILL.
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let aborted = false;

  const handle: StreamHandle = {
    done: new Promise<number>((resolve) => {
      child.on("close", (code, signal) => {
        if (killTimer) clearTimeout(killTimer);
        // A signal death (user abort, emergency stop, graceful shutdown)
        // reports code=null; map it to a non-zero exit so callers never treat
        // a killed session as success — and push/PR its partial work.
        resolve(code ?? (signal ? 1 : 0));
      });
      child.on("error", (err) => {
        // Spawn failure (e.g. ENOENT): surface the error on the handle so
        // callers can distinguish "CLI not found" from a real non-zero exit.
        handle.spawnError = err;
        resolve(1);
      });
    }),
    abort: (graceMs = 5000) => {
      // Idempotent: the timeout, the cost-cap guard, and a user abort can all
      // race to call this; a second call must not re-signal or replace (and
      // thereby duplicate) the pending SIGKILL escalation.
      if (aborted) return;
      aborted = true;
      killProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), graceMs);
      // Don't let the SIGKILL timer keep the event loop alive on shutdown.
      killTimer.unref?.();
    },
  };

  return handle;
};
