import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { addRepo } from "@/lib/repos/service";
import {
  getTrackedPr,
  getTrackedPrByNumber,
  InvalidTrackedPrTransitionError,
  listActiveTrackedPrs,
  listTrackedPrs,
  trackPr,
  transitionTrackedPr,
  untrackPr,
  updateTrackedPr,
} from "@/lib/tracked-prs/service";

describe("tracked-prs service", () => {
  let db: DB;
  let repoId: number;

  beforeEach(() => {
    db = createDb(":memory:");
    repoId = addRepo({ path: "/repo", name: "acme" }, db).id;
  });

  const base = {
    prNumber: 42,
    url: "https://github.com/acme/r/pull/42",
    platform: "github" as const,
  };

  it("tracks a PR with sane defaults", () => {
    const tp = trackPr({ repoId, ...base }, db);
    expect(tp).toMatchObject({ repoId, prNumber: 42, status: "tracking", autoMerge: false });
    expect(getTrackedPr(tp.id, db)?.url).toBe(base.url);
    expect(getTrackedPrByNumber(repoId, 42, db)?.id).toBe(tp.id);
  });

  it("honors an opt-in autoMerge flag", () => {
    const tp = trackPr({ repoId, ...base, autoMerge: true }, db);
    expect(tp.autoMerge).toBe(true);
  });

  it("re-tracking an existing PR is idempotent and revives a stopped record", () => {
    const first = trackPr({ repoId, ...base }, db);
    untrackPr(first.id, db);
    expect(getTrackedPr(first.id, db)?.status).toBe("stopped");
    const again = trackPr({ repoId, ...base }, db);
    expect(again.id).toBe(first.id);
    expect(again.status).toBe("tracking");
    expect(listTrackedPrs(repoId, db)).toHaveLength(1);
  });

  it("lists active tracked PRs across repos for the sweep", () => {
    const other = addRepo({ path: "/repo2", name: "beta" }, db).id;
    const a = trackPr({ repoId, ...base }, db);
    trackPr({ repoId: other, prNumber: 1, url: "u", platform: "github" }, db);
    const stopped = trackPr({ repoId, prNumber: 99, url: "u", platform: "github" }, db);
    untrackPr(stopped.id, db);
    const active = listActiveTrackedPrs(db);
    expect(active.map((t) => t.id).sort()).toEqual([a.id, a.id + 1].sort());
    expect(active.every((t) => t.status === "tracking")).toBe(true);
  });

  it("transitions through the tracking lifecycle and records reasons", () => {
    const tp = trackPr({ repoId, ...base }, db);
    const parked = transitionTrackedPr(tp.id, "needs_human", { lastError: "fork PR" }, db);
    expect(parked.status).toBe("needs_human");
    expect(parked.lastError).toBe("fork PR");
    // operator resumes
    const resumed = transitionTrackedPr(tp.id, "tracking", {}, db);
    expect(resumed.status).toBe("tracking");
    const merged = transitionTrackedPr(tp.id, "merged", {}, db);
    expect(merged.status).toBe("merged");
  });

  it("rejects illegal transitions out of a terminal state", () => {
    const tp = trackPr({ repoId, ...base }, db);
    transitionTrackedPr(tp.id, "merged", {}, db);
    expect(() => transitionTrackedPr(tp.id, "tracking", {}, db)).toThrow(
      InvalidTrackedPrTransitionError,
    );
  });

  it("updateTrackedPr patches reconciliation fields without changing status", () => {
    const tp = trackPr({ repoId, ...base }, db);
    const updated = updateTrackedPr(
      tp.id,
      { branch: "feature/x", headSha: "abc", isFork: true, owned: false, title: "Fix" },
      db,
    );
    expect(updated).toMatchObject({
      branch: "feature/x",
      headSha: "abc",
      isFork: true,
      title: "Fix",
    });
    expect(updated.status).toBe("tracking");
  });
});
