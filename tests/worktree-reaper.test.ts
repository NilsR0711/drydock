import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { CommandResult, CommandRunner } from "@/lib/exec/runner";
import { repoWorktreesDir } from "@/lib/git/worktree";
import { createJob, transitionJob } from "@/lib/orchestrator/jobs";
import { reapOrphanedWorktrees } from "@/lib/orchestrator/worktree-reaper";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;
let home: string;

function recordingRunner(exitCode = 0) {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const run: CommandRunner = async (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    return { stdout: "", stderr: "boom", exitCode } satisfies CommandResult;
  };
  return { calls, run };
}

/** Create an on-disk worktree directory for the repo under the worktrees root. */
function makeWorktreeDir(name: string): string {
  const path = join(repoWorktreesDir("acme"), name);
  mkdirSync(path, { recursive: true });
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "drydock-reaper-"));
  process.env.DRYDOCK_HOME = home;
  db = createDb(":memory:");
  repoId = addRepo(
    { path: "/repo", name: "acme", defaultModel: "claude-opus-4-7", sequential: false },
    db,
  ).id;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.DRYDOCK_HOME;
});

describe("reapOrphanedWorktrees", () => {
  it("reaps an orphaned worktree dir while preserving a live job's worktree", async () => {
    const live = createJob({ repoId, issueNumber: 1 }, db);
    transitionJob(live.id, "working", {}, db);
    const liveDir = makeWorktreeDir(`job-${live.id}`);

    // A dir whose job is gone from the DB entirely.
    const orphanDir = makeWorktreeDir("job-9999");

    const { run } = recordingRunner();
    const reaped = await reapOrphanedWorktrees({ db, run });

    expect(reaped).toBe(1);
    expect(existsSync(liveDir)).toBe(true);
    expect(existsSync(orphanDir)).toBe(false);
  });

  it("reaps a worktree whose job reached a terminal state", async () => {
    const done = createJob({ repoId, issueNumber: 2 }, db);
    transitionJob(done.id, "working", {}, db);
    transitionJob(done.id, "aborted", {}, db);
    const doneDir = makeWorktreeDir(`job-${done.id}`);

    const { run } = recordingRunner();
    const reaped = await reapOrphanedWorktrees({ db, run });

    expect(reaped).toBe(1);
    expect(existsSync(doneDir)).toBe(false);
  });

  it("never touches a worktree for a non-terminal (queued) job", async () => {
    const queued = createJob({ repoId, issueNumber: 3 }, db);
    const queuedDir = makeWorktreeDir(`job-${queued.id}`);

    const { run } = recordingRunner();
    const reaped = await reapOrphanedWorktrees({ db, run });

    expect(reaped).toBe(0);
    expect(existsSync(queuedDir)).toBe(true);
  });

  it("runs git worktree prune on each managed repo", async () => {
    const { calls, run } = recordingRunner();
    await reapOrphanedWorktrees({ db, run });

    const prune = calls.find((c) => c.args.includes("prune"));
    expect(prune?.args).toEqual(["-C", "/repo", "worktree", "prune"]);
  });

  it("unregisters an orphan from git before deleting its directory", async () => {
    const orphanDir = makeWorktreeDir("job-1234");

    const { calls, run } = recordingRunner();
    await reapOrphanedWorktrees({ db, run });

    const remove = calls.find((c) => c.args.includes("remove"));
    expect(remove?.args).toEqual(["-C", "/repo", "worktree", "remove", "--force", orphanDir]);
  });

  it("still deletes the directory when git worktree remove fails", async () => {
    const orphanDir = makeWorktreeDir("job-77");

    const { run } = recordingRunner(1); // every git call fails
    const reaped = await reapOrphanedWorktrees({ db, run });

    expect(reaped).toBe(1);
    expect(existsSync(orphanDir)).toBe(false);
  });

  it("ignores non job-* entries under the worktrees root", async () => {
    const fbDir = makeWorktreeDir("fb-some-key");
    const dhDir = makeWorktreeDir("dh-other-key");

    const { run } = recordingRunner();
    const reaped = await reapOrphanedWorktrees({ db, run });

    expect(reaped).toBe(0);
    expect(existsSync(fbDir)).toBe(true);
    expect(existsSync(dhDir)).toBe(true);
  });

  it("does not crash when a repo has no worktrees directory yet", async () => {
    const { run } = recordingRunner();
    await expect(reapOrphanedWorktrees({ db, run })).resolves.toBe(0);
  });
});
