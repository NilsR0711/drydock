process.env.DRYDOCK_DB = ":memory:";

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DB, getDb } from "@/lib/db/client";
import { issues, jobEvents, jobs, repos, settings } from "@/lib/db/schema";
import { __setForgeFactory } from "@/lib/forge/registry";
import { type ToolDef, tools } from "@/lib/mcp/tools";
import { setDrainMode } from "@/lib/orchestrator/runtime";
import { saveSettings } from "@/lib/settings/service";

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
    saveSettings({ paused: false, dailyCostLimitUsd: 10 }, db);
    setDrainMode(false);
    gh = fakeGh();
    __setForgeFactory(() => gh as never);
  });

  afterEach(() => {
    setDrainMode(false);
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

  it("set_drain_mode toggles the runtime drain flag", async () => {
    const result = (await run("set_drain_mode", { on: true }, db)) as { draining: boolean };
    expect(result.draining).toBe(true);
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
      setDrainMode(true);
      await expect(run("add_to_queue", { repoId, issueNumber: 3 }, db)).rejects.toThrow(/drain/i);
    });

    it("requeue_job is refused while draining", async () => {
      const repoId = seedRepo(db);
      const job = db
        .insert(jobs)
        .values({ repoId, issueNumber: 5, status: "needs_human", agent: "claude" })
        .returning()
        .get();
      setDrainMode(true);
      await expect(run("requeue_job", { jobId: job.id }, db)).rejects.toThrow(/drain/i);
    });

    it("set_drain_mode and update_settings stay usable while paused (recovery path)", async () => {
      saveSettings({ paused: true }, db);
      await expect(run("set_drain_mode", { on: false }, db)).resolves.toBeDefined();
      await expect(run("update_settings", { paused: false }, db)).resolves.toBeDefined();
    });
  });
});
