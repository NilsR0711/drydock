import { beforeEach, describe, expect, it } from "vitest";
import type { ClaudeUsageReading } from "@/lib/agents/claude-usage";
import { createDb, type DB } from "@/lib/db/client";
import { dashboardSnapshot, dashboardSummary, getClaudeUsageView } from "@/lib/db/queries";
import { jobs } from "@/lib/db/schema";
import { latchProviderLimit } from "@/lib/orchestrator/provider-limit";
import { saveProviderUsage } from "@/lib/orchestrator/provider-usage";
import { addRepo } from "@/lib/repos/service";

let db: DB;
const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  db = createDb(":memory:");
});

describe("dashboardSummary", () => {
  it("includes today's total spend across all repos", () => {
    const a = addRepo({ path: "/a", name: "a" }, db).id;
    const b = addRepo({ path: "/b", name: "b" }, db).id;
    db.insert(jobs)
      .values([
        { repoId: a, issueNumber: 1, status: "merged", startedAt: now(), costUsd: 0.25 },
        { repoId: b, issueNumber: 1, status: "working", startedAt: now(), costUsd: 0.75 },
      ])
      .run();
    expect(dashboardSummary(db).spendToday).toBeCloseTo(1.0);
  });
});

describe("dashboardSnapshot", () => {
  it("returns one row per repo with per-status counts and today's spend", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db).id;
    db.insert(jobs)
      .values([
        { repoId: repo, issueNumber: 1, status: "queued" },
        { repoId: repo, issueNumber: 2, status: "queued" },
        { repoId: repo, issueNumber: 3, status: "working", startedAt: now(), costUsd: 0.4 },
        { repoId: repo, issueNumber: 4, status: "ci_running", startedAt: now(), costUsd: 0.1 },
        { repoId: repo, issueNumber: 5, status: "needs_human" },
      ])
      .run();

    const snap = dashboardSnapshot(db);
    expect(snap.repos).toHaveLength(1);
    const row = snap.repos[0];
    expect(row?.queued).toBe(2);
    expect(row?.working).toBe(1);
    expect(row?.ciRunning).toBe(1);
    expect(row?.needsHuman).toBe(1);
    expect(row?.todaySpend).toBeCloseTo(0.5);
  });

  it("counts retrying jobs as working", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db).id;
    db.insert(jobs)
      .values([
        { repoId: repo, issueNumber: 1, status: "working", startedAt: now() },
        { repoId: repo, issueNumber: 2, status: "retrying", startedAt: now() },
      ])
      .run();
    expect(dashboardSnapshot(db).repos[0]?.working).toBe(2);
  });

  it("lists in-flight jobs (working, ci_running, retrying) but not queued or terminal", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db).id;
    db.insert(jobs)
      .values([
        { repoId: repo, issueNumber: 1, status: "queued" },
        { repoId: repo, issueNumber: 2, status: "working", startedAt: now() },
        { repoId: repo, issueNumber: 3, status: "merged" },
      ])
      .run();
    const inFlight = dashboardSnapshot(db).repos[0]?.inFlight ?? [];
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]?.issueNumber).toBe(2);
    expect(inFlight[0]?.status).toBe("working");
  });

  it("flags repos that need attention (needs_human or ci_failed)", () => {
    const calm = addRepo({ path: "/calm", name: "calm" }, db).id;
    const parked = addRepo({ path: "/parked", name: "parked" }, db).id;
    const broken = addRepo({ path: "/broken", name: "broken" }, db).id;
    db.insert(jobs)
      .values([
        { repoId: calm, issueNumber: 1, status: "merged" },
        { repoId: parked, issueNumber: 1, status: "needs_human" },
        { repoId: broken, issueNumber: 1, status: "ci_failed" },
      ])
      .run();
    const byName = Object.fromEntries(dashboardSnapshot(db).repos.map((r) => [r.name, r]));
    expect(byName.calm?.attention).toBe(false);
    expect(byName.parked?.attention).toBe(true);
    expect(byName.broken?.attention).toBe(true);
  });

  it("sorts repos needing attention first", () => {
    const calm = addRepo({ path: "/calm", name: "calm" }, db).id;
    const parked = addRepo({ path: "/parked", name: "parked" }, db).id;
    db.insert(jobs)
      .values([
        { repoId: calm, issueNumber: 1, status: "merged" },
        { repoId: parked, issueNumber: 1, status: "needs_human" },
      ])
      .run();
    expect(dashboardSnapshot(db).repos[0]?.name).toBe("parked");
  });

  it("orders non-attention repos with in-flight work ahead of idle ones", () => {
    const idle = addRepo({ path: "/idle", name: "idle" }, db).id;
    const busy = addRepo({ path: "/busy", name: "busy" }, db).id;
    db.insert(jobs)
      .values([
        { repoId: idle, issueNumber: 1, status: "merged" },
        { repoId: busy, issueNumber: 1, status: "working", startedAt: now() },
      ])
      .run();
    expect(dashboardSnapshot(db).repos[0]?.name).toBe("busy");
  });

  it("reports the most recent activity timestamp for a repo", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db).id;
    const t = now();
    db.insert(jobs)
      .values([
        { repoId: repo, issueNumber: 1, status: "merged", startedAt: t - 100, finishedAt: t - 50 },
        { repoId: repo, issueNumber: 2, status: "working", startedAt: t },
      ])
      .run();
    expect(dashboardSnapshot(db).repos[0]?.lastActivityAt).toBe(t);
  });

  it("returns a row for repos with no jobs yet", () => {
    addRepo({ path: "/empty", name: "empty" }, db);
    const row = dashboardSnapshot(db).repos[0];
    expect(row?.name).toBe("empty");
    expect(row?.queued).toBe(0);
    expect(row?.inFlight).toEqual([]);
    expect(row?.todaySpend).toBe(0);
    expect(row?.lastActivityAt).toBeNull();
    expect(row?.attention).toBe(false);
  });

  it("includes a Claude usage view, unknown when nothing is recorded (issue #188)", () => {
    expect(dashboardSnapshot(db).claudeUsage.state).toBe("unknown");
  });
});

describe("getClaudeUsageView", () => {
  const fresh = (): ClaudeUsageReading => ({
    status: "warning",
    windowType: "five_hour",
    resetsAt: Math.floor(Date.now() / 1000) + 3600,
    capturedAt: Math.floor(Date.now() / 1000),
  });

  it("reflects a fresh recorded reading", () => {
    saveProviderUsage("claude", fresh(), db);
    const view = getClaudeUsageView(db);
    expect(view.state).toBe("warning");
    expect(view.tone).toBe("warning");
    expect(view.windowType).toBe("five_hour");
  });

  it("folds an active provider-limit latch into the blocked state", () => {
    latchProviderLimit(
      { agent: "claude", kind: "usage_limit", rawSnippet: "limit", resetAt: now() + 7200 },
      db,
    );
    const view = getClaudeUsageView(db);
    expect(view.state).toBe("blocked");
    expect(view.blocked).toBe(true);
  });
});
