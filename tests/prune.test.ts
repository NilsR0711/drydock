import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { pruneOldData } from "@/lib/db/prune";
import { jobEvents, jobs } from "@/lib/db/schema";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

const DAY = 86_400;
let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/tmp/r", name: "r" }, db).id;
});

/** Insert a job with an explicit finishedAt (unix seconds, null = unfinished). */
function makeJob(finishedAt: number | null, status = "merged"): number {
  const row = db
    .insert(jobs)
    .values({ repoId, issueNumber: 1, status, finishedAt, costUsd: 1.5 })
    .returning()
    .get();
  return row.id;
}

function addEvent(jobId: number, ts: number): void {
  db.insert(jobEvents).values({ jobId, ts, type: "text", payload: "{}" }).run();
}

describe("pruneOldData", () => {
  it("deletes verbose events of jobs finished before the retention window", () => {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    const old = makeJob(nowSec - 40 * DAY);
    addEvent(old, nowSec - 40 * DAY);
    addEvent(old, nowSec - 39 * DAY);

    const result = pruneOldData(db, { days: 30, vacuum: false, now });

    expect(result.jobEventsDeleted).toBe(2);
    expect(db.select().from(jobEvents).all()).toHaveLength(0);
  });

  it("preserves the finished job's summary row for cost history", () => {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    const old = makeJob(nowSec - 40 * DAY);
    addEvent(old, nowSec - 40 * DAY);

    pruneOldData(db, { days: 30, vacuum: false, now });

    const job = db.select().from(jobs).all();
    expect(job).toHaveLength(1);
    expect(job[0]?.costUsd).toBe(1.5);
  });

  it("keeps events of recently finished jobs", () => {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    const recent = makeJob(nowSec - 5 * DAY);
    addEvent(recent, nowSec - 5 * DAY);

    const result = pruneOldData(db, { days: 30, vacuum: false, now });

    expect(result.jobEventsDeleted).toBe(0);
    expect(db.select().from(jobEvents).all()).toHaveLength(1);
  });

  it("never prunes events of unfinished jobs regardless of age", () => {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    const active = makeJob(null, "working");
    addEvent(active, nowSec - 99 * DAY);

    const result = pruneOldData(db, { days: 30, vacuum: false, now });

    expect(result.jobEventsDeleted).toBe(0);
    expect(db.select().from(jobEvents).all()).toHaveLength(1);
  });

  it("honours a custom retention window", () => {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    const job = makeJob(nowSec - 10 * DAY);
    addEvent(job, nowSec - 10 * DAY);

    expect(pruneOldData(db, { days: 30, vacuum: false, now }).jobEventsDeleted).toBe(0);
    expect(pruneOldData(db, { days: 7, vacuum: false, now }).jobEventsDeleted).toBe(1);
  });

  it("falls back to the retentionDays setting when days is omitted", () => {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    saveSettings({ retentionDays: 7 }, db);
    const job = makeJob(nowSec - 10 * DAY);
    addEvent(job, nowSec - 10 * DAY);

    expect(pruneOldData(db, { vacuum: false, now }).jobEventsDeleted).toBe(1);
  });

  it("runs VACUUM by default and reports it", () => {
    const result = pruneOldData(db);
    expect(result.vacuumed).toBe(true);
  });

  it("skips VACUUM when disabled", () => {
    const result = pruneOldData(db, { vacuum: false });
    expect(result.vacuumed).toBe(false);
  });
});
