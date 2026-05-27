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
        { number: 7, title: "Fix bug", labels: [{ name: "drydock:queue" }] },
      ]),
    });
    const gh = new GhClient("/repo", runner);
    const issues = await gh.listIssues("drydock:queue");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.number).toBe(7);
    expect(runner).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["issue", "list", "--label", "drydock:queue"]),
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

  it("throws GhError when the issue number cannot be parsed", async () => {
    const gh = new GhClient("/repo", fakeRunner({ stdout: "no url here" }));
    await expect(gh.createIssue("t", "b")).rejects.toBeInstanceOf(GhError);
  });

  it("passes title and body as --flag=value tokens (argument-injection safe)", async () => {
    const runner = fakeRunner({ stdout: "https://github.com/o/r/issues/9\n" });
    const gh = new GhClient("/repo", runner);
    await gh.createIssue("-rf danger", "body");
    expect(runner).toHaveBeenCalledWith(
      "gh",
      ["issue", "create", "--title=-rf danger", "--body=body"],
      "/repo",
    );
  });
});

describe("GhClient.failedRunLog", () => {
  it("resolves branch, finds the failed run, and returns its log", async () => {
    const calls: { args: string[] }[] = [];
    const runner = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push({ args });
      if (args[0] === "pr" && args[1] === "view") {
        return { stdout: JSON.stringify({ headRefName: "feat/x" }), stderr: "", exitCode: 0 };
      }
      if (args[0] === "run" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            { databaseId: 111, conclusion: "success" },
            { databaseId: 222, conclusion: "failure" },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      // gh run view <id> --log-failed
      return { stdout: "FAILED LOG OUTPUT", stderr: "", exitCode: 0 };
    });
    const gh = new GhClient("/repo", runner);
    const log = await gh.failedRunLog(12);
    expect(log).toBe("FAILED LOG OUTPUT");
    expect(calls[0]?.args).toEqual(["pr", "view", "12", "--json", "headRefName"]);
    expect(calls[1]?.args).toEqual([
      "run",
      "list",
      "--branch",
      "feat/x",
      "--json",
      "databaseId,conclusion",
      "--limit",
      "20",
    ]);
    expect(calls[2]?.args).toEqual(["run", "view", "222", "--log-failed"]);
  });

  it("returns an empty string when no failed run exists", async () => {
    const runner = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pr") {
        return { stdout: JSON.stringify({ headRefName: "feat/x" }), stderr: "", exitCode: 0 };
      }
      return {
        stdout: JSON.stringify([{ databaseId: 1, conclusion: "success" }]),
        stderr: "",
        exitCode: 0,
      };
    });
    const gh = new GhClient("/repo", runner);
    expect(await gh.failedRunLog(12)).toBe("");
  });

  it("returns an empty string when the PR cannot be resolved", async () => {
    const gh = new GhClient("/repo", fakeRunner({ exitCode: 1, stderr: "no pr" }));
    expect(await gh.failedRunLog(99)).toBe("");
  });

  it("truncates the log to the last 8000 characters", async () => {
    const big = "x".repeat(9000);
    const runner = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pr") {
        return { stdout: JSON.stringify({ headRefName: "b" }), stderr: "", exitCode: 0 };
      }
      if (args[1] === "list") {
        return {
          stdout: JSON.stringify([{ databaseId: 5, conclusion: "failure" }]),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: big, stderr: "", exitCode: 0 };
    });
    const gh = new GhClient("/repo", runner);
    expect((await gh.failedRunLog(1)).length).toBe(8000);
  });
});

describe("GhClient issue read/write", () => {
  it("listAllIssues fetches open issues without a label filter", async () => {
    const runner = fakeRunner({
      stdout: JSON.stringify([{ number: 1, title: "A", labels: [], state: "open" }]),
    });
    const gh = new GhClient("/repo", runner);
    const issues = await gh.listAllIssues();
    expect(runner).toHaveBeenCalledWith(
      "gh",
      ["issue", "list", "--state", "open", "--json", "number,title,labels,state", "--limit", "200"],
      "/repo",
    );
    expect(issues[0]).toMatchObject({ number: 1, title: "A" });
  });

  it("viewIssue parses body and comments", async () => {
    const runner = fakeRunner({
      stdout: JSON.stringify({
        number: 5,
        title: "T",
        body: "desc",
        state: "open",
        labels: [{ name: "bug" }],
        comments: [{ author: { login: "me" }, body: "hi", createdAt: "2026-05-27T10:00:00Z" }],
      }),
    });
    const gh = new GhClient("/repo", runner);
    const issue = await gh.viewIssue(5);
    expect(runner).toHaveBeenCalledWith(
      "gh",
      ["issue", "view", "5", "--json", "number,title,body,state,labels,comments"],
      "/repo",
    );
    expect(issue.body).toBe("desc");
    expect(issue.labels).toEqual(["bug"]);
    expect(issue.comments[0]).toMatchObject({ author: "me", body: "hi" });
  });

  it("editIssue passes title and body", async () => {
    const runner = fakeRunner({});
    const gh = new GhClient("/repo", runner);
    await gh.editIssue(5, { title: "New", body: "B" });
    expect(runner).toHaveBeenCalledWith(
      "gh",
      ["issue", "edit", "5", "--title=New", "--body=B"],
      "/repo",
    );
  });

  it("editIssue with an empty patch makes no gh call", async () => {
    const runner = fakeRunner({});
    const gh = new GhClient("/repo", runner);
    await gh.editIssue(5, {});
    expect(runner).not.toHaveBeenCalled();
  });

  it("addLabels and removeLabels join names with commas", async () => {
    const runner = fakeRunner({});
    const gh = new GhClient("/repo", runner);
    await gh.addLabels(5, ["a", "b"]);
    expect(runner).toHaveBeenCalledWith("gh", ["issue", "edit", "5", "--add-label=a,b"], "/repo");
    await gh.removeLabels(5, ["c"]);
    expect(runner).toHaveBeenCalledWith("gh", ["issue", "edit", "5", "--remove-label=c"], "/repo");
  });

  it("closeIssue and reopenIssue call the right subcommands", async () => {
    const runner = fakeRunner({});
    const gh = new GhClient("/repo", runner);
    await gh.closeIssue(5);
    expect(runner).toHaveBeenCalledWith("gh", ["issue", "close", "5"], "/repo");
    await gh.reopenIssue(5);
    expect(runner).toHaveBeenCalledWith("gh", ["issue", "reopen", "5"], "/repo");
  });
});
