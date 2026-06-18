import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Repo } from "@/lib/db/schema";
import type { CommandResult, CommandRunner } from "@/lib/exec/runner";
import { spawnRunner } from "@/lib/exec/runner";
import {
  EmptyCommitError,
  stripAiAttribution,
  type Worktree,
  WorktreeManager,
  worktreeHome,
} from "@/lib/git/worktree";

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

  it("prepareForBranch records the base commit it was cut from (issue #206)", async () => {
    const run: CommandRunner = async (_cmd, args) => ({
      stdout: args.includes("rev-parse") ? "cafebabe\n" : "",
      stderr: "",
      exitCode: 0,
    });
    const wt = await new WorktreeManager(run).prepareForBranch(repo, "drydock/issue-9-job-3", "3");
    expect(wt.base).toBe("cafebabe");
  });

  it("prepareForNewBranch records the base commit it was cut from (issue #206)", async () => {
    const run: CommandRunner = async (_cmd, args) => ({
      stdout: args.includes("rev-parse") ? "feedface\n" : "",
      stderr: "",
      exitCode: 0,
    });
    const wt = await new WorktreeManager(run).prepareForNewBranch(
      repo,
      "drydock/deploy-123",
      "123",
    );
    expect(wt.base).toBe("feedface");
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
    // prepare()'s mocked rev-parse yields an empty base here, so the attribution
    // scan short-circuits (it has no range to replay) and we go straight to push.
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
      // Clean tree, HEAD one commit ahead of base (rev-list --count → 1), and the
      // agent's commit message carries no AI attribution (git log → clean subject).
      if (args[0] === "rev-list" && args.includes("--count")) return ok("1\n");
      if (args[0] === "rev-list" && args.includes("--reverse")) return ok("agentsha\n");
      if (args[0] === "log") return ok("feat: real work the agent committed\n");
      return ok("");
    };
    function ok(stdout: string): CommandResult {
      return { stdout, stderr: "", exitCode: 0 };
    }
    const m = new WorktreeManager(run);
    const wt = { path: "/wt", branch: "drydock/issue-1-job-1", base: "base000" };
    await expect(m.commitAndPush(wt, "fix #5")).resolves.toBeUndefined();
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["add", "-A"],
      ["status", "--porcelain"],
      ["rev-list", "--count"],
      ["rev-list", "--reverse"],
      ["log", "-1"],
      ["push", "-u"],
    ]);
    // It must reuse the agent's commit, not stack an empty one on top, and a
    // clean message means no history rewrite (no reset/cherry-pick).
    expect(calls.some((c) => c.args[0] === "commit")).toBe(false);
    expect(calls.some((c) => c.args[0] === "reset")).toBe(false);
    expect(calls.some((c) => c.args[0] === "cherry-pick")).toBe(false);
  });

  it("stripAiAttribution drops Claude trailers but keeps the real message", () => {
    const msg = [
      "feat(api): add pagination",
      "",
      "Implements cursor-based paging.",
      "",
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      "",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
    ].join("\n");
    const out = stripAiAttribution(msg);
    expect(out).toBe(
      ["feat(api): add pagination", "", "Implements cursor-based paging."].join("\n"),
    );
    expect(out).not.toMatch(/claude/i);
    expect(out).not.toMatch(/co-authored-by/i);
  });

  it("stripAiAttribution strips non-Claude assistant attribution too (Codex/OpenAI)", () => {
    // Drydock also spawns the `codex` CLI; the policy is no tool/model
    // attribution at all, not just no Claude.
    const codex = "feat: x\n\nCo-authored-by: openai-codex <bot@openai.com>";
    expect(stripAiAttribution(codex)).toBe("feat: x");
    const generated = "feat: y\n\n🤖 Generated by Codex";
    expect(stripAiAttribution(generated)).toBe("feat: y");
  });

  it("stripAiAttribution keeps a human co-author trailer", () => {
    const msg = "fix: bug\n\nCo-Authored-By: Jane Dev <jane@example.com>";
    expect(stripAiAttribution(msg)).toBe(msg);
  });

  it("stripAiAttribution keeps a non-AI 'Generated with' line", () => {
    // A build/tool provenance line must survive — only AI attribution is removed.
    const msg = "chore: regenerate client\n\nGenerated with openapi-generator-cli";
    expect(stripAiAttribution(msg)).toBe(msg);
  });

  it("stripAiAttribution leaves a clean message untouched", () => {
    const msg = "refactor(core): extract helper\n\nNo trailers here.";
    expect(stripAiAttribution(msg)).toBe(msg);
  });

  it("commitAndPush rewrites agent commits that carry AI attribution (issue #248)", async () => {
    // The agent committed its own work and left a `Co-Authored-By: Claude`
    // trailer. Drydock must rewrite the offending commit's message before push.
    const calls: { args: string[] }[] = [];
    const run: CommandRunner = async (_cmd, args) => {
      calls.push({ args });
      const ok = (stdout: string): CommandResult => ({ stdout, stderr: "", exitCode: 0 });
      if (args[0] === "rev-list" && args.includes("--count")) return ok("2\n");
      if (args[0] === "rev-list" && args.includes("--reverse")) return ok("sha1\nsha2\n");
      if (args[0] === "log" && args.includes("sha1")) {
        return ok("feat: one\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n");
      }
      if (args[0] === "log" && args.includes("sha2")) return ok("fix: two\n");
      return ok("");
    };
    const m = new WorktreeManager(run);
    const wt = { path: "/wt", branch: "drydock/issue-1-job-1", base: "base000" };
    await m.commitAndPush(wt, "fix #5");

    // Range is replayed from base: reset, then cherry-pick each commit; only the
    // attributed one is amended with the cleaned message.
    expect(calls.some((c) => c.args[0] === "reset" && c.args.includes("base000"))).toBe(true);
    const cherryPicks = calls.filter((c) => c.args[0] === "cherry-pick").map((c) => c.args[1]);
    expect(cherryPicks).toEqual(["sha1", "sha2"]);
    const amend = calls.find((c) => c.args[0] === "commit" && c.args.includes("--amend"));
    expect(amend).toBeDefined();
    expect(amend?.args[amend.args.length - 1]).toBe("feat: one");
    // Exactly one amend — the clean commit is replayed as-is.
    expect(calls.filter((c) => c.args.includes("--amend"))).toHaveLength(1);
    // Push happens last.
    expect(calls.at(-1)?.args.slice(0, 2)).toEqual(["push", "-u"]);
  });

  it("commitAndPushForHuman commits dirty edits and pushes, returning true (issue #249)", async () => {
    const calls: { args: string[]; cwd?: string }[] = [];
    const run: CommandRunner = async (_cmd, args, cwd) => {
      calls.push({ args, cwd });
      const stdout = args[0] === "status" ? " M file.ts\n" : "";
      return { stdout, stderr: "", exitCode: 0 } satisfies CommandResult;
    };
    const m = new WorktreeManager(run);
    const wt = { path: "/wt", branch: "drydock/issue-1-job-1", base: "base000" };
    await expect(m.commitAndPushForHuman(wt, "wip: park")).resolves.toBe(true);
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["add", "-A"],
      ["status", "--porcelain"],
      ["commit", "-m"],
      ["push", "-u"],
    ]);
    expect(calls.every((c) => c.cwd === wt.path)).toBe(true);
  });

  it("commitAndPushForHuman pushes the agent's own commits on a clean tree, returning true (issue #249)", async () => {
    const calls: { args: string[] }[] = [];
    const run: CommandRunner = async (_cmd, args) => {
      calls.push({ args });
      const stdout = args[0] === "rev-list" ? "1\n" : "";
      return { stdout, stderr: "", exitCode: 0 } satisfies CommandResult;
    };
    const m = new WorktreeManager(run);
    const wt = { path: "/wt", branch: "drydock/issue-1-job-1", base: "base000" };
    await expect(m.commitAndPushForHuman(wt, "wip: park")).resolves.toBe(true);
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["add", "-A"],
      ["status", "--porcelain"],
      ["rev-list", "--count"],
      ["push", "-u"],
    ]);
    expect(calls.some((c) => c.args[0] === "commit")).toBe(false);
  });

  it("commitAndPushForHuman returns false and skips push for a genuine no-op (issue #249)", async () => {
    // Unlike commitAndPush it must NOT throw — parking a no-op run is a normal
    // outcome whose caller still cleans the worktree up.
    const calls: { args: string[] }[] = [];
    const run: CommandRunner = async (_cmd, args) => {
      calls.push({ args });
      const stdout = args[0] === "rev-list" ? "0\n" : "";
      return { stdout, stderr: "", exitCode: 0 } satisfies CommandResult;
    };
    const m = new WorktreeManager(run);
    const wt = { path: "/wt", branch: "drydock/issue-1-job-1", base: "base000" };
    await expect(m.commitAndPushForHuman(wt, "wip: park")).resolves.toBe(false);
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["add", "-A"],
      ["status", "--porcelain"],
      ["rev-list", "--count"],
    ]);
    expect(calls.some((c) => c.args[0] === "push")).toBe(false);
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

  it("scrubs AI attribution from a real agent commit before push (issue #248)", async () => {
    // End-to-end against real git: an agent commits its own work carrying the
    // default Claude trailers; commitAndPush must rewrite the branch so the
    // pushed history is attribution-free, while preserving the real subject.
    const root = mkdtempSync(join(tmpdir(), "drydock-attr-"));
    const git = async (args: string[], cwd: string) => {
      const r = await spawnRunner("git", args, cwd);
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    try {
      const origin = join(root, "origin.git");
      const work = join(root, "work");
      await git(["init", "--bare", "-b", "main", origin], root);
      await git(["init", "-b", "main", work], root);
      await git(["config", "user.email", "dev@example.com"], work);
      await git(["config", "user.name", "Dev"], work);
      await git(["remote", "add", "origin", origin], work);
      writeFileSync(join(work, "README.md"), "base\n");
      await git(["add", "-A"], work);
      await git(["commit", "-m", "chore: init"], work);
      const base = (await git(["rev-parse", "HEAD"], work)).trim();

      await git(["checkout", "-b", "drydock/issue-1-job-1"], work);
      writeFileSync(join(work, "a.txt"), "a\n");
      await git(["add", "-A"], work);
      await git(
        [
          "commit",
          "-m",
          "feat: add a\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
        ],
        work,
      );
      writeFileSync(join(work, "b.txt"), "b\n");
      await git(["add", "-A"], work);
      await git(["commit", "-m", "fix: add b"], work);

      const wt: Worktree = { path: work, branch: "drydock/issue-1-job-1", base };
      await new WorktreeManager(spawnRunner).commitAndPush(wt, "fix #1");

      const log = await git(["log", "--format=%B", `${base}..HEAD`], work);
      expect(log).not.toMatch(/co-authored-by/i);
      expect(log).not.toMatch(/generated with/i);
      expect(log).not.toMatch(/claude/i);
      // The real subjects survive the rewrite.
      expect(log).toMatch(/feat: add a/);
      expect(log).toMatch(/fix: add b/);
      // The branch reached the remote.
      const remote = await git(["log", "origin/drydock/issue-1-job-1", "--format=%s"], work);
      expect(remote).toMatch(/feat: add a/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
