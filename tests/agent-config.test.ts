import { beforeEach, describe, expect, it, vi } from "vitest";
import { opencodeProvider } from "@/lib/agents/opencode";
import { createDb, type DB } from "@/lib/db/client";
import { commandForAgent } from "@/lib/orchestrator/agent-command";
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
      credentialProbe: async () => {},
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

  it("defaults the opencode CLI path to the binary on PATH (issue #349)", () => {
    expect(getSettings(db).opencodePath).toBe("opencode");
  });

  it("persists a custom opencode CLI path (issue #349)", () => {
    saveSettings({ opencodePath: "/usr/local/bin/opencode" }, db);
    expect(getSettings(db).opencodePath).toBe("/usr/local/bin/opencode");
  });

  it("persists a different default agent", () => {
    saveSettings({ defaultAgent: "codex" }, db);
    expect(getSettings(db).defaultAgent).toBe("codex");
  });
});

describe("opencode repo configuration (issue #349)", () => {
  it("stores opencode as a per-repo agent with a provider/model id", () => {
    const repo = addRepo(
      {
        path: "/tmp/oc",
        name: "oc",
        agent: "opencode",
        defaultModel: "anthropic/claude-sonnet-4-6",
      },
      db,
    );
    expect(repo.agent).toBe("opencode");
    expect(repo.defaultModel).toBe("anthropic/claude-sonnet-4-6");
  });

  it("rejects a non provider/model id for opencode", () => {
    expect(() =>
      addRepo(
        { path: "/tmp/bad", name: "bad", agent: "opencode", defaultModel: "claude-opus-4-8" },
        db,
      ),
    ).toThrow(/provider\/model/);
  });

  it("rejects switching to opencode while the model is a static CLI id", () => {
    const repo = addRepo({ path: "/tmp/sw", name: "sw" }, db);
    expect(() => updateRepo(repo.id, { agent: "opencode" }, db)).toThrow(/provider\/model/);
  });

  it("resolves the opencode CLI binary path for the opencode provider", () => {
    saveSettings({ opencodePath: "/opt/opencode" }, db);
    expect(commandForAgent(opencodeProvider, db)).toBe("/opt/opencode");
  });
});
