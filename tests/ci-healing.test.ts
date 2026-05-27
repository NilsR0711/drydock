import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { healingAttempts, healingSessions } from "@/lib/db/schema";
import { classifyFailure } from "@/lib/orchestrator/ci-failure-classifier";
import {
  activeHealingRunCount,
  DEFAULT_HEAL_BUDGETS,
  finalizeHealingAttempt,
  fingerprintAttemptCount,
  type HealBudgets,
  openHealingSession,
  planHealAttempt,
  recentHealingSessions,
  recordHealingAttempt,
  sessionAttemptCount,
  transitionHealingSession,
  verifyHeal,
} from "@/lib/orchestrator/ci-healing";
import { createJob, transitionJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";

const heal = (name: string, output = "") =>
  classifyFailure("github", { name, state: "FAILURE" }, output);

const BUDGETS: HealBudgets = { ...DEFAULT_HEAL_BUDGETS, cooldownMs: 1000 };

describe("planHealAttempt", () => {
  const base = {
    attempts: [],
    lastAttemptAt: null,
    now: 10_000,
    activeRuns: 0,
    budgets: BUDGETS,
  };

  it("targets a healable failure for repair", () => {
    const d = planHealAttempt({ ...base, failures: [heal("typecheck", "error TS2322")] });
    expect(d.action).toBe("repair");
    if (d.action === "repair") expect(d.target.category).toBe("healable_in_branch");
  });

  it("re-runs a flaky failure rather than editing code", () => {
    const d = planHealAttempt({
      ...base,
      failures: [heal("e2e", "Test timed out after 30000ms")],
    });
    expect(d.action).toBe("rerun");
  });

  it("never repairs a blocked_external failure — it blocks", () => {
    const d = planHealAttempt({ ...base, failures: [heal("AI Review")] });
    expect(d.action).toBe("block");
  });

  it("escalates an unknown failure", () => {
    const d = planHealAttempt({ ...base, failures: [heal("mystery", "huh")] });
    expect(d.action).toBe("escalate");
  });

  it("heals the healable check even when a blocked check also fails", () => {
    const d = planHealAttempt({
      ...base,
      failures: [heal("AI Review"), heal("typecheck", "error TS1")],
    });
    expect(d.action).toBe("repair");
    if (d.action === "repair") expect(d.target.checkName).toBe("typecheck");
  });

  it("escalates once the per-session budget is spent", () => {
    const fp = heal("typecheck", "err").fingerprint;
    const d = planHealAttempt({
      ...base,
      failures: [heal("typecheck", "err")],
      // three prior attempts across fingerprints = session budget (default 3)
      attempts: [{ fingerprint: "a" }, { fingerprint: "b" }, { fingerprint: fp }],
    });
    expect(d.action).toBe("escalate");
    if (d.action === "escalate") expect(d.reason).toMatch(/session/i);
  });

  it("escalates a fingerprint that hit its own budget even with session budget left", () => {
    const fp = heal("typecheck", "err").fingerprint;
    const d = planHealAttempt({
      ...base,
      failures: [heal("typecheck", "err")],
      // two prior attempts on the same fingerprint = per-fingerprint budget (default 2)
      attempts: [{ fingerprint: fp }, { fingerprint: fp }],
    });
    expect(d.action).toBe("escalate");
    if (d.action === "escalate") expect(d.reason).toMatch(/fingerprint/i);
  });

  it("waits for a slot when the concurrency cap is reached", () => {
    const d = planHealAttempt({
      ...base,
      failures: [heal("typecheck", "err")],
      activeRuns: 1, // default maxConcurrentHealingRuns = 1
    });
    expect(d.action).toBe("wait_slot");
  });

  it("waits out the cooldown between attempts", () => {
    const d = planHealAttempt({
      ...base,
      failures: [heal("typecheck", "err")],
      attempts: [{ fingerprint: "x" }],
      lastAttemptAt: 9_500,
      now: 10_000, // 500ms < 1000ms cooldown
    });
    expect(d.action).toBe("cooldown");
    if (d.action === "cooldown") expect(d.waitMs).toBe(500);
  });

  it("proceeds once the cooldown has elapsed", () => {
    const d = planHealAttempt({
      ...base,
      failures: [heal("typecheck", "err")],
      attempts: [{ fingerprint: "x" }],
      lastAttemptAt: 8_000,
      now: 10_000, // 2000ms >= 1000ms cooldown
    });
    expect(d.action).toBe("repair");
  });
});

describe("verifyHeal", () => {
  it("rejects an empty heal that produced no new commit", () => {
    const v = verifyHeal({
      beforeSha: "abc",
      afterSha: "abc",
      beforeFailingCount: 2,
      afterFailingCount: 1,
    });
    expect(v.verdict).toBe("rejected");
    expect(v.reason).toMatch(/no.*change|commit/i);
  });

  it("rejects a heal with no measurable improvement", () => {
    const v = verifyHeal({
      beforeSha: "abc",
      afterSha: "def",
      beforeFailingCount: 2,
      afterFailingCount: 2,
    });
    expect(v.verdict).toBe("rejected");
    expect(v.reason).toMatch(/improvement/i);
  });

  it("reports healed when all checks are green", () => {
    const v = verifyHeal({
      beforeSha: "abc",
      afterSha: "def",
      beforeFailingCount: 2,
      afterFailingCount: 0,
    });
    expect(v.verdict).toBe("healed");
  });

  it("reports progressed when fewer checks fail but not all green", () => {
    const v = verifyHeal({
      beforeSha: "abc",
      afterSha: "def",
      beforeFailingCount: 3,
      afterFailingCount: 1,
    });
    expect(v.verdict).toBe("progressed");
  });
});

describe("healing session persistence", () => {
  let db: DB;
  let jobId: number;
  let repoId: number;
  beforeEach(() => {
    db = createDb(":memory:");
    repoId = addRepo({ path: "/r", name: "r" }, db).id;
    const job = createJob({ repoId, issueNumber: 1, model: "claude-sonnet-4-5" }, db);
    transitionJob(job.id, "working", {}, db);
    jobId = transitionJob(job.id, "ci_running", { prNumber: 7, sessionId: "s" }, db).id;
  });

  it("opens a triaging session bound to PR + head SHA", () => {
    const s = openHealingSession(jobId, 7, "sha-1", db);
    expect(s.status).toBe("triaging");
    expect(s.prNumber).toBe(7);
    expect(s.headSha).toBe("sha-1");
  });

  it("returns the existing session for the same PR + head SHA", () => {
    const a = openHealingSession(jobId, 7, "sha-1", db);
    const b = openHealingSession(jobId, 7, "sha-1", db);
    expect(b.id).toBe(a.id);
    expect(db.select().from(healingSessions).all()).toHaveLength(1);
  });

  it("supersedes the old session when the PR head moves", () => {
    const a = openHealingSession(jobId, 7, "sha-1", db);
    const b = openHealingSession(jobId, 7, "sha-2", db);
    expect(b.id).not.toBe(a.id);
    const reloaded = db.select().from(healingSessions).all();
    expect(reloaded.find((s) => s.id === a.id)?.status).toBe("superseded");
    expect(reloaded.find((s) => s.id === b.id)?.status).toBe("triaging");
  });

  it("validates transitions through the state machine", () => {
    const s = openHealingSession(jobId, 7, "sha-1", db);
    transitionHealingSession(s.id, "awaiting_slot", db);
    const updated = transitionHealingSession(s.id, "repairing", db);
    expect(updated.status).toBe("repairing");
    expect(() => transitionHealingSession(s.id, "healed", db)).toThrow();
  });

  it("counts attempts per session and per fingerprint", () => {
    const s = openHealingSession(jobId, 7, "sha-1", db);
    const f = heal("typecheck", "err");
    recordHealingAttempt(s.id, f, "sha-1", db);
    recordHealingAttempt(s.id, f, "sha-1", db);
    recordHealingAttempt(s.id, heal("lint", "err"), "sha-1", db);
    expect(sessionAttemptCount(s.id, db)).toBe(3);
    expect(fingerprintAttemptCount(s.id, f.fingerprint, db)).toBe(2);
  });

  it("finalizes an attempt with its outcome and after-SHA", () => {
    const s = openHealingSession(jobId, 7, "sha-1", db);
    const a = recordHealingAttempt(s.id, heal("typecheck", "err"), "sha-1", db);
    finalizeHealingAttempt(a.id, { status: "healed", afterSha: "sha-2" }, db);
    const row = db.select().from(healingAttempts).all()[0];
    expect(row?.status).toBe("healed");
    expect(row?.afterSha).toBe("sha-2");
  });

  it("summarises recent healing sessions for a repo with attempt counts", () => {
    const s = openHealingSession(jobId, 7, "sha-1", db);
    recordHealingAttempt(s.id, heal("typecheck", "err"), "sha-1", db);
    recordHealingAttempt(s.id, heal("lint", "err"), "sha-1", db);
    const rows = recentHealingSessions(repoId, db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      prNumber: 7,
      issueNumber: 1,
      status: "triaging",
      attempts: 2,
    });
    expect(recentHealingSessions(999, db)).toHaveLength(0);
  });

  it("counts only in-flight sessions toward the concurrency cap", () => {
    const s1 = openHealingSession(jobId, 7, "sha-1", db);
    expect(activeHealingRunCount(db)).toBe(0); // triaging is not yet an in-flight run
    transitionHealingSession(s1.id, "awaiting_slot", db);
    transitionHealingSession(s1.id, "repairing", db);
    expect(activeHealingRunCount(db)).toBe(1);
    transitionHealingSession(s1.id, "awaiting_ci", db);
    transitionHealingSession(s1.id, "verifying", db);
    transitionHealingSession(s1.id, "healed", db);
    expect(activeHealingRunCount(db)).toBe(0);
  });
});
