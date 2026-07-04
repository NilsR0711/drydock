import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { DeploymentHealingSession, Job, Repo } from "@/lib/db/schema";
import type { ForgeClient } from "@/lib/forge/types";
import { logError } from "@/lib/log/logger";
import type {
  DeploymentPlatformAdapter,
  DeploymentStatus,
} from "@/lib/orchestrator/deployment/adapter";
import {
  DEFAULT_DEPLOYMENT_HEAL_BUDGETS,
  type DeploymentHealBudgets,
  getDeploymentHealingSession,
  recentDeploymentHealingSessions,
} from "@/lib/orchestrator/deployment-healing";
import {
  deploymentFixPrompt,
  driveDeploymentHealing,
} from "@/lib/orchestrator/deployment-healing-driver";
import { createJob, transitionJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";

// The driver imports logError directly; replace only that export so a swallowed
// getLogs rejection is observable (issue #423) while the rest of the sink stays real.
vi.mock("@/lib/log/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/log/logger")>()),
  logError: vi.fn(),
}));

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
  vi.mocked(logError).mockClear();
});

function mergedJob(repo: Repo, issue: number, pr: number): Job {
  const j = createJob({ repoId: repo.id, issueNumber: issue }, db);
  transitionJob(j.id, "working", {}, db);
  transitionJob(j.id, "ci_running", { prNumber: pr, branch: "b" }, db);
  return transitionJob(j.id, "merged", { prNumber: pr }, db);
}

function adapterStub(status: DeploymentStatus, logs = "build error"): DeploymentPlatformAdapter {
  return {
    id: "vercel",
    label: "Vercel",
    detect: vi.fn(async () => true),
    getStatus: vi.fn(async () => status),
    getLogs: vi.fn(async () => logs),
  };
}

function forgeStub(headSha = "deadbeef"): ForgeClient {
  return { prHeadSha: vi.fn(async () => headSha) } as unknown as ForgeClient;
}

const budgets: DeploymentHealBudgets = {
  ...DEFAULT_DEPLOYMENT_HEAL_BUDGETS,
  initialDelayMs: 0,
  intervalMs: 0,
};

describe("driveDeploymentHealing — selection", () => {
  it("skips repos that have not opted in", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoHealDeployments: false }, db);
    mergedJob(repo, 1, 5);
    const adapterFor = vi.fn(async () => adapterStub("ready"));
    await driveDeploymentHealing({ db, forgeFor: () => forgeStub(), adapterFor, budgets });
    expect(adapterFor).not.toHaveBeenCalled();
  });

  it("skips repos with no detectable deployment platform", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoHealDeployments: true }, db);
    mergedJob(repo, 1, 5);
    const openFixPr = vi.fn(async () => 0);
    await driveDeploymentHealing({
      db,
      forgeFor: () => forgeStub(),
      adapterFor: async () => null,
      openFixPr,
      budgets,
    });
    expect(openFixPr).not.toHaveBeenCalled();
    expect(recentDeploymentHealingSessions(repo.id, db)).toHaveLength(0);
  });
});

