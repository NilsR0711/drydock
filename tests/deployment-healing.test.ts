import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import {
  classifyDeploymentStatus,
  deploymentSessionExists,
  getDeploymentHealingSession,
  openDeploymentHealingSession,
  pollGate,
  recentDeploymentHealingSessions,
  touchDeploymentHealingSession,
  transitionDeploymentHealingSession,
} from "@/lib/orchestrator/deployment-healing";
import { createJob, transitionJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

function mergedJob(repoId: number, issue: number, pr: number) {
  const j = createJob({ repoId, issueNumber: issue }, db);
  transitionJob(j.id, "working", {}, db);
  transitionJob(j.id, "ci_running", { prNumber: pr, branch: "b" }, db);
  return transitionJob(j.id, "merged", { prNumber: pr }, db);
}

describe("classifyDeploymentStatus", () => {
  it("maps platform statuses to outcomes", () => {
    expect(classifyDeploymentStatus("ready")).toBe("ready");
    expect(classifyDeploymentStatus("error")).toBe("error");
    expect(classifyDeploymentStatus("building")).toBe("pending");
    expect(classifyDeploymentStatus("deploying")).toBe("pending");
    expect(classifyDeploymentStatus("not_found")).toBe("pending");
  });
});

describe("pollGate", () => {
  const base = { initialDelayMs: 100, intervalMs: 50, timeoutMs: 1000 };

  it("waits during the initial delay", () => {
    expect(pollGate({ createdAt: 0, lastPolledAt: 0, now: 50, ...base })).toBe("wait");
  });

  it("polls once the initial delay has elapsed and never polled", () => {
    expect(pollGate({ createdAt: 0, lastPolledAt: 0, now: 100, ...base })).toBe("poll");
  });

  it("waits between polls until the interval elapses", () => {
    expect(pollGate({ createdAt: 0, lastPolledAt: 100, now: 120, ...base })).toBe("wait");
    expect(pollGate({ createdAt: 0, lastPolledAt: 100, now: 160, ...base })).toBe("poll");
  });

  it("times out after the deadline regardless of poll cadence", () => {
    expect(pollGate({ createdAt: 0, lastPolledAt: 900, now: 1000, ...base })).toBe("timeout");
  });
});

describe("deployment-healing persistence", () => {
  it("opens a session once per merged commit and detects duplicates", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    const job = mergedJob(repo.id, 1, 7);
    expect(deploymentSessionExists(job.id, "sha1", db)).toBe(false);
    const s1 = openDeploymentHealingSession(job.id, 7, "vercel", "sha1", db);
    expect(s1.status).toBe("monitoring");
    expect(deploymentSessionExists(job.id, "sha1", db)).toBe(true);
    // Re-opening the same (job, commit) returns the existing session.
    const s2 = openDeploymentHealingSession(job.id, 7, "vercel", "sha1", db);
    expect(s2.id).toBe(s1.id);
  });

  it("transitions a session and records the follow-up PR", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    const job = mergedJob(repo.id, 1, 7);
    const s = openDeploymentHealingSession(job.id, 7, "vercel", "sha1", db);
    transitionDeploymentHealingSession(s.id, "failed", { logsExcerpt: "boom" }, db);
    transitionDeploymentHealingSession(s.id, "repairing", {}, db);
    const repaired = transitionDeploymentHealingSession(
      s.id,
      "repaired",
      { followupPrNumber: 42 },
      db,
    );
    expect(repaired.status).toBe("repaired");
    expect(repaired.followupPrNumber).toBe(42);
    expect(getDeploymentHealingSession(s.id, db)?.logsExcerpt).toBe("boom");
  });

  it("rejects an invalid transition", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    const job = mergedJob(repo.id, 1, 7);
    const s = openDeploymentHealingSession(job.id, 7, "vercel", "sha1", db);
    expect(() => transitionDeploymentHealingSession(s.id, "repaired", {}, db)).toThrow();
  });

  it("touch bumps the poll clock without changing status", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    const job = mergedJob(repo.id, 1, 7);
    const s = openDeploymentHealingSession(job.id, 7, "vercel", "sha1", db);
    touchDeploymentHealingSession(s.id, db);
    expect(getDeploymentHealingSession(s.id, db)?.status).toBe("monitoring");
  });

  it("summarises recent sessions for a repo with the issue number", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    const job = mergedJob(repo.id, 11, 7);
    openDeploymentHealingSession(job.id, 7, "railway", "sha1", db);
    const rows = recentDeploymentHealingSessions(repo.id, db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ issueNumber: 11, prNumber: 7, platform: "railway" });
  });
});
