import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import { spawnRunner } from "@/lib/exec/runner";
import { repoWorktreesDir } from "@/lib/git/worktree";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { type RunJobDeps, runJob } from "@/lib/orchestrator/run-job";
import { addRepo } from "@/lib/repos/service";
import { sessionResult } from "./helpers/run-job-deps";

// Partial integration coverage of the run-job ↔ WorktreeManager seam (issue
// #385). Every other suite injects a fake `worktrees`, so real-git behaviour —
// prepare, commitAndPush, commitAndPushForHuman (preserve semantics),
// prepareResume — is never exercised end to end and could drift while the whole
// suite stays green. Here runJob runs with its DEFAULT (real) WorktreeManager
// against a throwaway bare git remote; only the pieces that cannot run in CI are
// faked: the agent session (a stub that writes a file into the worktree) and the
// forge (createPr / babysitter). Assertions are on actual git state — the branch
// and commits on the remote — not mock call counts. No network, no real
// claude/gh.

/** Run a git command, throwing its stderr on failure. */
async function git(args: string[], cwd: string): Promise<string> {
  const r = await spawnRunner("git", args, cwd);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} (${cwd}): ${r.stderr.trim()}`);
  return r.stdout;
}

/** The subject lines of every commit reachable from a ref on the bare remote. */
function remoteSubjects(origin: string, ref: string): Promise<string> {
  return git(["log", ref, "--format=%s"], origin);
}

/** The blob content of `path` at `ref` on the bare remote. */
function remoteFile(origin: string, ref: string, path: string): Promise<string> {
  return git(["show", `${ref}:${path}`], origin);
}

const REPO_NAME = "acme-integ";
const originalHome = process.env.DRYDOCK_HOME;

let root = "";
let origin = "";
let clone = "";
let db: DB;
let repoId: number;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "drydock-runjob-integ-"));
  // App-owned worktrees land under DRYDOCK_HOME; keep them inside the temp root
  // so the real rmSync in WorktreeManager.prepare never touches ~/.drydock.
  process.env.DRYDOCK_HOME = join(root, "home");

  origin = join(root, "origin.git");
  clone = join(root, "clone");
  const seed = join(root, "seed");

  // A bare origin seeded with one commit on main, then the clone Drydock manages.
  await git(["init", "--bare", "-b", "main", origin], root);
  await git(["init", "-b", "main", seed], root);
  await git(["config", "user.email", "dev@example.com"], seed);
  await git(["config", "user.name", "Dev"], seed);
  await git(["remote", "add", "origin", origin], seed);
  writeFileSync(join(seed, "README.md"), "base\n");
  await git(["add", "-A"], seed);
  await git(["commit", "-m", "chore: init"], seed);
  await git(["push", "origin", "main"], seed);
  await git(["clone", origin, clone], root);
  // Worktree commits inherit the clone's identity; set one so headless CI (no
  // global git identity) can still commit.
  await git(["config", "user.email", "dev@example.com"], clone);
  await git(["config", "user.name", "Dev"], clone);

  db = createDb(":memory:");
  repoId = addRepo({ path: clone, name: REPO_NAME, defaultBranch: "main" }, db).id;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.DRYDOCK_HOME;
  else process.env.DRYDOCK_HOME = originalHome;
});

/** The path WorktreeManager derives for a job's worktree under DRYDOCK_HOME. */
function worktreePath(jobId: number): string {
  return join(repoWorktreesDir(REPO_NAME), `job-${jobId}`);
}

/**
 * A scripted-forge dependency bundle for the integration flow: the agent
 * session writes a file into the real worktree, the forge opens PR #77, and the
 * babysitter merges. `worktrees` is deliberately absent so runJob defaults to
 * the real WorktreeManager. Best-effort/side passes are stubbed to no-ops so no
 * real gh/claude is spawned.
 */
function integrationDeps(over: Partial<RunJobDeps> = {}): RunJobDeps {
  return {
    db,
    runSession: vi.fn(async (_job, _prompt, cwd) => {
      writeFileSync(join(cwd, "change.txt"), "agent change\n");
      return sessionResult();
    }),
    createPr: vi.fn(async () => 77),
    runBabysitter: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, job.id)).run();
      return getJob(job.id, db) as Job;
    }),
    viewIssue: vi.fn(async () => ({ title: "", body: "" })),
    verify: vi.fn(async () => {}),
    audit: vi.fn(async () => null),
    announceNeedsHuman: vi.fn(async () => {}),
    adoptClaudeMem: vi.fn(async () => {}),
    commentIssue: vi.fn(async () => {}),
    markNeedsHuman: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    ...over,
  };
}

describe("runJob against the real WorktreeManager (issue #385)", () => {
  it("happy path: prepares, commits the agent's work, opens a PR from the real branch, and cleans up", async () => {
    const deps = integrationDeps();
    const job = createJob({ repoId, issueNumber: 1 }, db);

    const result = await runJob(job.id, deps);

    expect(result.status).toBe("merged");
    expect(result.prNumber).toBe(77);

    const branch = "drydock/issue-1-job-1";
    // The PR was opened from the branch the real WorktreeManager.prepare cut.
    expect(deps.createPr).toHaveBeenCalledWith(
      expect.objectContaining({ head: branch, base: "main" }),
    );
    // The real commitAndPush committed the agent's file and pushed it to origin.
    expect(await remoteSubjects(origin, branch)).toContain("Fix #1");
    expect(await remoteFile(origin, branch, "change.txt")).toContain("agent change");
    // The merged worktree is removed.
    expect(existsSync(worktreePath(job.id))).toBe(false);
  }, 20000);

  it("preserve path: a failed session pushes the partial work via commitAndPushForHuman and parks the job", async () => {
    const deps = integrationDeps({
      runSession: vi.fn(async (_job, _prompt, cwd) => {
        writeFileSync(join(cwd, "partial.txt"), "partial work\n");
        return sessionResult({ exitCode: 1 });
      }),
    });
    const job = createJob({ repoId, issueNumber: 2 }, db);

    const result = await runJob(job.id, deps);

    expect(result.status).toBe("needs_human");
    expect(deps.createPr).not.toHaveBeenCalled();

    const branch = "drydock/issue-2-job-1";
    // commitAndPushForHuman preserved the partial work: the branch is recorded on
    // the job and its commit reached origin (its boolean "was anything preserved"
    // contract, issue #249, exercised against real git rather than a fake).
    expect(result.branch).toBe(branch);
    expect(await remoteSubjects(origin, branch)).toContain("wip: park #2 for human review");
    expect(await remoteFile(origin, branch, "partial.txt")).toContain("partial work");
    // A preserved needs_human worktree is deliberately kept for a later resume.
    expect(existsSync(worktreePath(job.id))).toBe(true);
  }, 20000);

  it("resume path: prepareResume restores the preserved branch so the run builds on its commits", async () => {
    const job = createJob({ repoId, issueNumber: 3 }, db);
    const branch = `drydock/issue-3-job-${job.id}`;

    // Seed the preserved branch on origin exactly as a parked run would have left
    // it (issue #249), then drop the local ref so prepareResume must restore it
    // from origin (issue #257).
    await git(["checkout", "-b", branch, "origin/main"], clone);
    writeFileSync(join(clone, "preserved.txt"), "preserved work\n");
    await git(["add", "-A"], clone);
    await git(["commit", "-m", "wip: preserved work"], clone);
    await git(["push", "-u", "origin", branch], clone);
    await git(["checkout", "main"], clone);
    await git(["branch", "-D", branch], clone);

    // The operator unblocked the parked job with a typed instruction: it is
    // requeued carrying the preserved branch + instruction, with no resumable
    // session id — so runJob checks the branch out via prepareResume and runs a
    // fresh session on top of it.
    db.update(jobs)
      .set({ branch, humanInstruction: "please finish it" })
      .where(eq(jobs.id, job.id))
      .run();

    const deps = integrationDeps({
      runSession: vi.fn(async (_job, _prompt, cwd) => {
        writeFileSync(join(cwd, "resume.txt"), "resumed work\n");
        return sessionResult();
      }),
    });

    const result = await runJob(job.id, deps);

    expect(result.status).toBe("merged");
    // The PR is opened from the preserved branch, not a fresh cut.
    expect(deps.createPr).toHaveBeenCalledWith(
      expect.objectContaining({ head: branch, base: "main" }),
    );
    // Both commits live on the branch: prepareResume restored the parked work, so
    // the resume commit sits on top of it. A fresh cut from main would have lost
    // preserved.txt.
    expect(await remoteFile(origin, branch, "preserved.txt")).toContain("preserved work");
    expect(await remoteFile(origin, branch, "resume.txt")).toContain("resumed work");
    expect((await git(["rev-list", "--count", `main..${branch}`], origin)).trim()).toBe("2");
  }, 20000);
});
