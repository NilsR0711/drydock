import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { repos } from "@/lib/db/schema";
import { createJob } from "@/lib/orchestrator/jobs";
import { saveSettings } from "@/lib/settings/service";

/**
 * The global `maxTurns` setting is the source of truth for a new job's turn
 * budget (issue #254): raising it in Settings must take effect for the next
 * job, and 0 (unlimited) must round-trip as 0 rather than the legacy hardcoded
 * fallback. An explicit per-call override still wins.
 */
let db: DB;
let repoId: number;

beforeEach(() => {
  db = createDb(":memory:");
  repoId = db.insert(repos).values({ path: "/tmp/x", name: "x" }).returning().get().id;
});

describe("createJob turn budget (issue #254)", () => {
  it("inherits the global maxTurns default for a fresh job", () => {
    const job = createJob({ repoId, issueNumber: 1 }, db);
    expect(job.maxTurns).toBe(200);
  });

  it("inherits a customized global maxTurns, including 0 (unlimited)", () => {
    saveSettings({ maxTurns: 500 }, db);
    expect(createJob({ repoId, issueNumber: 2 }, db).maxTurns).toBe(500);

    saveSettings({ maxTurns: 0 }, db);
    expect(createJob({ repoId, issueNumber: 3 }, db).maxTurns).toBe(0);
  });

  it("lets an explicit per-call budget override the global default", () => {
    saveSettings({ maxTurns: 500 }, db);
    expect(createJob({ repoId, issueNumber: 4, maxTurns: 12 }, db).maxTurns).toBe(12);
  });
});
