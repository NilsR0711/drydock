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

export class WorktreeError extends Error {}

/**
 * Manages isolated git worktrees, one per job, under the app home directory.
 * Mutations on the same repo path are serialized to avoid git index races.
 */
export class WorktreeManager {
  private locks = new Map<string, Promise<unknown>>();

  constructor(private readonly run: CommandRunner = spawnRunner) {}

  private withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(repoPath) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
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
    const path = join(worktreeHome(), "worktrees", sanitize(repo.name), `job-${jobId}`);
    await this.withRepoLock(repo.path, () =>
      this.git(["-C", repo.path, "worktree", "add", "-b", branch, path, repo.defaultBranch]),
    );
    return { path, branch };
  }

  /**
   * Add a worktree that checks out an *existing* remote branch (issue #18). The
   * branch is fetched first so a PR opened in an earlier process is visible,
   * then checked out under a feedback-scoped path. Used to apply review
   * feedback on a PR's own branch rather than a fresh job branch.
   */
  async prepareForBranch(repo: Repo, branch: string, key: string): Promise<Worktree> {
    const path = join(worktreeHome(), "worktrees", sanitize(repo.name), `fb-${sanitize(key)}`);
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
    const path = join(worktreeHome(), "worktrees", sanitize(repo.name), `dh-${sanitize(key)}`);
    await this.withRepoLock(repo.path, () =>
      this.git(["-C", repo.path, "worktree", "add", "-b", branch, path, repo.defaultBranch]),
    );
    return { path, branch };
  }

  async commitAndPush(wt: Worktree, message: string): Promise<void> {
    await this.git(["add", "-A"], wt.path);
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
