import { type DB, createDb } from "@/lib/db/client";
import { repos } from "@/lib/db/schema";
import type { GhIssue } from "@/lib/github/gh";
import {
  listIssues,
  reorderIssues,
  setQueueLabelLocal,
  syncIssuesFromGh,
} from "@/lib/issues/service";
import { beforeEach, describe, expect, it } from "vitest";

let db: DB;
let repoId: number;

beforeEach(() => {
  db = createDb(":memory:");
  const r = db.insert(repos).values({ path: "/tmp/x", name: "x" }).returning().get();
  repoId = r.id;
});

function gh(number: number, title: string): GhIssue {
  return { number, title, labels: [{ name: "drydock:queue" }] };
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

describe("issues service", () => {
  it("inserts synced issues in fetch order with ascending priority", () => {
    syncIssuesFromGh(repoId, [gh(5, "five"), gh(7, "seven")], db);
    const list = listIssues(repoId, db);
    expect(list.map((i) => i.number)).toEqual([5, 7]);
    expect(defined(list[0]).priority).toBeLessThan(defined(list[1]).priority);
  });

  it("preserves priority of existing issues across re-sync", () => {
    syncIssuesFromGh(repoId, [gh(5, "five"), gh(7, "seven")], db);
    reorderIssues(repoId, [7, 5], db);
    syncIssuesFromGh(repoId, [gh(5, "five"), gh(7, "seven")], db);
    expect(listIssues(repoId, db).map((i) => i.number)).toEqual([7, 5]);
  });

  it("appends new issues after existing ones", () => {
    syncIssuesFromGh(repoId, [gh(5, "five")], db);
    syncIssuesFromGh(repoId, [gh(5, "five"), gh(9, "nine")], db);
    expect(listIssues(repoId, db).map((i) => i.number)).toEqual([5, 9]);
  });

  it("removes issues no longer present in GitHub", () => {
    syncIssuesFromGh(repoId, [gh(5, "five"), gh(7, "seven")], db);
    syncIssuesFromGh(repoId, [gh(5, "five")], db);
    expect(listIssues(repoId, db).map((i) => i.number)).toEqual([5]);
  });

  it("reorder writes new priority order", () => {
    syncIssuesFromGh(repoId, [gh(1, "a"), gh(2, "b"), gh(3, "c")], db);
    reorderIssues(repoId, [3, 1, 2], db);
    expect(listIssues(repoId, db).map((i) => i.number)).toEqual([3, 1, 2]);
  });

  it("stores unlabelled issues too (full backlog sync)", () => {
    syncIssuesFromGh(
      repoId,
      [
        { number: 1, title: "Backlog one", labels: [] },
        { number: 2, title: "Queued one", labels: [{ name: "drydock:queue" }] },
      ],
      db,
    );
    const all = listIssues(repoId, db);
    expect(all).toHaveLength(2);
    expect(JSON.parse(defined(all.find((i) => i.number === 1)).labels)).toEqual([]);
    expect(JSON.parse(defined(all.find((i) => i.number === 2)).labels)).toContain("drydock:queue");
  });

  it("setQueueLabelLocal adds and removes the queue label in the cached row", () => {
    syncIssuesFromGh(repoId, [{ number: 7, title: "X", labels: [] }], db);
    setQueueLabelLocal(repoId, 7, "drydock:queue", true, db);
    expect(JSON.parse(defined(listIssues(repoId, db)[0]).labels)).toContain("drydock:queue");
    setQueueLabelLocal(repoId, 7, "drydock:queue", false, db);
    expect(JSON.parse(defined(listIssues(repoId, db)[0]).labels)).not.toContain("drydock:queue");
  });
});