describe("driveDeploymentHealing — monitoring", () => {
  it("marks a healthy deployment as healthy without opening a fix PR", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoHealDeployments: true }, db);
    mergedJob(repo, 1, 5);
    const openFixPr = vi.fn(async () => 99);
    await driveDeploymentHealing({
      db,
      forgeFor: () => forgeStub(),
      adapterFor: async () => adapterStub("ready"),
      openFixPr,
      budgets,
    });
    const rows = recentDeploymentHealingSessions(repo.id, db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("healthy");
    expect(openFixPr).not.toHaveBeenCalled();
  });

  it("stays monitoring while the deployment is still building", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoHealDeployments: true }, db);
    mergedJob(repo, 1, 5);
    await driveDeploymentHealing({
      db,
      forgeFor: () => forgeStub(),
      adapterFor: async () => adapterStub("building"),
      budgets,
    });
    expect(recentDeploymentHealingSessions(repo.id, db)[0]?.status).toBe("monitoring");
  });

  it("opens a follow-up fix PR with captured logs on a failed deployment", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoHealDeployments: true }, db);
    const job = mergedJob(repo, 1, 5);
    const openFixPr = vi.fn(
      async (_r: Repo, _j: Job, _s: DeploymentHealingSession, _l: string) => 77,
    );
    await driveDeploymentHealing({
      db,
      forgeFor: () => forgeStub("cafe123"),
      adapterFor: async () => adapterStub("error", "TypeError: boom\nline2"),
      openFixPr,
      budgets,
    });
    expect(openFixPr).toHaveBeenCalledTimes(1);
    const call = openFixPr.mock.calls[0];
    if (!call) throw new Error("expected openFixPr call");
    const [, passedJob, session, logs] = call;
    expect(passedJob.id).toBe(job.id);
    expect(session.commitSha).toBe("cafe123");
    expect(logs).toContain("TypeError: boom");
    const rows = recentDeploymentHealingSessions(repo.id, db);
    expect(rows[0]?.status).toBe("repaired");
    expect(rows[0]?.followupPrNumber).toBe(77);
  });

  it("logs the failure but still opens the fix PR when log capture rejects", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoHealDeployments: true }, db);
    mergedJob(repo, 1, 5);
    const adapter = adapterStub("error");
    (adapter.getLogs as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("log stream timed out"),
    );
    const openFixPr = vi.fn(
      async (_r: Repo, _j: Job, _s: DeploymentHealingSession, _l: string) => 88,
    );
    await driveDeploymentHealing({
      db,
      forgeFor: () => forgeStub(),
      adapterFor: async () => adapter,
      openFixPr,
      budgets,
    });
    // Healing still proceeds: fix PR opens with empty logs and the session is repaired.
    expect(openFixPr).toHaveBeenCalledTimes(1);
    expect(openFixPr.mock.calls[0]?.[3]).toBe("");
    const rows = recentDeploymentHealingSessions(repo.id, db);
    expect(rows[0]?.status).toBe("repaired");
    const sessionId = rows[0]?.id;
    expect(getDeploymentHealingSession(sessionId as number, db)?.logsExcerpt).toBeNull();
    // But the swallowed failure is now traceable: session id + underlying error.
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining(`session ${sessionId}`),
      expect.any(Error),
    );
  });

  it("escalates when the fix PR cannot be opened", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoHealDeployments: true }, db);
    mergedJob(repo, 1, 5);
    await driveDeploymentHealing({
      db,
      forgeFor: () => forgeStub(),
      adapterFor: async () => adapterStub("error"),
      openFixPr: async () => {
        throw new Error("agent failed");
      },
      budgets,
    });
    expect(recentDeploymentHealingSessions(repo.id, db)[0]?.status).toBe("escalated");
  });

  it("escalates a deployment that never settles past the timeout", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoHealDeployments: true }, db);
    mergedJob(repo, 1, 5);
    const adapter = adapterStub("building");
    // First sweep opens the session and polls (still building → monitoring).
    await driveDeploymentHealing({
      db,
      forgeFor: () => forgeStub(),
      adapterFor: async () => adapter,
      budgets,
    });
    // A much later sweep is past the timeout → escalate without polling again.
    const callsBefore = (adapter.getStatus as ReturnType<typeof vi.fn>).mock.calls.length;
    await driveDeploymentHealing({
      db,
      forgeFor: () => forgeStub(),
      adapterFor: async () => adapter,
      budgets,
      now: () => Date.now() + budgets.timeoutMs + 1000,
    });
    expect(recentDeploymentHealingSessions(repo.id, db)[0]?.status).toBe("escalated");
    expect((adapter.getStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  it("ignores merged jobs older than the monitor window", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoHealDeployments: true }, db);
    mergedJob(repo, 1, 5);
    await driveDeploymentHealing({
      db,
      forgeFor: () => forgeStub(),
      adapterFor: async () => adapterStub("error"),
      openFixPr: async () => 1,
      budgets,
      now: () => Date.now() + budgets.monitorWindowMs + 60_000,
    });
    expect(recentDeploymentHealingSessions(repo.id, db)).toHaveLength(0);
  });
});

describe("deploymentFixPrompt", () => {
  it("includes the PR, platform, and logs", () => {
    const prompt = deploymentFixPrompt(
      {
        id: 1,
        jobId: 1,
        prNumber: 5,
        platform: "vercel",
        commitSha: "abcdef1234",
        status: "failed",
        logsExcerpt: null,
        followupPrNumber: null,
        createdAt: 0,
        updatedAt: 0,
      },
      "TypeError: boom",
    );
    expect(prompt).toContain("#5");
    expect(prompt).toContain("vercel");
    expect(prompt).toContain("TypeError: boom");
  });
});
