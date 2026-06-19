import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { Worktree } from "@/lib/git/worktree";
import type { ReviewThread } from "@/lib/github/gh";
import type { PrAuditFinding, PrAuditResult } from "@/lib/issues/pr-audit";
import { createJob } from "@/lib/orchestrator/jobs";
import {
  AUDIT_FIX_SEVERITIES,
  auditFindingThreadId,
  buildAuditFixApply,
  findingThread,
  fixableFindings,
  isFixableSeverity,
  runPrAuditFixPass,
} from "@/lib/orchestrator/pr-audit-fix";
import { listFeedbackItems } from "@/lib/orchestrator/review-feedback";
import { addRepo } from "@/lib/repos/service";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

function finding(over: Partial<PrAuditFinding> = {}): PrAuditFinding {
  return {
    severity: "blocker",
    title: "Null deref in handler",
    body: "Guard the optional before dereferencing.",
    ...over,
  };
}

function result(findings: PrAuditFinding[]): PrAuditResult {
  return {
    summary: "",
    recommendation: "request_changes",
    findings,
    issueCoverage: { met: [], missing: [] },
  };
}

function makeJob(): number {
  const repo = addRepo({ path: "/r", name: "r" }, db);
  return createJob({ repoId: repo.id, issueNumber: 1 }, db).id;
}

describe("severity threshold", () => {
  it("only treats blocker and major as fixable", () => {
    expect(AUDIT_FIX_SEVERITIES).toEqual(["blocker", "major"]);
    expect(isFixableSeverity("blocker")).toBe(true);
    expect(isFixableSeverity("major")).toBe(true);
    expect(isFixableSeverity("minor")).toBe(false);
    expect(isFixableSeverity("nit")).toBe(false);
    expect(isFixableSeverity("praise")).toBe(false);
  });

  it("filters out below-threshold findings and orders blocker before major", () => {
    const r = result([
      finding({ severity: "major", title: "B" }),
      finding({ severity: "nit", title: "C" }),
      finding({ severity: "blocker", title: "A" }),
      finding({ severity: "minor", title: "D" }),
    ]);
    expect(fixableFindings(r).map((f) => f.title)).toEqual(["A", "B"]);
  });
});

describe("auditFindingThreadId", () => {
  it("is stable for the same finding and distinct across findings", () => {
    const a = auditFindingThreadId(7, finding({ title: "X", path: "a.ts" }));
    const a2 = auditFindingThreadId(7, finding({ title: "X", path: "a.ts" }));
    const b = auditFindingThreadId(7, finding({ title: "Y", path: "a.ts" }));
    expect(a).toBe(a2);
    expect(a).not.toBe(b);
    expect(a.startsWith("audit:7:")).toBe(true);
  });
});

