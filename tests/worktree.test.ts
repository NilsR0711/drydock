import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Repo } from "@/lib/db/schema";
import type { CommandResult, CommandRunner } from "@/lib/exec/runner";
import { EmptyCommitError, WorktreeManager, worktreeHome } from "@/lib/git/worktree";

const repo = { id: 7, path: "/repos/acme", name: "acme", defaultBranch: "main" } as Repo;

// prepare() runs a real rmSync against the derived worktree path, so the
// suite must never run against the developer's actual ~/.drydock.
const originalHome = process.env.DRYDOCK_HOME;
let testHome = "";
beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "drydock-worktree-"));
  process.env.DRYDOCK_HOME = testHome;
});
afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.DRYDOCK_HOME;
  else process.env.DRYDOCK_HOME = originalHome;
});

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

  it("prepare clears the stale worktree and branch of a prior attempt before re-adding", async () => {
    // Branch and path derive solely from the job id, so a requeued job's second
    // attempt collides with attempt one's leftovers unless prepare cleans them.
    const { calls, run } = recordingRunner();
    const wt = await new WorktreeManager(run).prepare(repo, 42, 13);
    expect(calls.map((c) => c.args.slice(2))).toEqual([
      ["worktree", "remove", "--force", wt.path],
      ["worktree", "prune"],
      ["branch", "-D", "drydock/issue-13-job-42"],
      ["worktree", "add", "-b", "drydock/issue-13-job-42", wt.path, "main"],
      ["rev-parse", "drydock/issue-13-job-42"],
    ]);
  });

  it("prepare succeeds on a fresh job even though the stale-cleanup calls fail", async () => {
    // First attempt of a job: there is nothing to remove, so the best-effort
    // cleanup git calls exit non-zero. Only a failing `worktree add` is fatal;
    // the post-add `rev-parse` that records the base must still succeed.
    const run: CommandRunner = async (_cmd, args) => {
      const ok = args.includes("add") || args.includes("rev-parse");
      return { stdout: "", stderr: ok ? "" : "not found", exitCode: ok ? 0 : 1 };
    };
    await expect(new WorktreeManager(run).prepare(repo, 1, 1)).resolves.toMatchObject({
      branch: "drydock/issue-1-job-1",
    });
  });

  it("prepare records the base commit the worktree was cut from (issue #206)", async () => {
    // commitAndPush compares HEAD against this base to tell an agent that
    // committed its own work apart from a genuine no-op run.
    const run: CommandRunner = async (_cmd, args) => ({
      stdout: args.includes("rev-parse") ? "deadbeefcafe\n" : "",
      stderr: "",
      exitCode: 0,
    });
    const wt = await new WorktreeManager(run).prepare(repo, 42, 13);
    expect(wt.base).toBe("deadbeefcafe");
  });

  it("prepareForBranch fetches and checks out an existing branch", async () => {
    const { calls, run } = recordingRunner();
    const wt = await new WorktreeManager(run).prepareForBranch(repo, "drydock/issue-9-job-3", "3");
    expect(wt.branch).toBe("drydock/issue-9-job-3");
    expect(wt.path).toContain("fb-3");
    expect(calls[0]?.args).toEqual(["-C", repo.path, "fetch", "origin", "drydock/issue-9-job-3"]);
    expect(calls[1]?.args).toEqual([
      "-C",
      repo.path,
      "worktree",
      "add",
      wt.path,
      "drydock/issue-9-job-3",
    ]);
  });

  it("commitAndPush stages, commits and pushes the branch", async () => {
    const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
    const run: CommandRunner = async (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      // A dirty working tree: `git status --porcelain` reports a staged change.
      const stdout = args[0] === "status" ? " M file.ts\n" : "";
      return { stdout, stderr: "", exitCode: 0 } satisfies CommandResult;
    };
    const m = new WorktreeManager(run);
    const wt = await m.prepare(repo, 1, 5);
    calls.length = 0;
    await m.commitAndPush(wt, "fix #5");
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["add", "-A"],
      ["status", "--porcelain"],
      ["commit", "-m"],
      ["push", "-u"],
    ]);
    expect(calls.every((c) => c.cwd === wt.path)).toBe(true);
  });

  it("commitAndPush throws EmptyCommitError and skips commit/push when nothing changed (issue #50)", async () => {
    const calls: { args: string[] }[] = [];
    const run: CommandRunner = async (_cmd, args) => {
      calls.push({ args });
      // A clean working tree (`git status --porcelain` empty) AND no commits on
      // top of the base (`git rev-list --count` reports 0): a genuine no-op run.
      const stdout = args[0] === "rev-list" ? "0\n" : "";
      return { stdout, stderr: "", exitCode: 0 } satisfies CommandResult;
    };
    const m = new WorktreeManager(run);
    const wt = { path: "/wt", branch: "drydock/issue-1-job-1", base: "base000" };
    await expect(m.commitAndPush(wt, "fix #5")).rejects.toBeInstanceOf(EmptyCommitError);
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["add", "-A"],
      ["status", "--porcelain"],
      ["rev-list", "--count"],
    ]);
  });

  it("commitAndPush pushes the agent's own commits when the tree is clean (issue #206)", async () => {
    // The agent committed its finished work itself, leaving the working tree
    // clean. Drydock must push those commits, not discard them as "no changes".
    const calls: { args: string[] }[] = [];
    const run: CommandRunner = async (_cmd, args) => {
      calls.push({ args });
      // Clean tree, but HEAD is one commit ahead of the recorded base.
      const stdout = args[0] === "rev-list" ? "1\n" : "";
      return { stdout, stderr: "", exitCode: 0 } satisfies CommandResult;
    };
    const m = new WorktreeManager(run);
    const wt = { path: "/wt", branch: "drydock/issue-1-job-1", base: "base000" };
    await expect(m.commitAndPush(wt, "fix #5")).resolves.toBeUndefined();
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["add", "-A"],
      ["status", "--porcelain"],
      ["rev-list", "--count"],
      ["push", "-u"],
    ]);
    // It must reuse the agent's commit, not stack an empty one on top.
    expect(calls.some((c) => c.args[0] === "commit")).toBe(false);
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
