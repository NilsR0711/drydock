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

/**
 * Coding assistants Drydock may spawn (or that a contributor might use) which
 * stamp their own attribution into commit messages. Kept broad on purpose: the
 * policy is "no tool/model attribution" (issue #248), not "no Claude", so a
 * Codex/OpenAI run must be scrubbed just like a Claude one.
 */
const AI_ASSISTANT_NAMES = "claude|anthropic|codex|openai|chatgpt|copilot|gemini|cursor|devin";

/**
 * Lines an AI assistant adds to its own commit messages by default. Repo policy
 * forbids AI attribution (issue #248), but an agent may still emit a trailer
 * despite the prompt, so commits are scrubbed before push as defense in depth.
 * Matched case-insensitively against trimmed lines; a human `Co-Authored-By`
 * trailer (one that names no known assistant) is deliberately left intact, as is
 * a non-AI "Generated with …" line (e.g. a build tool).
 */
const AI_ATTRIBUTION_LINE = new RegExp(
  `^(?:co-authored-by:.*\\b(?:${AI_ASSISTANT_NAMES})\\b|🤖?\\s*generated (?:with|by)\\b.*\\b(?:${AI_ASSISTANT_NAMES})\\b)`,
  "i",
);

/**
 * Strip AI-attribution trailers from a commit message, returning the cleaned
 * message with trailing blank lines collapsed. Pure and side-effect free so it
 * can guard both Drydock's own commit and an agent's committed history.
 */
export function stripAiAttribution(message: string): string {
  const kept = message.split("\n").filter((line) => !AI_ATTRIBUTION_LINE.test(line.trim()));
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");
}

/**
 * Subject substituted when stripping AI attribution leaves nothing behind
 * (issue #269): an agent may emit a commit whose body is *only* attribution
 * lines, so `stripAiAttribution` returns "". `git commit -m ""` and
 * `git commit --amend -m ""` both fail, so the two call sites that feed a
 * stripped message to git fall back to this neutral Conventional-Commits
 * subject rather than abort the push.
 */
const STRIPPED_MESSAGE_FALLBACK = "chore: update";

/**
 * Guard an already-stripped commit message against being empty: return it
 * unchanged unless it is blank, in which case substitute the fallback subject
 * so `git commit` never sees an empty `-m` (issue #269).
 */
