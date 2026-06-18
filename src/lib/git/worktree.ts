import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Repo } from "@/lib/db/schema";
import { type CommandRunner, spawnRunner } from "@/lib/exec/runner";

export interface Worktree {
  path: string;
  branch: string;
  /**
   * Commit SHA the worktree was cut from. commitAndPush compares HEAD against
   * it to tell an agent that committed its own finished work (clean tree, HEAD
   * ahead of base) apart from a genuine no-op run (issue #206). Always set by
   * the prepare* factories; optional only so test fixtures that mock
   * commitAndPush need not supply it.
   */
  base?: string;
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

  async prepare(
    repo: Repo,
    jobId: number,
    issueNumber = 0,
    // Branch-name label; defaults to the issue slug. An agent-driven release
    // (issue #256) passes "release" so its throwaway branch reads
    // `drydock/release-job-N` rather than `drydock/issue-0-job-N`.
    label = `issue-${issueNumber}`,
  ): Promise<Worktree> {
    const branch = `drydock/${label}-job-${jobId}`;
    const path = join(repoWorktreesDir(repo.name), `job-${jobId}`);
    const base = await this.withRepoLock(repo.path, async () => {
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
      return this.resolveBase(repo.path, branch);
    });
    return { path, branch, base };
  }

  /**
   * Add a worktree that checks out an *existing* remote branch (issue #18). The
   * branch is fetched first so a PR opened in an earlier process is visible,
   * then checked out under a feedback-scoped path. Used to apply review
   * feedback on a PR's own branch rather than a fresh job branch.
   */
  async prepareForBranch(repo: Repo, branch: string, key: string): Promise<Worktree> {
    const path = join(repoWorktreesDir(repo.name), `fb-${sanitize(key)}`);
    const base = await this.withRepoLock(repo.path, async () => {
      await this.git(["-C", repo.path, "fetch", "origin", branch]);
      await this.git(["-C", repo.path, "worktree", "add", path, branch]);
      return this.resolveBase(repo.path, branch);
    });
    return { path, branch, base };
  }

  /**
   * Add a worktree on a *new* branch cut from the repo's default branch (issue
   * #20). Used to open a follow-up fix PR for a failed post-merge deployment,
   * which must start from the merged mainline rather than a job branch.
   */
  async prepareForNewBranch(repo: Repo, branch: string, key: string): Promise<Worktree> {
    const path = join(repoWorktreesDir(repo.name), `dh-${sanitize(key)}`);
    const base = await this.withRepoLock(repo.path, async () => {
      await this.git(["-C", repo.path, "worktree", "add", "-b", branch, path, repo.defaultBranch]);
      return this.resolveBase(repo.path, branch);
    });
    return { path, branch, base };
  }

  /** Resolve a branch tip to a commit SHA, recording a worktree's base. */
  private async resolveBase(repoPath: string, branch: string): Promise<string> {
    return (await this.git(["-C", repoPath, "rev-parse", branch])).trim();
  }

  /** Whether HEAD carries commits the agent made on top of the worktree base. */
  private async hasNewCommits(wt: Worktree): Promise<boolean> {
    if (!wt.base) return false;
    const count = (await this.git(["rev-list", "--count", `${wt.base}..HEAD`], wt.path)).trim();
    return Number.parseInt(count || "0", 10) > 0;
  }

  async commitAndPush(wt: Worktree, message: string): Promise<void> {
    await this.git(["add", "-A"], wt.path);
    const dirty = (await this.git(["status", "--porcelain"], wt.path)).trim() !== "";
    if (dirty) {
      // Uncommitted edits: commit them ourselves under the job's message.
      await this.git(["commit", "-m", message], wt.path);
    } else if (!(await this.hasNewCommits(wt))) {
      // Clean tree AND no commits beyond the base: a genuine no-op run.
      // Committing would exit non-zero with a confusing git error; signal it
      // distinctly (issue #50) so callers report a clear "no changes" outcome.
      throw new EmptyCommitError();
    }
    // Push whatever the branch holds — the commit we just made, or the commits
    // the agent made itself. A senior-engineer-style agent often commits its
    // own finished work; discarding it as "no changes" lost correct results
    // (issue #206).
    await this.git(["push", "-u", "origin", wt.branch], wt.path);
  }

  async remove(wt: Worktree, repoPath: string): Promise<void> {
    await this.withRepoLock(repoPath, async () => {
      await this.git(["-C", repoPath, "worktree", "remove", "--force", wt.path]);
      await this.git(["-C", repoPath, "worktree", "prune"]);
    });
  }
}
