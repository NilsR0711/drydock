import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { reviewFeedbackItems, trackedPrs } from "@/lib/db/schema";
import { addRepo } from "@/lib/repos/service";

describe("tracked_prs migration 0037", () => {
  let db: DB;
  let repoId: number;

  beforeEach(() => {
    db = createDb(":memory:");
    repoId = addRepo({ path: "/repo", name: "acme" }, db).id;
  });

  it("creates the tracked_prs table with its defaults", () => {
    const row = db
      .insert(trackedPrs)
      .values({ repoId, prNumber: 7, url: "https://github.com/acme/r/pull/7", platform: "github" })
      .returning()
      .get();
    expect(row).toMatchObject({
      repoId,
      prNumber: 7,
      status: "tracking",
      isFork: false,
      owned: false,
      autoMerge: false,
      ciRetryCount: 0,
    });
  });

  it("enforces (repoId, prNumber) uniqueness", () => {
    const insert = () =>
      db.insert(trackedPrs).values({ repoId, prNumber: 7, url: "u", platform: "github" }).run();
    insert();
    expect(insert).toThrow();
  });

  it("rebuilt review_feedback_items: job_id is now nullable and tracked_pr_id exists", () => {
    const tracked = db
      .insert(trackedPrs)
      .values({ repoId, prNumber: 9, url: "u", platform: "github" })
      .returning()
      .get();
    const item = db
      .insert(reviewFeedbackItems)
      .values({
        trackedPrId: tracked.id,
        prNumber: 9,
        threadId: "t1",
        reviewer: "coderabbitai[bot]",
        classification: "actionable",
      })
      .returning()
      .get();
    expect(item.jobId).toBeNull();
    expect(item.trackedPrId).toBe(tracked.id);
  });

  it("cascades feedback-item deletion when a tracked PR is removed", () => {
    const tracked = db
      .insert(trackedPrs)
      .values({ repoId, prNumber: 11, url: "u", platform: "github" })
      .returning()
      .get();
    db.insert(reviewFeedbackItems)
      .values({
        trackedPrId: tracked.id,
        prNumber: 11,
        threadId: "t1",
        reviewer: "r",
        classification: "actionable",
      })
      .run();
    db.delete(trackedPrs).where(sql`${trackedPrs.id} = ${tracked.id}`).run();
    const remaining = db.select().from(reviewFeedbackItems).all();
    expect(remaining).toHaveLength(0);
  });
});
