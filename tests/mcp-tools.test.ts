process.env.DRYDOCK_DB = ":memory:";

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DB, getDb } from "@/lib/db/client";
import { issues, jobEvents, jobs, repos, settings } from "@/lib/db/schema";
import { __setForgeFactory } from "@/lib/forge/registry";
import { type ToolDef, tools } from "@/lib/mcp/tools";
import { getSettings, saveSettings } from "@/lib/settings/service";

function tool(name: string): ToolDef {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

// Wrap in an async IIFE so a synchronous throw surfaces as a rejected promise,
// matching how the MCP SDK awaits handlers.
async function run(name: string, args: Record<string, unknown>, db: DB): Promise<unknown> {
  return tool(name).handler(args, { db });
}

function fakeGh() {
  return {
    ensureLabel: vi.fn(async () => {}),
    addLabels: vi.fn(async () => {}),
    removeLabels: vi.fn(async () => {}),
    listAllIssues: vi.fn(async () => [{ number: 7, title: "Fetched", labels: [{ name: "bug" }] }]),
  };
}

function seedRepo(db: DB, queueLabel = "drydock:queue"): number {
  return db.insert(repos).values({ path: "/r", name: "r", queueLabel }).returning().get().id;
}

describe("MCP tool registry", () => {
  let db: DB;
  let gh: ReturnType<typeof fakeGh>;

  beforeEach(() => {
    db = getDb();
    db.delete(jobEvents).run();
    db.delete(jobs).run();
    db.delete(issues).run();
    db.delete(repos).run();
    db.delete(settings).run();
    saveSettings({ paused: false, draining: false, dailyCostLimitUsd: 10 }, db);
    gh = fakeGh();
    __setForgeFactory(() => gh as never);
  });

  afterEach(() => {
    __setForgeFactory(null);
  });

  it("registers exactly the documented tool set", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "abort_job",
        "add_repo",
        "add_to_queue",
        "get_job",
        "get_logs",
        "get_settings",
        "list_issues",
        "list_jobs",
        "list_repos",
        "remove_from_queue",
        "requeue_job",
        "resume_job_with_instruction",
        "run_pr_audit",
        "set_drain_mode",
        "set_issue_labels",
        "sync_repo_issues",
        "update_settings",
      ].sort(),
    );
  });

  it("every tool has a description and an input schema object", () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(typeof t.inputSchema).toBe("object");
    }
  });

  it("list_repos returns the repos from the service layer", async () => {
    seedRepo(db);
    const result = (await run("list_repos", {}, db)) as Array<{ name: string }>;
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("r");
  });

  it("add_repo inserts a repo through the service layer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drydock-mcp-"));
    mkdirSync(join(dir, ".git"));
    try {
      const result = (await run("add_repo", { path: dir, name: "proj" }, db)) as { id: number };
      expect(result.id).toBeGreaterThan(0);
      expect(db.select().from(repos).all()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("add_repo detects the clone's default branch when none is given (issue #210)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drydock-mcp-branch-"));
    // A real repo whose HEAD is on `master`, the exact case that used to fail
    // the first job with "invalid ref: main".
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "symbolic-ref", "HEAD", "refs/heads/master"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Tester"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"]);
    try {
      const result = (await run("add_repo", { path: dir, name: "proj" }, db)) as { id: number };
      const row = db.select().from(repos).where(eq(repos.id, result.id)).get();
      expect(row?.defaultBranch).toBe("master");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("add_repo stores an explicitly provided default branch (issue #210)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drydock-mcp-explicit-"));
    mkdirSync(join(dir, ".git"));
    try {
      const result = (await run(
        "add_repo",
        { path: dir, name: "proj", defaultBranch: "trunk" },
        db,
      )) as { id: number };
      const row = db.select().from(repos).where(eq(repos.id, result.id)).get();
      expect(row?.defaultBranch).toBe("trunk");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("add_repo rejects a non-existent / non-git path (issue #110)", async () => {
    await expect(
      run("add_repo", { path: join(tmpdir(), "drydock-nope-xyz"), name: "proj" }, db),
    ).rejects.toThrow();
    const dir = mkdtempSync(join(tmpdir(), "drydock-mcp-nogit-"));
    try {
      await expect(run("add_repo", { path: dir, name: "proj" }, db)).rejects.toThrow();
      expect(db.select().from(repos).all()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("list_issues returns the cached issues for a repo", async () => {
    const repoId = seedRepo(db);
    db.insert(issues).values({ repoId, number: 1, title: "i", labels: "[]", priority: 0 }).run();
    const result = (await run("list_issues", { repoId }, db)) as unknown[];
    expect(result).toHaveLength(1);
  });

  it("sync_repo_issues fetches from the forge and caches", async () => {
    const repoId = seedRepo(db);
    const result = (await run("sync_repo_issues", { repoId }, db)) as unknown[];
    expect(gh.listAllIssues).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
  });

  it("add_to_queue applies the queue label via the forge", async () => {
    const repoId = seedRepo(db);
    db.insert(issues).values({ repoId, number: 3, title: "i", labels: "[]", priority: 0 }).run();
    await run("add_to_queue", { repoId, issueNumber: 3 }, db);
    expect(gh.addLabels).toHaveBeenCalledWith(3, ["drydock:queue"]);
  });

  it("remove_from_queue removes the queue label via the forge", async () => {
    const repoId = seedRepo(db);
    db.insert(issues)
      .values({ repoId, number: 3, title: "i", labels: '["drydock:queue"]', priority: 0 })
      .run();
    await run("remove_from_queue", { repoId, issueNumber: 3 }, db);
    expect(gh.removeLabels).toHaveBeenCalledWith(3, ["drydock:queue"]);
  });

  it("set_issue_labels adds and removes labels via the forge", async () => {
    const repoId = seedRepo(db);
    db.insert(issues).values({ repoId, number: 3, title: "i", labels: "[]", priority: 0 }).run();
    await run(
      "set_issue_labels",
      { repoId, issueNumber: 3, add: ["bug"], remove: ["wontfix"] },
      db,
    );
    expect(gh.addLabels).toHaveBeenCalledWith(3, ["bug"]);
    expect(gh.removeLabels).toHaveBeenCalledWith(3, ["wontfix"]);
  });

  it("list_jobs and get_job round-trip a job", async () => {
    const repoId = seedRepo(db);
    const job = db
      .insert(jobs)
      .values({ repoId, issueNumber: 5, status: "queued", agent: "claude" })
      .returning()
      .get();
    const list = (await run("list_jobs", { repoId }, db)) as unknown[];
    expect(list).toHaveLength(1);
    const got = (await run("get_job", { jobId: job.id }, db)) as { id: number };
    expect(got.id).toBe(job.id);
  });

  it("get_job throws for an unknown job", async () => {
    await expect(run("get_job", { jobId: 999 }, db)).rejects.toThrow(/999/);
  });

  it("requeue_job transitions a needs_human job back to queued", async () => {
    const repoId = seedRepo(db);
    const job = db
      .insert(jobs)
      .values({ repoId, issueNumber: 5, status: "needs_human", agent: "claude" })
      .returning()
      .get();
    const result = (await run("requeue_job", { jobId: job.id }, db)) as { status: string };
    expect(result.status).toBe("queued");
  });

  it("requeue_job escalates the model when the repo opted in (issue #179)", async () => {
    const repoId = db
      .insert(repos)
      .values({ path: "/r", name: "r", escalateModelOnRetry: true })
      .returning()
      .get().id;
    const job = db
      .insert(jobs)
      .values({
        repoId,
        issueNumber: 6,
        status: "needs_human",
        agent: "claude",
        model: "claude-haiku-4-5",
      })
      .returning()
      .get();
    const result = (await run("requeue_job", { jobId: job.id }, db)) as {
      status: string;
      model: string;
    };
    expect(result.status).toBe("queued");
    expect(result.model).toBe("claude-sonnet-4-5");
  });

  it("resume_job_with_instruction requeues a needs_human job carrying the instruction", async () => {
    const repoId = seedRepo(db);
    const job = db
      .insert(jobs)
      .values({ repoId, issueNumber: 9, status: "needs_human", agent: "claude", sessionId: "s1" })
      .returning()
      .get();
    const result = (await run(
      "resume_job_with_instruction",
      { jobId: job.id, instruction: "use the existing helper" },
      db,
    )) as { status: string; humanInstruction: string };
    expect(result.status).toBe("queued");
    expect(result.humanInstruction).toBe("use the existing helper");
  });

  it("resume_job_with_instruction rejects an empty instruction at the schema", async () => {
    const repoId = seedRepo(db);
    const job = db
      .insert(jobs)
      .values({ repoId, issueNumber: 10, status: "needs_human", agent: "claude" })
      .returning()
      .get();
    await expect(
      run("resume_job_with_instruction", { jobId: job.id, instruction: "" }, db),
    ).rejects.toThrow();
  });

  it("abort_job transitions a queued job to aborted", async () => {
    const repoId = seedRepo(db);
    const job = db
      .insert(jobs)
      .values({ repoId, issueNumber: 5, status: "queued", agent: "claude" })
      .returning()
      .get();
    const result = (await run("abort_job", { jobId: job.id }, db)) as { status: string };
    expect(result.status).toBe("aborted");
  });

  it("get_settings returns settings with secrets redacted", async () => {
    saveSettings({ telegramBotToken: "secret-token", slackWebhookUrl: "https://hooks/secret" }, db);
    const result = (await run("get_settings", {}, db)) as Record<string, unknown>;
    expect(result.telegramBotToken).toBe("***");
    expect(result.slackWebhookUrl).toBe("***");
    expect(result.paused).toBe(false);
  });

  it("get_settings does not mask empty secret fields", async () => {
    const result = (await run("get_settings", {}, db)) as Record<string, unknown>;
    expect(result.telegramBotToken).toBe("");
  });

  it("update_settings persists an allowed field and returns redacted settings", async () => {
    const result = (await run("update_settings", { paused: true }, db)) as Record<string, unknown>;
    expect(result.paused).toBe(true);
  });

  it("set_drain_mode persists the drain flag in settings (cross-process)", async () => {
    const result = (await run("set_drain_mode", { on: true }, db)) as { draining: boolean };
    expect(result.draining).toBe(true);
    // DB-backed, not in-memory: the orchestrator process polls settings, so the
    // flag must land there to have any effect (the MCP server is its own process).
    expect(getSettings(db).draining).toBe(true);
    const off = (await run("set_drain_mode", { on: false }, db)) as { draining: boolean };
    expect(off.draining).toBe(false);
    expect(getSettings(db).draining).toBe(false);
  });

  it("get_logs replays persisted job events", async () => {
    const repoId = seedRepo(db);
    const job = db
      .insert(jobs)
      .values({ repoId, issueNumber: 5, status: "queued", agent: "claude" })
      .returning()
      .get();
    db.insert(jobEvents).values({ jobId: job.id, type: "status", payload: "{}" }).run();
    const result = (await run("get_logs", { jobId: job.id }, db)) as unknown[];
    expect(result).toHaveLength(1);
  });

  describe("gates", () => {
    it("add_to_queue is refused while paused", async () => {
      const repoId = seedRepo(db);
      db.insert(issues).values({ repoId, number: 3, title: "i", labels: "[]", priority: 0 }).run();
      saveSettings({ paused: true }, db);
      await expect(run("add_to_queue", { repoId, issueNumber: 3 }, db)).rejects.toThrow(/paused/);
      expect(gh.addLabels).not.toHaveBeenCalled();
    });

    it("add_to_queue is refused while draining", async () => {
      const repoId = seedRepo(db);
      db.insert(issues).values({ repoId, number: 3, title: "i", labels: "[]", priority: 0 }).run();
      saveSettings({ draining: true }, db);
      await expect(run("add_to_queue", { repoId, issueNumber: 3 }, db)).rejects.toThrow(/drain/i);
    });

    it("requeue_job is refused while draining", async () => {
      const repoId = seedRepo(db);
      const job = db
        .insert(jobs)
        .values({ repoId, issueNumber: 5, status: "needs_human", agent: "claude" })
        .returning()
        .get();
      saveSettings({ draining: true }, db);
      await expect(run("requeue_job", { jobId: job.id }, db)).rejects.toThrow(/drain/i);
    });

    it("set_drain_mode and update_settings stay usable while paused (recovery path)", async () => {
      saveSettings({ paused: true }, db);
      await expect(run("set_drain_mode", { on: false }, db)).resolves.toBeDefined();
      await expect(run("update_settings", { paused: false }, db)).resolves.toBeDefined();
    });
  });
});

describe("run_pr_audit tool (issue #168)", () => {
  let db: DB;

  beforeEach(() => {
    db = getDb();
    db.delete(jobEvents).run();
    db.delete(jobs).run();
    db.delete(issues).run();
    db.delete(repos).run();
    db.delete(settings).run();
    saveSettings({ paused: false, draining: false, dailyCostLimitUsd: 10 }, db);
    // An empty diff makes the pass settle deterministically without spawning
    // any agent CLI: it records pr_audit_failed and posts nothing.
    __setForgeFactory(
      () =>
        ({
          prDiff: vi.fn(async () => ""),
          prChecks: vi.fn(async () => []),
          viewIssue: vi.fn(async () => {
            throw new Error("unused");
          }),
          commentIssue: vi.fn(async () => {}),
        }) as never,
    );
  });

  afterEach(() => {
    __setForgeFactory(null);
  });

  it("rejects a job without a PR", async () => {
    const repoId = seedRepo(db);
    const jobId = db
      .insert(jobs)
      .values({ repoId, issueNumber: 1, status: "queued" })
      .returning()
      .get().id;
    await expect(run("run_pr_audit", { jobId }, db)).rejects.toThrow(/no PR/i);
  });

  it("rejects while Drydock is paused", async () => {
    saveSettings({ paused: true }, db);
    const repoId = seedRepo(db);
    const jobId = db
      .insert(jobs)
      .values({ repoId, issueNumber: 1, status: "ci_running", prNumber: 7 })
      .returning()
      .get().id;
    await expect(run("run_pr_audit", { jobId }, db)).rejects.toThrow(/paused/i);
  });

  it("starts an audit for a job with an open PR", async () => {
    const repoId = seedRepo(db);
    const jobId = db
      .insert(jobs)
      .values({ repoId, issueNumber: 1, status: "ci_running", prNumber: 7 })
      .returning()
      .get().id;

    const result = (await run("run_pr_audit", { jobId }, db)) as Record<string, unknown>;
    expect(result.status).toBe("audit_started");
    expect(result.prNumber).toBe(7);

    await vi.waitFor(() => {
      const failed = db
        .select()
        .from(jobEvents)
        .all()
        .filter((e) => e.type === "pr_audit_failed");
      expect(failed).toHaveLength(1);
    });
  });
});
