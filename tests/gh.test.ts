import type { CommandResult } from "@/lib/exec/runner";
import { GhClient, GhError } from "@/lib/github/gh";
import { describe, expect, it, vi } from "vitest";

function fakeRunner(result: Partial<CommandResult>) {
  return vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0, ...result }));
}

describe("GhClient.listIssues", () => {
  it("parses issue JSON", async () => {
    const runner = fakeRunner({
      stdout: JSON.stringify([
        { number: 7, title: "Fix bug", labels: [{ name: "autoclaude:queue" }] },
      ]),
    });
    const gh = new GhClient("/repo", runner);
    const issues = await gh.listIssues("autoclaude:queue");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.number).toBe(7);
    expect(runner).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["issue", "list", "--label", "autoclaude:queue"]),
      "/repo",
    );
  });

  it("throws on non-zero exit", async () => {
    const gh = new GhClient("/repo", fakeRunner({ exitCode: 1, stderr: "boom" }));
    await expect(gh.listIssues("x")).rejects.toBeInstanceOf(GhError);
  });
});

describe("GhClient.prChecks", () => {
  it("returns checks even when gh exits non-zero (failing checks)", async () => {
    const runner = fakeRunner({
      exitCode: 1,
      stdout: JSON.stringify([{ name: "build", state: "FAILURE", bucket: "fail" }]),
    });
    const gh = new GhClient("/repo", runner);
    const checks = await gh.prChecks(12);
    expect(checks[0]?.state).toBe("FAILURE");
  });
});

describe("GhClient.createIssue", () => {
  it("extracts the created issue number from the URL", async () => {
    const gh = new GhClient("/repo", fakeRunner({ stdout: "https://github.com/o/r/issues/42\n" }));
    expect(await gh.createIssue("t", "b")).toBe(42);
  });
});
