import { describe, expect, it } from "vitest";
import type { Repo } from "@/lib/db/schema";
import type { CommandResult, CommandRunner } from "@/lib/exec/runner";
import { WorktreeManager, worktreeHome } from "@/lib/git/worktree";

const repo = { id: 7, path: "/repos/acme", name: "acme", defaultBranch: "main" } as Repo;

function recordingRunner() {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const run: CommandRunner = async (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    return { stdout: "", stderr: "", exitCode: 0 } satisfies CommandResult;
  };
  return { calls, run };
}

describe("WorktreeManager", () => {
  it("prepare adds a worktree on a new branch off the default branch", async () => {
    const { calls, run } = recordingRunner();
    const wt = await new WorktreeManager(run).prepare(repo, 42);
    expect(wt.branch).toBe("drydock/issue-0-job-42");
    expect(wt.path).toContain("job-42");
    const add = calls.find((c) => c.args[2] === "worktree" && c.args[3] === "add");
    expect(add).toBeDefined();
    expect(add?.args).toEqual([
      "-C",
      repo.path,
      "worktree",
      "add",
      "-b",
      "drydock/issue-0-job-42",
      wt.path,
      "main",
    ]);
  });

  it("prepare uses the issue number in the branch when given", async () => {
    const { run } = recordingRunner();
    const wt = await new WorktreeManager(run).prepare(repo, 42, 13);
    expect(wt.branch).toBe("drydock/issue-13-job-42");
  });

  it("commitAndPush stages, commits and pushes the branch", async () => {
    const { calls, run } = recordingRunner();
    const m = new WorktreeManager(run);
    const wt = await m.prepare(repo, 1, 5);
    calls.length = 0;
    await m.commitAndPush(wt, "fix #5");
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["add", "-A"],
      ["commit", "-m"],
      ["push", "-u"],
    ]);
    expect(calls.every((c) => c.cwd === wt.path)).toBe(true);
  });

  it("remove force-removes the worktree and prunes", async () => {
    const { calls, run } = recordingRunner();
    const m = new WorktreeManager(run);
    const wt = await m.prepare(repo, 1, 5);
    calls.length = 0;
    await m.remove(wt, repo.path);
    expect(calls[0]?.args).toEqual(["-C", repo.path, "worktree", "remove", "--force", wt.path]);
    expect(calls[1]?.args).toEqual(["-C", repo.path, "worktree", "prune"]);
  });

  it("serializes mutations on the same repo path", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const run: CommandRunner = async (_cmd, args) => {
      if (args.includes("add") && first) {
        first = false;
        order.push("a-start");
        await gate;
        order.push("a-end");
      } else if (args.includes("add")) {
        order.push("b");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const m = new WorktreeManager(run);
    const p1 = m.prepare(repo, 1, 1);
    const p2 = m.prepare(repo, 2, 2);
    await Promise.resolve();
    release();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("worktreeHome honours DRYDOCK_HOME", () => {
    const prev = process.env.DRYDOCK_HOME;
    process.env.DRYDOCK_HOME = "/custom/home";
    expect(worktreeHome()).toBe("/custom/home");
    if (prev === undefined) delete process.env.DRYDOCK_HOME;
    else process.env.DRYDOCK_HOME = prev;
  });

  it("throws when a git command fails", async () => {
    const run: CommandRunner = async () => ({ stdout: "", stderr: "boom", exitCode: 1 });
    await expect(new WorktreeManager(run).prepare(repo, 1, 1)).rejects.toThrow("boom");
  });
});
