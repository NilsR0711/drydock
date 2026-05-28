import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type DB, getDb } from "@/lib/db/client";
import { listRepos } from "@/lib/db/queries";
import { jobs } from "@/lib/db/schema";
import { type CommandRunner, spawnRunner } from "@/lib/exec/runner";
import { repoWorktreesDir } from "@/lib/git/worktree";
import { TERMINAL_STATES } from "./state-machine";

/** Worktree directory name for a per-job worktree, e.g. `job-42`. */
const JOB_DIR = /^job-(\d+)$/;

export interface ReapDeps {
  db?: DB;
  /** Injectable git runner; tests pass a fake so no real git is invoked. */
  run?: CommandRunner;
}

/**
 * Set of job ids whose worktree must never be reaped: every job not in a
 * terminal state still potentially owns a live or to-be-resumed worktree.
 */
function liveJobIds(db: DB): Set<number> {
  const rows = db.select({ id: jobs.id, status: jobs.status }).from(jobs).all();
  const live = new Set<number>();
  for (const row of rows) {
    if (!(TERMINAL_STATES as readonly string[]).includes(row.status)) live.add(row.id);
  }
  return live;
}

/**
 * Reap git worktrees left behind by a hard crash (issue #53). `runJob` removes
 * its worktree in a `finally`, but a SIGKILL/OOM skips that cleanup, so stale
 * `job-<id>` directories and their git registrations accumulate over time.
 *
 * On startup — alongside the DB-level crash recovery — this sweeps every managed
 * repo: it `git worktree prune`s dangling registrations, then deletes any
 * `job-<id>` directory whose job no longer exists or has reached a terminal
 * state. Directories for live (non-terminal) jobs are never touched, so an
 * in-flight or resumable job keeps its worktree. Returns the number reaped.
 *
 * Best-effort throughout: a failing git call or unreadable repo directory is
 * logged and skipped rather than aborting the sweep.
 */
export async function reapOrphanedWorktrees(deps: ReapDeps = {}): Promise<number> {
  const db = deps.db ?? getDb();
  const run = deps.run ?? spawnRunner;
  const live = liveJobIds(db);
  let reaped = 0;

  for (const repo of listRepos(db)) {
    // Drop dangling registrations whose backing directory is already gone.
    await run("git", ["-C", repo.path, "worktree", "prune"]).catch(() => undefined);

    const dir = repoWorktreesDir(repo.name);
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      // No worktrees directory for this repo yet — nothing to reap.
      continue;
    }

    for (const entry of entries) {
      const match = JOB_DIR.exec(entry);
      if (!match) continue; // only per-job worktrees are reaped here
      if (live.has(Number(match[1]))) continue; // guard: live job, never touch

      const path = join(dir, entry);
      // Unregister the worktree before deleting it so git's metadata stays
      // consistent; the explicit rm covers the case where the registration is
      // already gone (so `worktree remove` errors) but the directory remains.
      await run("git", ["-C", repo.path, "worktree", "remove", "--force", path]).catch(
        () => undefined,
      );
      try {
        rmSync(path, { recursive: true, force: true });
        reaped++;
      } catch (err) {
        console.error(`[worktree-reaper] failed to remove ${path}`, err);
      }
    }
  }

  return reaped;
}
