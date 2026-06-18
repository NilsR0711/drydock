import { describe, expect, it } from "vitest";
import type { CommandRunner } from "@/lib/exec/runner";
import { detectContainerRuntime } from "@/lib/sandbox/runtime";

const ok: CommandRunner = async () => ({ stdout: "version 1", stderr: "", exitCode: 0 });
const missing: CommandRunner = async () => {
  throw new Error("ENOENT");
};

describe("detectContainerRuntime", () => {
  it("auto-detects docker first when present", async () => {
    const seen: string[] = [];
    const runner: CommandRunner = async (cmd) => {
      seen.push(cmd);
      return { stdout: "Docker version 27", stderr: "", exitCode: 0 };
    };
    const res = await detectContainerRuntime({ runner, preferred: "auto" });
    expect(res.runtime).toBe("docker");
    expect(seen).toEqual(["docker"]);
  });

  it("falls back to podman when docker is absent", async () => {
    const runner: CommandRunner = async (cmd) => {
      if (cmd === "docker") throw new Error("ENOENT");
      return { stdout: "podman version 5", stderr: "", exitCode: 0 };
    };
    const res = await detectContainerRuntime({ runner, preferred: "auto" });
    expect(res.runtime).toBe("podman");
  });

  it("returns a clear message when no runtime is available", async () => {
    const res = await detectContainerRuntime({ runner: missing, preferred: "auto" });
    expect(res.runtime).toBeNull();
    if (res.runtime === null) {
      expect(res.message.toLowerCase()).toContain("container runtime");
    }
  });

  it("treats a non-zero --version as unavailable", async () => {
    const runner: CommandRunner = async () => ({ stdout: "", stderr: "boom", exitCode: 1 });
    const res = await detectContainerRuntime({ runner, preferred: "auto" });
    expect(res.runtime).toBeNull();
  });

  it("only probes the operator-pinned runtime", async () => {
    const seen: string[] = [];
    const runner: CommandRunner = async (cmd) => {
      seen.push(cmd);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };
    const res = await detectContainerRuntime({ runner, preferred: "podman" });
    expect(res.runtime).toBe("podman");
    expect(seen).toEqual(["podman"]);
  });

  it("fails clearly when the pinned runtime is missing without probing the other", async () => {
    const seen: string[] = [];
    const runner: CommandRunner = async (cmd) => {
      seen.push(cmd);
      throw new Error("ENOENT");
    };
    const res = await detectContainerRuntime({ runner, preferred: "docker" });
    expect(res.runtime).toBeNull();
    expect(seen).toEqual(["docker"]);
  });

  it("defaults preferred to auto when omitted", async () => {
    const res = await detectContainerRuntime({ runner: ok });
    expect(res.runtime).toBe("docker");
  });
});