function nonEmptyCommitMessage(cleaned: string): string {
  return cleaned.trim() === "" ? STRIPPED_MESSAGE_FALLBACK : cleaned;
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
   * Re-check out a parked job's preserved branch to resume its prior work (issue
   * #257). Unlike `prepare` (fresh branch off the default) this restores the
   * branch the job pushed when it parked (issue #249) so the resumed run builds
   * on the agent's existing commits.
   *
   * The parked attempt may have left its worktree behind (issue #249 skips the
   * finally cleanup) with the branch still checked out, so the stale worktree +
   * local branch ref are cleared first — otherwise `worktree add` dies on
   * "branch already checked out"/"already exists". The branch is then fetched
   * and force-created from `origin/<branch>` at the canonical job path, making
   * the restore robust whether or not the local worktree survived.
   */
  async prepareResume(repo: Repo, jobId: number, branch: string): Promise<Worktree> {
    const path = join(repoWorktreesDir(repo.name), `job-${jobId}`);
    const base = await this.withRepoLock(repo.path, async () => {
      await this.git(["-C", repo.path, "worktree", "remove", "--force", path]).catch(
        () => undefined,
      );
      rmSync(path, { recursive: true, force: true });
      await this.git(["-C", repo.path, "worktree", "prune"]).catch(() => undefined);
      // Drop the local ref so `worktree add -B` re-creates it from origin; the
      // worktree remove above freed it, so this no longer fails on a checkout.
      await this.git(["-C", repo.path, "branch", "-D", branch]).catch(() => undefined);
      await this.git(["-C", repo.path, "fetch", "origin", branch]);
      await this.git(["-C", repo.path, "worktree", "add", "-B", branch, path, `origin/${branch}`]);
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

  /**
   * Stage everything and ensure the branch carries work to push: commit any
   * uncommitted edits under `message`, and report whether there is anything to
   * push at all. Returns false only for a genuine no-op (clean tree AND no
   * commits beyond the base). Shared by commitAndPush and commitAndPushForHuman.
   */
  private async stageForPush(wt: Worktree, message: string): Promise<boolean> {
    await this.git(["add", "-A"], wt.path);
    const dirty = (await this.git(["status", "--porcelain"], wt.path)).trim() !== "";
    if (dirty) {
      // Uncommitted edits: commit them ourselves under the given message,
      // scrubbed of any AI attribution the message may carry (issue #248).
      await this.git(["commit", "-m", nonEmptyCommitMessage(stripAiAttribution(message))], wt.path);
      return true;
    }
    // Clean tree: push only if the agent committed its own work on top of the
    // base. No such commits means a genuine no-op run.
    return this.hasNewCommits(wt);
  }

  async commitAndPush(wt: Worktree, message: string): Promise<void> {
    if (!(await this.stageForPush(wt, message))) {
      // Clean tree AND no commits beyond the base: a genuine no-op run.
      // Committing would exit non-zero with a confusing git error; signal it
      // distinctly (issue #50) so callers report a clear "no changes" outcome.
      throw new EmptyCommitError();
    }
    // Defense in depth (issue #248): an agent may commit its own work with an AI
    // attribution trailer despite the prompt forbidding it. Rewrite the commits
    // on top of the base to strip those trailers before they ever leave the box.
    await this.stripAttributionFromHistory(wt);
    // Push whatever the branch holds — the commit we just made, or the commits
    // the agent made itself. A senior-engineer-style agent often commits its
    // own finished work; discarding it as "no changes" lost correct results
    // (issue #206).
    await this.git(["push", "-u", "origin", wt.branch], wt.path);
  }

  /**
   * Commit and push a parked job's work so a human (or a later resume) can pick
   * up from real commits instead of starting over (issue #249). Returns whether
   * anything was preserved: false for a genuine no-op, so the caller can still
   * clean the worktree up. Unlike commitAndPush this never throws
   * EmptyCommitError — parking a no-op run is an expected, non-exceptional path.
   */
  async commitAndPushForHuman(wt: Worktree, message: string): Promise<boolean> {
    if (!(await this.stageForPush(wt, message))) return false;
    // A branch handed to a human must carry the same attribution guarantee as a
    // PR branch (issue #248): scrub any trailer before it leaves the box.
    await this.stripAttributionFromHistory(wt);
    await this.git(["push", "-u", "origin", wt.branch], wt.path);
    return true;
  }

  /**
   * Scrub AI-attribution trailers from the commits the worktree added on top of
   * its base. The range `base..HEAD` is local-only (never yet pushed), so the
   * replay keeps every caller's push fast-forward. Commits with clean messages
   * are replayed verbatim; only attributed ones are amended.
   */
  private async stripAttributionFromHistory(wt: Worktree): Promise<void> {
    if (!wt.base) return;
    const out = (await this.git(["rev-list", "--reverse", `${wt.base}..HEAD`], wt.path)).trim();
    if (!out) return;
    const shas = out.split("\n");

    const commits: { sha: string; original: string; cleaned: string }[] = [];
    let needsRewrite = false;
    for (const sha of shas) {
      const original = (await this.git(["log", "-1", "--format=%B", sha], wt.path)).replace(
        /\s+$/,
        "",
      );
      const cleaned = stripAiAttribution(original);
      commits.push({ sha, original, cleaned });
      if (cleaned !== original) needsRewrite = true;
    }
    if (!needsRewrite) return;

    // Replay the range from the base, rewriting only the offending messages.
    await this.git(["reset", "--hard", wt.base], wt.path);
    for (const commit of commits) {
      await this.git(["cherry-pick", commit.sha], wt.path);
      if (commit.cleaned !== commit.original) {
        await this.git(["commit", "--amend", "-m", nonEmptyCommitMessage(commit.cleaned)], wt.path);
      }
    }
  }

  async remove(wt: Worktree, repoPath: string): Promise<void> {
    await this.withRepoLock(repoPath, async () => {
      await this.git(["-C", repoPath, "worktree", "remove", "--force", wt.path]);
      await this.git(["-C", repoPath, "worktree", "prune"]);
    });
  }
}
