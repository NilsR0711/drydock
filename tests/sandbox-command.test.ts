import { describe, expect, it } from "vitest";
import { buildSandboxCommand, type SandboxSpec } from "@/lib/sandbox/command";

const baseSpec: SandboxSpec = {
  runtime: "docker",
  image: "node:20",
  workdir: "/workspace",
  hostPath: "/home/op/.drydock/worktrees/repo/job-7",
  containerName: "drydock-job-7",
  allowNetwork: false,
  cpus: null,
  memory: null,
  mounts: [],
  env: [],
};

describe("buildSandboxCommand", () => {
  it("invokes the runtime, not the inner command", () => {
    const { cmd } = buildSandboxCommand(baseSpec, "claude", ["-p", "go"]);
    expect(cmd).toBe("docker");
  });

  it("bind-mounts the worktree as the workdir and runs the inner command there", () => {
    const { args } = buildSandboxCommand(baseSpec, "claude", ["-p", "go"]);
    expect(args).toContain("run");
    expect(args).toContain("--rm");
    expect(args).toContain("--init");
    // -v <host>:<workdir>
    const vIdx = args.indexOf("-v");
    expect(args[vIdx + 1]).toBe("/home/op/.drydock/worktrees/repo/job-7:/workspace");
    const wIdx = args.indexOf("-w");
    expect(args[wIdx + 1]).toBe("/workspace");
    // names the container for reliable teardown
    const nIdx = args.indexOf("--name");
    expect(args[nIdx + 1]).toBe("drydock-job-7");
    // image then inner command + args come last, in order
    expect(args.slice(-4)).toEqual(["node:20", "claude", "-p", "go"]);
  });

  it("disables networking by default", () => {
    const { args } = buildSandboxCommand(baseSpec, "claude", []);
    const idx = args.indexOf("--network");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("none");
  });

  it("omits --network none when network access is allowed", () => {
    const { args } = buildSandboxCommand({ ...baseSpec, allowNetwork: true }, "claude", []);
    expect(args).not.toContain("--network");
  });

  it("applies cpu and memory caps when set", () => {
    const { args } = buildSandboxCommand({ ...baseSpec, cpus: "2", memory: "4g" }, "claude", []);
    expect(args[args.indexOf("--cpus") + 1]).toBe("2");
    expect(args[args.indexOf("--memory") + 1]).toBe("4g");
  });

  it("adds read-only auth mounts and env passthrough", () => {
    const { args } = buildSandboxCommand(
      {
        ...baseSpec,
        mounts: [{ host: "/home/op/.claude", container: "/root/.claude" }],
        env: ["GH_TOKEN"],
      },
      "claude",
      [],
    );
    expect(args).toContain("/home/op/.claude:/root/.claude:ro");
    const eIdx = args.indexOf("-e");
    expect(args[eIdx + 1]).toBe("GH_TOKEN");
  });
});
