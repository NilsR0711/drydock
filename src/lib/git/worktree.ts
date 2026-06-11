import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Repo } from "@/lib/db/schema";
import { type CommandRunner, spawnRunner } from "@/lib/exec/runner";

export interface Worktree {
  path: string;
  branch: string;
}

/** Root for app-owned worktrees; override with DRYDOCK_HOME. */
export function worktreeHome(): string {
  return process.env.DRYDOCK_HOME ?? join(homedir(), ".drydock");
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/** Directory holding all app-owned worktrees for a single repo. */
export function repoWorktreesDir(repoName: string): string {
  return join(worktreeHome(), "worktrees", sanitize(repoName));
}

export class WorktreeError extends Error {}

/**
 * Raised when there is nothing to commit after staging (issue #50): a no-op
 * agent run that produced no file changes. Callers catch this to report a clear
 * "no changes" outcome instead of surfacing a raw, confusing git error.
 */
export class EmptyCommitError extends WorktreeError {
  constructor() {
    super("nothing to commit");
  }
}

/**
 * Process-wide per-repo mutation queues. Module-level by design: every job run
 * and driver sweep constructs its own WorktreeManager, so an instance-scoped
 * map would serialize nothing — two concurrent jobs (or a job racing a
 * review-feedback sweep) on the same repo would contend on git's internal lock
 * files and fail transiently.
 */
const repoLocks = new Map<string, Promise<unknown>>();

/**
 * Manages isolated git worktrees, one per job, under the app home directory.
 * Mutations on the same repo path are serialized to avoid git index races —
 * across all WorktreeManager instances in this process, not just within one.
 */
export class WorktreeManager {
  constructor(private readonly run: CommandRunner = spawnRunner) {}

  private withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
    const prev = repoLocks.get(repoPath) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    repoLocks.set(
      repoPath,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async git(args: string[], cwd?: string): Promise<string> {
    const res = await this.run("git", args, cwd);
    if (res.exitCode !== 0) {
      throw new WorktreeError(res.stderr.trim() || `git ${args[0]} failed`);
    }
    return res.stdout;
  }

  async prepare(repo: Repo, jobId: number, issueNumber = 0): Promise<Worktree> {
    const branch = `drydock/issue-${issueNumber}-job-${jobId}`;
    const path = join(repoWorktreesDir(repo.name), `job-${jobId}`);
    await this.withRepoLock(repo.path, async () => {
      // Branch and path derive solely from the job id, so a retry of the same
      // job (operator requeue, crash recovery) collides with whatever attempt
      // one left behind: remove() never ran, and the reaper skips non-terminal
      // jobs. Clear the stale worktree and branch best-effort first, or every
      // re-run dies on "a branch named ... already exists".
      await this.git(["-C", repo.path, "worktree", "remove", "--force", path]).catch(
        () => undefined,
      );
      // Prune AFTER the directory is gone: if `worktree remove` failed while
      // the path still existed, pruning first would still see it as live and
      // keep the stale registration, failing the re-add below.
      rmSync(path, { recursive: true, force: true });
      await this.git(["-C", repo.path, "worktree", "prune"]).catch(() => undefined);
      await this.git(["-C", repo.path, "branch", "-D", branch]).catch(() => undefined);
      await this.git(["-C", repo.path, "worktree", "add", "-b", branch, path, repo.defaultBranch]);
    });
    return { path, branch };
  }

  /**
   * Add a worktree that checks out an *existing* remote branch (issue #18). The
   * branch is fetched first so a PR opened in an earlier process is visible,
   * then checked out under a feedback-scoped path. Used to apply review
   * feedback on a PR's own branch rather than a fresh job branch.
   */
  async prepareForBranch(repo: Repo, branch: string, key: string): Promise<Worktree> {
    const path = join(repoWorktreesDir(repo.name), `fb-${sanitize(key)}`);
    await this.withRepoLock(repo.path, async () => {
      await this.git(["-C", repo.path, "fetch", "origin", branch]);
      await this.git(["-C", repo.path, "worktree", "add", path, branch]);
    });
    return { path, branch };
  }

  /**
   * Add a worktree on a *new* branch cut from the repo's default branch (issue
   * #20). Used to open a follow-up fix PR for a failed post-merge deployment,
   * which must start from the merged mainline rather than a job branch.
   */
  async prepareForNewBranch(repo: Repo, branch: string, key: string): Promise<Worktree> {
    const path = join(repoWorktreesDir(repo.name), `dh-${sanitize(key)}`);
    await this.withRepoLock(repo.path, () =>
      this.git(["-C", repo.path, "worktree", "add", "-b", branch, path, repo.defaultBranch]),
    );
    return { path, branch };
  }

  async commitAndPush(wt: Worktree, message: string): Promise<void> {
    await this.git(["add", "-A"], wt.path);
    // A no-op run leaves an empty staging area; committing would exit non-zero
    // with a confusing git error. Detect it up front and signal it distinctly
    // (issue #50) so callers can report a clear "no changes" outcome.
    const staged = await this.git(["status", "--porcelain"], wt.path);
    if (staged.trim() === "") throw new EmptyCommitError();
    await this.git(["commit", "-m", message], wt.path);
    await this.git(["push", "-u", "origin", wt.branch], wt.path);
  }

  async remove(wt: Worktree, repoPath: string): Promise<void> {
    await this.withRepoLock(repoPath, async () => {
      await this.git(["-C", repoPath, "worktree", "remove", "--force", wt.path]);
      await this.git(["-C", repoPath, "worktree", "prune"]);
    });
  }
}
