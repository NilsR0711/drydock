import type { CommandRunner } from "@/lib/exec/runner";
import { GhClient, GhError } from "@/lib/github/gh";
import { describe, expect, it } from "vitest";

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
});
