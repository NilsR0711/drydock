import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repo } from "@/lib/db/schema";
import type { CommandResult, CommandRunner } from "@/lib/exec/runner";
import { spawnRunner } from "@/lib/exec/runner";
import {
  EmptyCommitError,
  issueBranchLabel,
  slugifyTitle,
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

describe("slugifyTitle (issue #278)", () => {
  it("lowercases and hyphenates a normal title", () => {
    expect(slugifyTitle("Add pagination to the API")).toBe("add-pagination-to-the-api");
  });

  it("strips punctuation and collapses separator runs", () => {
    expect(slugifyTitle("Fix bug #42: crash on start!!")).toBe("fix-bug-42-crash-on-start");
  });

  it("trims leading and trailing separators", () => {
    expect(slugifyTitle("  /Leading & trailing/  ")).toBe("leading-trailing");
  });

  it("transliterates accented characters to ASCII", () => {
    expect(slugifyTitle("Café déjà vu")).toBe("cafe-deja-vu");
  });

  it("caps the slug length without leaving a trailing hyphen", () => {
    // A long title sliced at the 50-char cap must not end on a dangling hyphen.
    const slug = slugifyTitle(`${"word ".repeat(40)}`.trim());
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug).not.toMatch(/-$/);
  });

  it("returns an empty string when the title has no slug-able characters", () => {
    expect(slugifyTitle("🎉🎉🎉")).toBe("");
    expect(slugifyTitle("   ")).toBe("");
  });
});

describe("issueBranchLabel (issue #278)", () => {
  it("embeds the slugified title alongside the issue number", () => {
    expect(issueBranchLabel(13, "Add pagination")).toBe("issue-13-add-pagination");
  });

  it("degrades to the id-only label when the title is missing or empty", () => {
    expect(issueBranchLabel(13)).toBe("issue-13");
    expect(issueBranchLabel(13, "")).toBe("issue-13");
    expect(issueBranchLabel(13, null)).toBe("issue-13");
    // A title that slugifies to nothing also degrades gracefully.
    expect(issueBranchLabel(13, "🎉")).toBe("issue-13");
  });
});

