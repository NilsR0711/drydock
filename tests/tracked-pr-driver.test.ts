import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { PrCheck, PrInfo, PrMergeState } from "@/lib/forge/types";
import { driveTrackedPrs } from "@/lib/orchestrator/tracked-pr-driver";
import { addRepo } from "@/lib/repos/service";
import { getTrackedPr, listActiveTrackedPrs, trackPr } from "@/lib/tracked-prs/service";

function info(over: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 42,
    title: "External PR",
    author: "contributor",
    state: "open",
    merged: false,
    isCrossRepository: false,
    headRefName: "feature/x",
    headSha: "abc",
    headSlug: "acme/r",
    baseSlug: "acme/r",
    ...over,
  };
}

interface FakeForgeOpts {
  prInfo?: PrInfo;
  checks?: PrCheck[];
  mergeState?: PrMergeState;
}

function fakeForge(opts: FakeForgeOpts = {}) {
  return {
    prInfo: vi.fn(async () => opts.prInfo ?? info()),
    prChecks: vi.fn(async () => opts.checks ?? ([] as PrCheck[])),
    prMergeState: vi.fn(async () => opts.mergeState ?? ("clean" as PrMergeState)),
    mergePr: vi.fn(async () => {}),
    commentPr: vi.fn(async () => {}),
    commentIssue: vi.fn(async () => {}),
  };
}

const check = (state: string): PrCheck => ({ name: "ci", state, bucket: undefined }) as PrCheck;

