import { describe, expect, it, vi } from "vitest";
import type { StreamRunner } from "@/lib/exec/stream-runner";
import type { SandboxConfig } from "@/lib/sandbox/config";
import { prepareSandboxSession } from "@/lib/sandbox/session";

const dockerCfg: SandboxConfig = {
  mode: "docker",
  imageOverride: null,
  defaultImage: "node:20-bookworm",
  allowNetwork: false,
  cpus: null,
  memory: null,
};

const baseInput = {
  config: dockerCfg,
  worktreePath: "/wt/job-9",
  jobId: 9,
  agent: "claude" as const,
  inContainerCommand: "claude",
  preferredRuntime: "auto" as const,
};

function passthroughDeps(over: Record<string, unknown> = {}) {
  const spawnCalls: { cmd: string; args: string[] }[] = [];
  const baseRunner: StreamRunner = (cmd, args) => {
    spawnCalls.push({ cmd, args });
    return { done: Promise.resolve(0), abort: () => {} };
  };
  return {
    spawnCalls,
    deps: {
      detect: async () => ({ runtime: "docker" as const }),
      readFileText: () => null,
      home: "/home/op",
      env: {} as Record<string, string | undefined>,
      exists: () => false,
      baseRunner,
      cleanup: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      ...over,
    },
  };
}

describe("prepareSandboxSession", () => {
  it("builds a runner that wraps the agent command in a container run", async () => {
    const { deps, spawnCalls } = passthroughDeps();
    const res = await prepareSandboxSession({ ...baseInput, deps });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.session.command).toBe("claude");
    res.session.runner("claude", ["-p", "x"], "/wt/job-9", { onStdout: () => {} });
    const call = spawnCalls[0];
    expect(call?.cmd).toBe("docker");
    const args = call?.args ?? [];
    expect(args).toContain("run");
    // worktree is the bind-mounted workdir; container named per job
    expect(args).toContain("/wt/job-9:/workspace");
    expect(args[args.indexOf("--name") + 1]).toBe("drydock-job-9");
    // default image resolved from settings default
    expect(args).toContain("node:20-bookworm");
  });

  it("fails with a clear reason when no container runtime is available", async () => {
    const { deps } = passthroughDeps({
      detect: async () => ({
        runtime: null,
        message: "No usable container runtime found (tried docker / podman).",
      }),
    });
    const res = await prepareSandboxSession({ ...baseInput, deps });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason.toLowerCase()).toContain("container runtime");
  });

  it("fails with a clear reason when no image can be resolved", async () => {
    const { deps } = passthroughDeps();
    const res = await prepareSandboxSession({
      ...baseInput,
      config: { ...dockerCfg, defaultImage: "" },
      deps,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason.toLowerCase()).toContain("image");
  });

  it("mounts agent credentials read-only and passes a gh token through", async () => {
    const { deps, spawnCalls } = passthroughDeps({
      exists: (p: string) => p === "/home/op/.claude",
      env: { GH_TOKEN: "ghp_z" },
    });
    const res = await prepareSandboxSession({ ...baseInput, deps });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    res.session.runner("claude", [], "/wt/job-9", { onStdout: () => {} });
    const args = spawnCalls[0]?.args ?? [];
    expect(args).toContain("/home/op/.claude:/root/.claude:ro");
    expect(args[args.indexOf("-e") + 1]).toBe("GH_TOKEN");
  });

  it("prefers an explicit per-repo image override over the default", async () => {
    const { deps, spawnCalls } = passthroughDeps();
    const res = await prepareSandboxSession({
      ...baseInput,
      config: { ...dockerCfg, imageOverride: "repo/explicit:9" },
      deps,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    res.session.runner("claude", [], "/wt/job-9", { onStdout: () => {} });
    const args = spawnCalls[0]?.args ?? [];
    expect(args).toContain("repo/explicit:9");
    expect(args).not.toContain("node:20-bookworm");
  });

  it("force-removes the container on abort (no orphan)", async () => {
    const cleanup = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const { deps } = passthroughDeps({ cleanup });
    const res = await prepareSandboxSession({ ...baseInput, deps });
    if (!res.ok) throw new Error("expected ok");
    const handle = res.session.runner("claude", [], "/wt/job-9", { onStdout: () => {} });
    handle.abort();
    expect(cleanup).toHaveBeenCalledWith("docker", ["rm", "-f", "drydock-job-9"]);
  });
});
