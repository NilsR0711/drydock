import { homedir } from "node:os";
import { join } from "node:path";
import type { Repo } from "@/lib/db/schema";
import { type CommandRunner, spawnRunner } from "@/lib/exec/runner";

export interface Worktree {
  path: string;
  branch: string;
}

/** Root for app-owned worktrees; override with AUTOCLAUDE_HOME. */
export function worktreeHome(): string {
  return process.env.AUTOCLAUDE_HOME ?? join(homedir(), ".autoclaude");
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
    const branch = `autoclaude/issue-${issueNumber}-job-${jobId}`;
    const path = join(worktreeHome(), "worktrees", sanitize(repo.name), `job-${jobId}`);
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