describe("driveTrackedPrs", () => {
  let db: DB;
  let repoId: number;

  beforeEach(() => {
    db = createDb(":memory:");
    // Note: autoProcessEnabled is OFF — tracked PRs are watched regardless.
    repoId = addRepo(
      { path: "/repo", name: "acme", autoProcessEnabled: false, autoHealCi: true },
      db,
    ).id;
  });

  function deps(forge: ReturnType<typeof fakeForge>, over = {}) {
    return {
      db,
      forgeFor: () => forge as never,
      applyCiFix: vi.fn(async () => true),
      processFeedback: vi.fn(async () => {}),
      ...over,
    };
  }

  it("reconciles head/fork/ownership fields from the forge", async () => {
    const tp = trackPr({ repoId, prNumber: 42, url: "u", platform: "github" }, db);
    const forge = fakeForge({ prInfo: info({ headRefName: "drydock/x", headSha: "sha9" }) });
    await driveTrackedPrs(deps(forge));
    const row = getTrackedPr(tp.id, db);
    expect(row).toMatchObject({ branch: "drydock/x", headSha: "sha9", isFork: false, owned: true });
  });

  it("processes tracked PRs even when repo auto-processing is disabled (watch-scope independent)", async () => {
    trackPr({ repoId, prNumber: 42, url: "u", platform: "github" }, db);
    const forge = fakeForge();
    await driveTrackedPrs(deps(forge));
    expect(forge.prInfo).toHaveBeenCalledOnce();
  });

  it("marks a PR merged when the forge reports it merged (external merge)", async () => {
    const tp = trackPr({ repoId, prNumber: 42, url: "u", platform: "github" }, db);
    const forge = fakeForge({ prInfo: info({ merged: true, state: "merged" }) });
    await driveTrackedPrs(deps(forge));
    expect(getTrackedPr(tp.id, db)?.status).toBe("merged");
    expect(listActiveTrackedPrs(db)).toHaveLength(0);
  });

  it("marks a PR closed when the forge reports it closed without merge", async () => {
    const tp = trackPr({ repoId, prNumber: 42, url: "u", platform: "github" }, db);
    const forge = fakeForge({ prInfo: info({ state: "closed" }) });
    await driveTrackedPrs(deps(forge));
    expect(getTrackedPr(tp.id, db)?.status).toBe("closed");
  });

  it("auto-merges an opted-in, owned, clean, green PR", async () => {
    const tp = trackPr({ repoId, prNumber: 42, url: "u", platform: "github", autoMerge: true }, db);
    const forge = fakeForge({ checks: [check("SUCCESS")], mergeState: "clean" });
    await driveTrackedPrs(deps(forge));
    expect(forge.mergePr).toHaveBeenCalledWith(42);
    expect(getTrackedPr(tp.id, db)?.status).toBe("merged");
  });

  it("never auto-merges when auto-merge is off (default), stays tracking", async () => {
    const tp = trackPr({ repoId, prNumber: 42, url: "u", platform: "github" }, db);
    const forge = fakeForge({ checks: [check("SUCCESS")], mergeState: "clean" });
    await driveTrackedPrs(deps(forge));
    expect(forge.mergePr).not.toHaveBeenCalled();
    expect(getTrackedPr(tp.id, db)?.status).toBe("tracking");
  });

  it("never auto-merges a fork PR even when opted in", async () => {
    const tp = trackPr({ repoId, prNumber: 42, url: "u", platform: "github", autoMerge: true }, db);
    const forge = fakeForge({
      prInfo: info({ isCrossRepository: true, headSlug: "fork/r" }),
      checks: [check("SUCCESS")],
      mergeState: "clean",
    });
    await driveTrackedPrs(deps(forge));
    expect(forge.mergePr).not.toHaveBeenCalled();
    expect(getTrackedPr(tp.id, db)?.status).toBe("tracking");
  });

  it("parks for a human on a merge conflict and comments once", async () => {
    const tp = trackPr({ repoId, prNumber: 42, url: "u", platform: "github" }, db);
    const forge = fakeForge({ mergeState: "conflicted", checks: [check("SUCCESS")] });
    await driveTrackedPrs(deps(forge));
    const row = getTrackedPr(tp.id, db);
    expect(row?.status).toBe("needs_human");
    expect(row?.lastError).toMatch(/conflict/i);
    expect(forge.commentPr).toHaveBeenCalledOnce();
    expect(forge.mergePr).not.toHaveBeenCalled();
  });

  it("heals failing CI on an owned branch and stays tracking", async () => {
    const tp = trackPr({ repoId, prNumber: 42, url: "u", platform: "github" }, db);
    const forge = fakeForge({ checks: [check("FAILURE")] });
    const d = deps(forge);
    await driveTrackedPrs(d);
    expect(d.applyCiFix).toHaveBeenCalledOnce();
    const row = getTrackedPr(tp.id, db);
    expect(row?.status).toBe("tracking");
    expect(row?.ciRetryCount).toBe(1);
  });

  it("parks a failing fork PR without attempting a fix (guardrail)", async () => {
    const tp = trackPr({ repoId, prNumber: 42, url: "u", platform: "github" }, db);
    const forge = fakeForge({
      prInfo: info({ isCrossRepository: true, headSlug: "fork/r" }),
      checks: [check("FAILURE")],
    });
    const d = deps(forge);
    await driveTrackedPrs(d);
    expect(d.applyCiFix).not.toHaveBeenCalled();
    expect(getTrackedPr(tp.id, db)?.status).toBe("needs_human");
  });

  it("parks failing CI when auto-heal is disabled for the repo", async () => {
    const noHeal = addRepo({ path: "/r2", name: "b", autoHealCi: false }, db).id;
    const tp = trackPr({ repoId: noHeal, prNumber: 1, url: "u", platform: "github" }, db);
    const forge = fakeForge({ checks: [check("FAILURE")] });
    const d = deps(forge);
    await driveTrackedPrs(d);
    expect(d.applyCiFix).not.toHaveBeenCalled();
    expect(getTrackedPr(tp.id, db)?.status).toBe("needs_human");
  });

  it("parks when the CI auto-heal budget is exhausted", async () => {
    const tp = trackPr({ repoId, prNumber: 42, url: "u", platform: "github" }, db);
    // Exhaust the budget.
    const { updateTrackedPr } = await import("@/lib/tracked-prs/service");
    updateTrackedPr(tp.id, { ciRetryCount: 3 }, db);
    const forge = fakeForge({ checks: [check("FAILURE")] });
    const d = deps(forge);
    await driveTrackedPrs(d);
    expect(d.applyCiFix).not.toHaveBeenCalled();
    expect(getTrackedPr(tp.id, db)?.status).toBe("needs_human");
  });

  it("does not auto-merge when review feedback pushed a new commit (stale green)", async () => {
    const tp = trackPr({ repoId, prNumber: 42, url: "u", platform: "github", autoMerge: true }, db);
    // prInfo is read twice: once up front, once after feedback. Return a moved
    // head SHA the second time to simulate a commit pushed by the feedback step.
    let call = 0;
    const forge = fakeForge({ checks: [check("SUCCESS")], mergeState: "clean" });
    forge.prInfo = vi.fn(async () => info({ headSha: call++ === 0 ? "old" : "new" }));
    const d = deps(forge, { processFeedback: vi.fn(async () => {}) });
    await driveTrackedPrs(d);
    expect(forge.mergePr).not.toHaveBeenCalled();
    expect(getTrackedPr(tp.id, db)?.status).toBe("tracking");
  });

  it("runs review feedback for an open PR", async () => {
    trackPr({ repoId, prNumber: 42, url: "u", platform: "github" }, db);
    const forge = fakeForge({ checks: [check("SUCCESS")] });
    const d = deps(forge);
    await driveTrackedPrs(d);
    expect(d.processFeedback).toHaveBeenCalledOnce();
  });

  it("isolates a per-PR failure so the sweep continues", async () => {
    const other = addRepo({ path: "/r3", name: "c", autoHealCi: true }, db).id;
    trackPr({ repoId, prNumber: 42, url: "u", platform: "github" }, db);
    const ok = trackPr({ repoId: other, prNumber: 1, url: "u", platform: "github" }, db);
    const boom = {
      ...fakeForge(),
      prInfo: vi.fn(async (n: number) => {
        if (n === 42) throw new Error("boom");
        return info({ number: 1 });
      }),
    };
    await driveTrackedPrs(deps(boom as never));
    // The healthy PR still reconciled.
    expect(getTrackedPr(ok.id, db)?.branch).toBe("feature/x");
  });
});
