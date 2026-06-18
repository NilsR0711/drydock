import { type CommandRunner, spawnRunner } from "@/lib/exec/runner";
import { type StreamHandle, type StreamRunner, spawnStreamRunner } from "@/lib/exec/stream-runner";
import { logError } from "@/lib/log/logger";
import { buildSandboxCommand, type SandboxSpec } from "./command";

export interface SandboxRunnerDeps {
  /** Underlying process spawner; defaults to the real streaming spawner. */
  baseRunner?: StreamRunner;
  /** One-shot runner used to force-remove the container on abort. */
  cleanup?: CommandRunner;
}

/**
 * Wrap a {@link StreamRunner} so the agent command runs inside a container
 * (ADR 033). The incoming `cmd` is the *in-container* command (the bare agent
 * binary on the image's PATH — the host path does not exist inside), and the
 * args are passed straight through. `cwd` stays the host worktree so the
 * runtime client resolves any relative paths from there.
 *
 * Teardown is the critical part: SIGKILLing the `docker run` client does not
 * necessarily stop the container the daemon owns, so the wrapped `abort` both
 * signals the client's process group (via the base runner, preserving the
 * timeout/cost-cap/SIGKILL semantics) AND force-removes the named container.
 * The removal is best-effort and can never throw out of `abort`.
 */
export function createSandboxedStreamRunner(
  spec: SandboxSpec,
  deps: SandboxRunnerDeps = {},
): StreamRunner {
  const baseRunner = deps.baseRunner ?? spawnStreamRunner;
  const cleanup = deps.cleanup ?? spawnRunner;

  return (cmd, args, cwd, cb) => {
    const wrapped = buildSandboxCommand(spec, cmd, args);
    const base = baseRunner(wrapped.cmd, wrapped.args, cwd, cb);

    const handle: StreamHandle = {
      done: base.done,
      get spawnError() {
        return base.spawnError;
      },
      abort: (graceMs) => {
        base.abort(graceMs);
        // Guarantee no orphaned container even if the client was SIGKILLed
        // before it could forward the signal to the daemon's container.
        try {
          void cleanup(spec.runtime, ["rm", "-f", spec.containerName]).catch((err) =>
            logError(`[sandbox] failed to remove container ${spec.containerName}`, err),
          );
        } catch (err) {
          logError(`[sandbox] failed to remove container ${spec.containerName}`, err);
        }
      },
    };
    return handle;
  };
}
