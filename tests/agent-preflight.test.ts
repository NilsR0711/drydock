import { describe, expect, it } from "vitest";
import { claudeProvider } from "@/lib/agents/claude";
import { codexProvider } from "@/lib/agents/codex";
import { checkAgent } from "@/lib/agents/preflight";
import type { CommandRunner } from "@/lib/exec/runner";

const ok =
  (version: string): CommandRunner =>
  async () => ({ stdout: version, stderr: "", exitCode: 0 });

const nonZero: CommandRunner = async () => ({ stdout: "", stderr: "nope", exitCode: 127 });

const enoent: CommandRunner = async () => {
  throw new Error("spawn codex ENOENT");
};

describe("checkAgent preflight", () => {
  it("reports an installed CLI with its version", async () => {
    const res = await checkAgent(claudeProvider, { runner: ok("claude 2.1.0"), command: "claude" });
    expect(res.installed).toBe(true);
    expect(res.agent).toBe("claude");
    expect(res.version).toBe("claude 2.1.0");
  });

  it("invokes the configured command with a version probe", async () => {
    let seen: { cmd?: string; args?: string[] } = {};
    const runner: CommandRunner = async (cmd, args) => {
      seen = { cmd, args };
      return { stdout: "v1", stderr: "", exitCode: 0 };
    };
    await checkAgent(codexProvider, { runner, command: "/opt/codex" });
    expect(seen.cmd).toBe("/opt/codex");
    expect(seen.args).toContain("--version");
  });

  it("reports a missing CLI with a clear, actionable message", async () => {
    const res = await checkAgent(codexProvider, { runner: enoent, command: "codex" });
    expect(res.installed).toBe(false);
    expect(res.message).toContain("codex");
    expect(res.message?.toLowerCase()).toContain("not found");
  });

  it("treats a non-zero version probe as not installed", async () => {
    const res = await checkAgent(codexProvider, { runner: nonZero, command: "codex" });
    expect(res.installed).toBe(false);
    expect(res.message).toBeTruthy();
  });
});