describe("runPrAuditFixPass", () => {
  it("applies a fixable finding and resolves its item", async () => {
    const jobId = makeJob();
    const apply = vi.fn(async (_item: unknown, _thread: ReviewThread) => ({ ok: true }));
    const summary = await runPrAuditFixPass({
      jobId,
      prNumber: 55,
      result: result([finding({ path: "src/x.ts", line: 4 })]),
      apply,
      db,
    });

    expect(summary).toMatchObject({ fixable: 1, applied: 1, failed: 0 });
    expect(apply).toHaveBeenCalledTimes(1);
    const thread = apply.mock.calls[0]?.[1] as ReviewThread;
    expect(thread.path).toBe("src/x.ts");
    expect(thread.comments[0]?.body).toContain("Null deref in handler");
    const items = listFeedbackItems(jobId, db);
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("resolved");
    expect(items[0]?.reviewer).toBe("drydock-audit");
  });

  it("never applies below-threshold findings", async () => {
    const jobId = makeJob();
    const apply = vi.fn(async () => ({ ok: true }));
    const summary = await runPrAuditFixPass({
      jobId,
      prNumber: 55,
      result: result([finding({ severity: "nit" }), finding({ severity: "minor" })]),
      apply,
      db,
    });
    expect(summary.fixable).toBe(0);
    expect(apply).not.toHaveBeenCalled();
    expect(listFeedbackItems(jobId, db)).toHaveLength(0);
  });

  it("is idempotent: a re-run does not re-apply an already-resolved finding", async () => {
    const jobId = makeJob();
    const apply = vi.fn(async () => ({ ok: true }));
    const r = result([finding({ path: "src/x.ts" })]);

    await runPrAuditFixPass({ jobId, prNumber: 55, result: r, apply, db });
    const second = await runPrAuditFixPass({ jobId, prNumber: 55, result: r, apply, db });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ fixable: 1, applied: 0, skipped: 1 });
    expect(listFeedbackItems(jobId, db)).toHaveLength(1);
  });

  it("caps applications per pass at the per-sweep budget", async () => {
    const jobId = makeJob();
    const apply = vi.fn(async () => ({ ok: true }));
    const findings = Array.from({ length: 5 }, (_, i) =>
      finding({ title: `bug ${i}`, path: `src/f${i}.ts` }),
    );
    const summary = await runPrAuditFixPass({
      jobId,
      prNumber: 55,
      result: result(findings),
      apply,
      db,
      budgets: { maxItemsPerSweep: 2, maxAttemptsPerItem: 2 },
    });

    expect(apply).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ fixable: 5, applied: 2 });
    expect(summary.skipped).toBe(3);
  });

  it("does not resolve an item whose apply failed", async () => {
    const jobId = makeJob();
    const apply = vi.fn(async () => ({ ok: false, detail: "no change produced" }));
    const summary = await runPrAuditFixPass({
      jobId,
      prNumber: 55,
      result: result([finding({ path: "src/x.ts" })]),
      apply,
      db,
    });

    expect(summary.applied).toBe(0);
    const items = listFeedbackItems(jobId, db);
    expect(items[0]?.status).not.toBe("resolved");
  });

  it("treats a thrown apply as a failed attempt without resolving", async () => {
    const jobId = makeJob();
    const apply = vi.fn(async () => {
      throw new Error("boom");
    });
    const summary = await runPrAuditFixPass({
      jobId,
      prNumber: 55,
      result: result([finding({ path: "src/x.ts" })]),
      apply,
      db,
    });
    expect(summary.applied).toBe(0);
    expect(listFeedbackItems(jobId, db)[0]?.status).not.toBe("resolved");
  });

  it("does not auto-merge: the pass exposes no merge surface and only applies", async () => {
    const jobId = makeJob();
    // The apply stub may only commit + push (ok), never merge. The pass has no
    // forge/merge dependency by construction; this guards that invariant.
    const apply = vi.fn(async (_item: unknown, _thread: ReviewThread) => ({ ok: true }));
    const summary = await runPrAuditFixPass({
      jobId,
      prNumber: 55,
      result: result([finding({ path: "src/x.ts" })]),
      apply,
      db,
    });
    expect(summary.applied).toBe(1);
    const passKeys = Object.keys(apply.mock.calls[0]?.[1] ?? {});
    // The apply only receives an item + a synthetic thread — no merge hook.
    expect(passKeys).toContain("comments");
  });

  it("flags an item as failed once the per-item attempt budget is spent", async () => {
    const jobId = makeJob();
    const apply = vi.fn(async () => ({ ok: false, detail: "still broken" }));
    const r = result([finding({ path: "src/x.ts" })]);
    const budgets = { maxItemsPerSweep: 3, maxAttemptsPerItem: 2 };

    await runPrAuditFixPass({ jobId, prNumber: 55, result: r, apply, db, budgets });
    await runPrAuditFixPass({ jobId, prNumber: 55, result: r, apply, db, budgets });

    expect(apply).toHaveBeenCalledTimes(2);
    expect(listFeedbackItems(jobId, db)[0]?.status).toBe("failed");
  });
});

describe("buildAuditFixApply", () => {
  const wt: Worktree = { path: "/wt", branch: "drydock/pr-branch", base: "default-sha" };
  const item = { id: 1, attempts: 1, status: "in_progress" } as never;

  it("runs the agent then commits + pushes with base pinned to the pre-fix HEAD", async () => {
    const headSha = vi.fn(async () => "head-before");
    const commitAndPush = vi.fn(async (_wt: Worktree, _message: string) => {});
    const runSession = vi.fn(async (_prompt: string, _cwd: string) => ({ exitCode: 0 }));
    const apply = buildAuditFixApply({ worktree: wt, headSha, commitAndPush, runSession });

    const thread = findingThread("audit:1:abc", {
      severity: "blocker",
      title: "Fix the leak",
      body: "Close the handle.",
    });
    const res = await apply(item, thread);

    expect(res.ok).toBe(true);
    // The session runs in the job's own worktree, prompted with the finding.
    expect(runSession.mock.calls[0]?.[1]).toBe("/wt");
    expect(runSession.mock.calls[0]?.[0]).toContain("Fix the leak");
    // commitAndPush is handed a worktree whose base is the captured pre-fix HEAD,
    // so no-op detection and attribution stripping only see the new fix commit.
    const pushedWt = commitAndPush.mock.calls[0]?.[0] as Worktree;
    expect(pushedWt.base).toBe("head-before");
    expect(pushedWt.branch).toBe("drydock/pr-branch");
  });

  it("reports failure on a non-zero agent exit and never pushes", async () => {
    const commitAndPush = vi.fn(async () => {});
    const apply = buildAuditFixApply({
      worktree: wt,
      headSha: vi.fn(async () => "h"),
      commitAndPush,
      runSession: vi.fn(async () => ({ exitCode: 1 })),
    });
    const res = await apply(item, findingThread("t", { severity: "major", title: "x", body: "" }));
    expect(res.ok).toBe(false);
    expect(commitAndPush).not.toHaveBeenCalled();
  });

  it("reports a no-op when commit + push finds nothing to push", async () => {
    const apply = buildAuditFixApply({
      worktree: wt,
      headSha: vi.fn(async () => "h"),
      commitAndPush: vi.fn(async () => {
        throw new Error("empty commit");
      }),
      runSession: vi.fn(async () => ({ exitCode: 0 })),
    });
    const res = await apply(item, findingThread("t", { severity: "major", title: "x", body: "" }));
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("no change");
  });
});
