import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { driveTick } from "@/lib/orchestrator/driver-loop";
import { createJob, getJob, listJobs } from "@/lib/orchestrator/jobs";
import { setDrainMode } from "@/lib/orchestrator/runtime";
import { addRepo, updateRepo } from "@/lib/repos/service";
import { getSettings, saveSettings } from "@/lib/settings/service";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

describe("repo agent configuration", () => {
  it("defaults a repo's agent to claude (no regression)", () => {
    const repo = addRepo({ path: "/tmp/r", name: "r" }, db);
    expect(repo.agent).toBe("claude");
  });

  it("stores a per-repo agent override", () => {
    const repo = addRepo({ path: "/tmp/r", name: "r", agent: "codex" }, db);
    expect(repo.agent).toBe("codex");
    const updated = updateRepo(repo.id, { agent: "claude" }, db);
    expect(updated.agent).toBe("claude");
  });
});

describe("job agent configuration", () => {
  it("defaults a job's agent to claude", () => {
    const repo = addRepo({ path: "/tmp/r", name: "r" }, db);
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    expect(getJob(job.id, db)?.agent).toBe("claude");
  });

  it("records the agent the job runs under", () => {
    const repo = addRepo({ path: "/tmp/r", name: "r", agent: "codex" }, db);
    const job = createJob({ repoId: repo.id, issueNumber: 1, agent: repo.agent }, db);
    expect(getJob(job.id, db)?.agent).toBe("codex");
  });
});

describe("driver loop agent inheritance", () => {
  it("creates jobs under the repo's configured agent", async () => {
    setDrainMode(false);
    const repo = addRepo({ path: "/repo", name: "acme", agent: "codex", sequential: false }, db);
    await driveTick({
      db,
      fetchIssues: vi.fn(async () => [
        { number: 7, title: "Bug", labels: [{ name: repo.queueLabel }] },
      ]),
      runJob: vi.fn(async (id: number) => getJob(id, db) as never),
    });
    const job = listJobs(repo.id, db).find((j) => j.issueNumber === 7);
    expect(job?.agent).toBe("codex");
  });
});

describe("settings agent defaults", () => {
  it("defaults to the claude agent and codex CLI path", () => {
    const s = getSettings(db);
    expect(s.defaultAgent).toBe("claude");
    expect(s.codexPath).toBe("codex");
  });

  it("persists a different default agent", () => {
    saveSettings({ defaultAgent: "codex" }, db);
    expect(getSettings(db).defaultAgent).toBe("codex");
  });
});