describe("WorktreeManager", () => {
  it("prepare builds a branch from a slugified issue-title label (issue #278)", async () => {
    const { run } = recordingRunner();
    const wt = await new WorktreeManager(run).prepare(
      repo,
      42,
      13,
      issueBranchLabel(13, "Add pagination to the API"),
    );
    expect(wt.branch).toBe("drydock/issue-13-add-pagination-to-the-api-job-42");
  });

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
      "--force",
      wt.path,
      "drydock/issue-9-job-3",
    ]);
  });

  it("prepareForBranch force-adds so it can share a branch the job worktree still holds (issue #319)", async () => {
    // When review feedback arrives, the originating job is usually still in the
    // CI babysitter with the PR open, so its job-<id> worktree still has the
    // branch checked out. git refuses to check the same branch out twice, so a
    // bare `worktree add` dies on "branch already used by worktree" and the
    // feedback is never applied. --force lets the feedback worktree share the
    // branch; it only reads/commits/pushes and is torn down, leaving the job
    // worktree untouched.
    const { calls, run } = recordingRunner();
    await new WorktreeManager(run).prepareForBranch(repo, "drydock/issue-9-job-3", "3");
    const add = calls.find((c) => c.args.includes("worktree") && c.args.includes("add"));
    expect(add?.args).toContain("--force");
  });

  it("prepareResume clears the stale worktree and restores the branch from origin (issue #257)", async () => {
    const { calls, run } = recordingRunner();
    const wt = await new WorktreeManager(run).prepareResume(repo, 3, "drydock/issue-9-job-3");
    expect(wt.branch).toBe("drydock/issue-9-job-3");
    // Resumes on the canonical job path, not a feedback-scoped one.
    expect(wt.path).toContain("job-3");
    // The parked attempt's leftovers are cleared before re-adding.
    expect(calls.map((c) => c.args.slice(2).join(" "))).toEqual([
      `worktree remove --force ${wt.path}`,
      "worktree prune",
      "branch -D drydock/issue-9-job-3",
      "fetch origin drydock/issue-9-job-3",
      `worktree add -B drydock/issue-9-job-3 ${wt.path} origin/drydock/issue-9-job-3`,
      // resolveBase records the restored branch tip.
      "rev-parse drydock/issue-9-job-3",
    ]);
  });

  it("rebaseOntoBase fetches the base, rebases and force-pushes with a lease on success (issue #287)", async () => {
    const { calls, run } = recordingRunner();
    const m = new WorktreeManager(run);
    const wt: Worktree = { path: "/wt", branch: "drydock/issue-9-job-3" };
    await expect(m.rebaseOntoBase(wt, "main", repo.path)).resolves.toEqual({ ok: true });
    expect(calls.map((c) => `${c.args.join(" ")} @${c.cwd}`)).toEqual([
      "fetch origin main @/wt",
      "rebase origin/main @/wt",
      "push --force-with-lease origin drydock/issue-9-job-3 @/wt",
    ]);
  });

  it("rebaseOntoBase aborts the rebase and reports failure without pushing when it conflicts (issue #287)", async () => {
    const calls: { args: string[] }[] = [];
    const run: CommandRunner = async (_cmd, args) => {
      calls.push({ args });
      // The rebase itself hits a conflict it cannot resolve automatically.
      const exitCode = args[0] === "rebase" && args[1] === "origin/main" ? 1 : 0;
      return { stdout: "", stderr: exitCode ? "CONFLICT" : "", exitCode } satisfies CommandResult;
    };
    const m = new WorktreeManager(run);
    const wt: Worktree = { path: "/wt", branch: "drydock/issue-9-job-3" };
    await expect(m.rebaseOntoBase(wt, "main", repo.path)).resolves.toEqual({ ok: false });
    const ran = calls.map((c) => c.args.join(" "));
    expect(ran).toContain("rebase --abort");
    // A failed rebase must never push: the conflict is left for a human.
    expect(ran.some((a) => a.startsWith("push"))).toBe(false);
  });

  describe("rebaseOntoBaseWithResolver (issue #327)", () => {
    /**
     * A programmable git fake: maps each invocation to a scripted result by its
     * leading args, so a multi-step rebase (rebase → diff → add → continue) can
     * be driven deterministically without real git. Unmatched commands succeed.
     */
    function scriptedRunner(
      script: Array<{ match: (a: string[]) => boolean; result: CommandResult }>,
    ) {
      const calls: { args: string[]; cwd?: string }[] = [];
      const run: CommandRunner = async (_cmd, args, cwd) => {
        calls.push({ args, cwd });
        const hit = script.find((s) => s.match(args));
        return hit?.result ?? { stdout: "", stderr: "", exitCode: 0 };
      };
      return { calls, run };
    }
    const wt: Worktree = { path: "/wt", branch: "drydock/issue-9-job-3" };
    const isRebaseStart = (a: string[]): boolean => a[0] === "rebase" && a[1] === "origin/main";
    const isContinue = (a: string[]): boolean => a.includes("rebase") && a.includes("--continue");
    const isDiffU = (a: string[]): boolean => a[0] === "diff" && a.includes("--diff-filter=U");
    const conflict: CommandResult = { stdout: "", stderr: "CONFLICT", exitCode: 1 };
    const clean: CommandResult = { stdout: "", stderr: "", exitCode: 0 };

    it("clean rebase never invokes the resolver and force-pushes (issue #327)", async () => {
      const { calls, run } = scriptedRunner([]);
      const resolve = vi.fn(async () => {});
      const m = new WorktreeManager(run);
      await expect(m.rebaseOntoBaseWithResolver(wt, "main", repo.path, resolve)).resolves.toEqual({
        ok: true,
        resolvedConflicts: 0,
      });
      expect(resolve).not.toHaveBeenCalled();
      const ran = calls.map((c) => c.args.join(" "));
      expect(ran).toContain("push --force-with-lease origin drydock/issue-9-job-3");
    });

    it("hands the conflicted paths to the resolver, then stages, continues and pushes (issue #327)", async () => {
      const { calls, run } = scriptedRunner([
        { match: isRebaseStart, result: conflict },
        { match: isDiffU, result: { stdout: "a.txt\nb.pbxproj\n", stderr: "", exitCode: 0 } },
        { match: isContinue, result: clean },
      ]);
      const seen: string[][] = [];
      const resolve = vi.fn(async (paths: string[]) => {
        seen.push(paths);
      });
      const m = new WorktreeManager(run);
      await expect(m.rebaseOntoBaseWithResolver(wt, "main", repo.path, resolve)).resolves.toEqual({
        ok: true,
        resolvedConflicts: 1,
      });
      expect(seen).toEqual([["a.txt", "b.pbxproj"]]);
      const ran = calls.map((c) => c.args.join(" "));
      expect(ran).toContain("add -A");
      expect(ran.some((a) => a.includes("rebase") && a.includes("--continue"))).toBe(true);
      expect(ran).toContain("push --force-with-lease origin drydock/issue-9-job-3");
      expect(ran).not.toContain("rebase --abort");
    });

    it("aborts without pushing when conflict markers remain after the resolver (issue #327)", async () => {
      const { calls, run } = scriptedRunner([
        { match: isRebaseStart, result: conflict },
        { match: isDiffU, result: { stdout: "a.txt\n", stderr: "", exitCode: 0 } },
        // `git diff --cached --check` reports a leftover marker → resolution invalid.
        {
          match: (a) => a.includes("--check"),
          result: { stdout: "a.txt:3: leftover conflict marker\n", stderr: "", exitCode: 2 },
        },
      ]);
      const resolve = vi.fn(async () => {});
      const m = new WorktreeManager(run);
      await expect(m.rebaseOntoBaseWithResolver(wt, "main", repo.path, resolve)).resolves.toEqual({
        ok: false,
        resolvedConflicts: 0,
      });
      const ran = calls.map((c) => c.args.join(" "));
      expect(ran).toContain("rebase --abort");
      expect(ran.some((a) => a.startsWith("push"))).toBe(false);
    });

    it("aborts when the conflict-marker check itself fails with a command error (issue #327)", async () => {
      // A genuine failure of `git diff --cached --check` (e.g. an index lock)
      // exits non-zero with output on stderr and an empty stdout. That must not
      // be misread as "no markers" and continue the rebase over an unresolved
      // staging area — it has to abort, the safe default.
      const { calls, run } = scriptedRunner([
        { match: isRebaseStart, result: conflict },
        { match: isDiffU, result: { stdout: "a.txt\n", stderr: "", exitCode: 0 } },
        {
          match: (a) => a.includes("--check"),
          result: { stdout: "", stderr: "fatal: unable to read index\n", exitCode: 128 },
        },
      ]);
      const m = new WorktreeManager(run);
      await expect(
        m.rebaseOntoBaseWithResolver(wt, "main", repo.path, async () => {}),
      ).resolves.toEqual({ ok: false, resolvedConflicts: 0 });
      const ran = calls.map((c) => c.args.join(" "));
      expect(ran).toContain("rebase --abort");
      expect(ran.some((a) => a.startsWith("push"))).toBe(false);
    });

    it("ignores whitespace-only --check warnings and still continues (issue #327)", async () => {
      // `git diff --check` flags trailing whitespace too; only leftover conflict
      // markers are disqualifying, so a whitespace warning must not abort.
      const { calls, run } = scriptedRunner([
        { match: isRebaseStart, result: conflict },
        { match: isDiffU, result: { stdout: "a.txt\n", stderr: "", exitCode: 0 } },
        {
          match: (a) => a.includes("--check"),
          result: { stdout: "a.txt:3: trailing whitespace.\n", stderr: "", exitCode: 2 },
        },
        { match: isContinue, result: clean },
      ]);
      const m = new WorktreeManager(run);
      await expect(
        m.rebaseOntoBaseWithResolver(wt, "main", repo.path, async () => {}),
      ).resolves.toEqual({ ok: true, resolvedConflicts: 1 });
      expect(calls.map((c) => c.args.join(" "))).toContain(
        "push --force-with-lease origin drydock/issue-9-job-3",
      );
    });

    it("aborts when an internal git command fails inside the loop, never rejecting (issue #327)", async () => {
      // `git add -A` exits non-zero (this.git throws). The method must honour its
      // contract — abort the rebase and return { ok: false } — rather than reject
      // and leave the worktree mid-rebase for the caller to untangle. (CodeRabbit)
      const { calls, run } = scriptedRunner([
        { match: isRebaseStart, result: conflict },
        { match: isDiffU, result: { stdout: "a.txt\n", stderr: "", exitCode: 0 } },
        {
          match: (a) => a[0] === "add" && a[1] === "-A",
          result: { stdout: "", stderr: "fatal: unable to write index", exitCode: 128 },
        },
      ]);
      const m = new WorktreeManager(run);
      await expect(
        m.rebaseOntoBaseWithResolver(wt, "main", repo.path, async () => {}),
      ).resolves.toEqual({ ok: false, resolvedConflicts: 0 });
      const ran = calls.map((c) => c.args.join(" "));
      expect(ran).toContain("rebase --abort");
      expect(ran.some((a) => a.startsWith("push"))).toBe(false);
    });

    it("aborts when the resolver throws (issue #327)", async () => {
      const { calls, run } = scriptedRunner([
        { match: isRebaseStart, result: conflict },
        { match: isDiffU, result: { stdout: "a.txt\n", stderr: "", exitCode: 0 } },
      ]);
      const m = new WorktreeManager(run);
      await expect(
        m.rebaseOntoBaseWithResolver(wt, "main", repo.path, async () => {
          throw new Error("agent exited non-zero");
        }),
      ).resolves.toEqual({ ok: false, resolvedConflicts: 0 });
      const ran = calls.map((c) => c.args.join(" "));
      expect(ran).toContain("rebase --abort");
      expect(ran.some((a) => a.startsWith("push"))).toBe(false);
    });

    it("aborts when the rebase stops for a non-conflict reason (no unmerged paths) (issue #327)", async () => {
      const { calls, run } = scriptedRunner([
        { match: isRebaseStart, result: conflict },
        // No unmerged paths: the rebase failed for some other reason.
        { match: isDiffU, result: { stdout: "\n", stderr: "", exitCode: 0 } },
      ]);
      const resolve = vi.fn(async () => {});
      const m = new WorktreeManager(run);
      await expect(m.rebaseOntoBaseWithResolver(wt, "main", repo.path, resolve)).resolves.toEqual({
        ok: false,
        resolvedConflicts: 0,
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(calls.map((c) => c.args.join(" "))).toContain("rebase --abort");
    });

    it("resolves conflicts across multiple replayed commits (issue #327)", async () => {
      // First continue still conflicts (next commit), second continue completes.
      let continues = 0;
      const { calls, run } = scriptedRunner([
        { match: isRebaseStart, result: conflict },
        { match: isDiffU, result: { stdout: "a.txt\n", stderr: "", exitCode: 0 } },
        {
          match: isContinue,
          get result() {
            continues++;
            return continues < 2 ? conflict : clean;
          },
        } as { match: (a: string[]) => boolean; result: CommandResult },
      ]);
      const resolve = vi.fn(async () => {});
      const m = new WorktreeManager(run);
      await expect(m.rebaseOntoBaseWithResolver(wt, "main", repo.path, resolve)).resolves.toEqual({
        ok: true,
        resolvedConflicts: 2,
      });
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(calls.map((c) => c.args.join(" "))).toContain(
        "push --force-with-lease origin drydock/issue-9-job-3",
      );
    });

    it("gives up and aborts once the resolution budget is exhausted (issue #327)", async () => {
      // Every continue keeps conflicting; the bounded budget must stop the loop.
      const { calls, run } = scriptedRunner([
        { match: isRebaseStart, result: conflict },
        { match: isDiffU, result: { stdout: "a.txt\n", stderr: "", exitCode: 0 } },
        { match: isContinue, result: conflict },
      ]);
      const resolve = vi.fn(async () => {});
      const m = new WorktreeManager(run);
      const out = await m.rebaseOntoBaseWithResolver(wt, "main", repo.path, resolve, 3);
      expect(out).toEqual({ ok: false, resolvedConflicts: 3 });
      expect(resolve).toHaveBeenCalledTimes(3);
      const ran = calls.map((c) => c.args.join(" "));
      expect(ran).toContain("rebase --abort");
      expect(ran.some((a) => a.startsWith("push"))).toBe(false);
    });
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

  it("stripAiAttribution returns empty when the message is only attribution (issue #269)", () => {
    // The pure helper does not invent a subject; the empty result is the signal
    // the commit call sites guard against before handing it to `git commit -m`.
    const msg = [
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      "",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
    ].join("\n");
    expect(stripAiAttribution(msg)).toBe("");
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

  it("commitAndPush falls back to a default subject when the message is all attribution (issue #269)", async () => {
    // An agent's commit message may consist solely of AI-attribution lines.
    // Stripping leaves an empty string, and `git commit -m ""` fails — so the
    // commit must fall back to a neutral Conventional-Commits subject instead.
    const calls: { args: string[] }[] = [];
    const run: CommandRunner = async (_cmd, args) => {
      calls.push({ args });
      // Dirty tree so we commit the staged edits ourselves; no base so the
      // attribution history-scan short-circuits straight to push.
      const stdout = args[0] === "status" ? " M file.ts\n" : "";
      return { stdout, stderr: "", exitCode: 0 } satisfies CommandResult;
    };
    const m = new WorktreeManager(run);
    const wt = { path: "/wt", branch: "drydock/issue-1-job-1" } as Worktree;
    const allAttribution = [
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      "",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
    ].join("\n");
    await m.commitAndPush(wt, allAttribution);
    const commit = calls.find((c) => c.args[0] === "commit");
    expect(commit?.args).toEqual(["commit", "-m", "chore: update"]);
  });

  it("commitAndPush amends an all-attribution agent commit to a default subject (issue #269)", async () => {
    // The agent committed work whose entire message is an attribution block.
    // The history rewrite would otherwise `git commit --amend -m ""` and fail;
    // it must substitute the neutral fallback subject instead.
    const calls: { args: string[] }[] = [];
    const run: CommandRunner = async (_cmd, args) => {
      calls.push({ args });
      const ok = (stdout: string): CommandResult => ({ stdout, stderr: "", exitCode: 0 });
      if (args[0] === "rev-list" && args.includes("--count")) return ok("1\n");
      if (args[0] === "rev-list" && args.includes("--reverse")) return ok("sha1\n");
      if (args[0] === "log") return ok("Co-Authored-By: Claude <noreply@anthropic.com>\n");
      return ok("");
    };
    const m = new WorktreeManager(run);
    const wt = { path: "/wt", branch: "drydock/issue-1-job-1", base: "base000" };
    await m.commitAndPush(wt, "fix #5");
    const amend = calls.find((c) => c.args[0] === "commit" && c.args.includes("--amend"));
    expect(amend?.args[amend.args.length - 1]).toBe("chore: update");
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
      // Same attribution scrub as commitAndPush (issue #248): the range is
      // scanned, but this mock reports an empty range so it stops at rev-list.
      ["rev-list", "--reverse"],
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
      // Attribution scan over the agent's commits (issue #248); clean here.
      ["rev-list", "--reverse"],
      ["log", "-1"],
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
