import { describe, expect, it } from "vitest";
import type { CommandRunner } from "@/lib/exec/runner";
import { GhClient, GhError } from "@/lib/github/gh";

describe("GhClient.createPr", () => {
  it("creates a PR and parses the number from the URL", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (_cmd, args) => {
      calls.push(args);
      return { stdout: "https://github.com/acme/x/pull/123\n", stderr: "", exitCode: 0 };
    };
    const num = await new GhClient("/repo", run).createPr({
      head: "drydock/issue-5-job-1",
      base: "main",
      title: "Fix #5",
      body: "Closes #5",
    });
    expect(num).toBe(123);
    expect(calls[0]).toEqual([
      "pr",
      "create",
      "--head=drydock/issue-5-job-1",
      "--base=main",
      "--title=Fix #5",
      "--body=Closes #5",
    ]);
  });

  it("throws GhError on non-zero exit", async () => {
    const run: CommandRunner = async () => ({ stdout: "", stderr: "nope", exitCode: 1 });
    await expect(
      new GhClient("/repo", run).createPr({ head: "b", base: "main", title: "t", body: "" }),
    ).rejects.toBeInstanceOf(GhError);
  });

  it("resolves the existing PR number when one already exists for the branch (issue #331)", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (_cmd, args) => {
      calls.push(args);
      if (args[1] === "create") {
        return {
          stdout: "",
          stderr:
            'a pull request for branch "drydock/issue-5-job-1" into "main" already exists: PR #238',
          exitCode: 1,
        };
      }
      return { stdout: JSON.stringify({ number: 238 }), stderr: "", exitCode: 0 };
    };
    const num = await new GhClient("/repo", run).createPr({
      head: "drydock/issue-5-job-1",
      base: "main",
      title: "Fix #5",
      body: "Closes #5",
    });
    expect(num).toBe(238);
    expect(calls[1]).toEqual(["pr", "view", "drydock/issue-5-job-1", "--json", "number"]);
  });
});
