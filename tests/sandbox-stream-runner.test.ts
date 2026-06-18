import { describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "@/lib/exec/runner";
import type { StreamHandle, StreamRunner } from "@/lib/exec/stream-runner";
import type { SandboxSpec } from "@/lib/sandbox/command";
import { createSandboxedStreamRunner } from "@/lib/sandbox/stream-runner";

const spec: SandboxSpec = {
  runtime: "docker",
  image: "node:20",
  workdir: "/workspace",
  hostPath: "/wt/job-7",
  containerName: "drydock-job-7",
  allowNetwork: false,
  cpus: null,
  memory: null,
  mounts: [],
  env: [],
};

/** A base StreamRunner that records what it was asked to spawn and a controllable abort. */
function recordingBase() {
  const calls: { cmd: string; args: string[]; cwd: string }[] = [];
  const abort = vi.fn();
  let resolveDone: (code: number) => void = () => {};
  const handle: StreamHandle = {
    done: new Promise<number>((r) => {
      resolveDone = r;
    }),
    abort,
  };
  const runner: StreamRunner = (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    return handle;
  };
  return { runner, calls, abort, resolveDone, handle };
}

describe("createSandboxedStreamRunner", () => {
  it("wraps the agent command into a docker run invocation via the base runner", () => {
    const base = recordingBase();
    const sandboxed = createSandboxedStreamRunner(spec, {
      baseRunner: base.runner,
      cleanup: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    sandboxed("claude", ["-p", "go"], "/wt/job-7", { onStdout: () => {} });
    expect(base.calls).toHaveLength(1);
    const call = base.calls[0];
    expect(call?.cmd).toBe("docker");
    expect(call?.args).toContain("run");
    expect(call?.args).toContain("claude");
    expect(call?.args.slice(-2)).toEqual(["-p", "go"]);
  });

  it("force-removes the named container on abort so none is orphaned", () => {
    const base = recordingBase();
    const cleanup = vi.fn<CommandRunner>(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const sandboxed = createSandboxedStreamRunner(spec, { baseRunner: base.runner, cleanup });
    const handle = sandboxed("claude", [], "/wt/job-7", { onStdout: () => {} });
    handle.abort(2000);
    // The base process group is signalled…
    expect(base.abort).toHaveBeenCalledWith(2000);
    // …and the container is explicitly force-removed by name.
    expect(cleanup).toHaveBeenCalledTimes(1);
    const call = cleanup.mock.calls[0];
    expect(call?.[0]).toBe("docker");
    expect(call?.[1]).toEqual(["rm", "-f", "drydock-job-7"]);
  });

  it("delegates done and spawnError to the base handle", async () => {
    const base = recordingBase();
    const sandboxed = createSandboxedStreamRunner(spec, {
      baseRunner: base.runner,
      cleanup: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    const handle = sandboxed("claude", [], "/wt/job-7", { onStdout: () => {} });
    base.resolveDone(0);
    expect(await handle.done).toBe(0);
  });

  it("never lets a cleanup failure throw out of abort", () => {
    const base = recordingBase();
    const cleanup: CommandRunner = async () => {
      throw new Error("docker daemon down");
    };
    const sandboxed = createSandboxedStreamRunner(spec, { baseRunner: base.runner, cleanup });
    const handle = sandboxed("claude", [], "/wt/job-7", { onStdout: () => {} });
    expect(() => handle.abort()).not.toThrow();
  });
});
