process.env.DRYDOCK_DB = ":memory:";

import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { listJobsPage } from "@/lib/db/queries";
import { issues, jobs, repos } from "@/lib/db/schema";

const NOW = Math.floor(Date.parse("2026-05-30T12:00:00Z") / 1000);

function seed() {
  const db = getDb();
  const repoA = db.insert(repos).values({ path: "/a", name: "alpha" }).returning().get();
  const repoB = db.insert(repos).values({ path: "/b", name: "beta" }).returning().get();

  db.insert(issues)
    .values([
      { repoId: repoA.id, number: 1, title: "Fix login bug", labels: "[]" },
      { repoId: repoA.id, number: 2, title: "Add dark mode", labels: "[]" },
      { repoId: repoB.id, number: 10, title: "Improve performance", labels: "[]" },
    ])
    .run();

  db.insert(jobs)
    .values([
      {
        repoId: repoA.id,
        issueNumber: 1,
        status: "merged",
        model: "claude-opus-4-8",
        createdAt: NOW - 300,
        finishedAt: NOW - 200,
        costUsd: 0.1,
      },
      {
        repoId: repoA.id,
        issueNumber: 2,
        status: "aborted",
        model: "claude-sonnet-4-5",
        createdAt: NOW - 200,
        finishedAt: NOW - 100,
        costUsd: 0.05,
      },
      {
        repoId: repoA.id,
        issueNumber: 1,
        status: "working",
        model: "claude-opus-4-8",
        createdAt: NOW - 50,
        costUsd: 0,
      },
      {
        repoId: repoB.id,
        issueNumber: 10,
        status: "merged",
        model: "claude-haiku-4-5",
        createdAt: NOW - 100,
        finishedAt: NOW - 60,
        costUsd: 0.02,
      },
    ])
    .run();

  return { repoA, repoB };
}

describe("listJobsPage", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(jobs).run();
    db.delete(issues).run();
    db.delete(repos).run();
  });

  it("returns all jobs paginated, newest first", () => {
    seed();
    const result = listJobsPage({});
    expect(result.total).toBe(4);
    expect(result.rows).toHaveLength(4);
    expect(result.page).toBe(1);
    // Newest job (createdAt = NOW - 50) is first
    expect(result.rows[0]?.status).toBe("working");
  });

  it("respects pageSize and page offset", () => {
    seed();
    const page1 = listJobsPage({ pageSize: 2, page: 1 });
    const page2 = listJobsPage({ pageSize: 2, page: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(2);
    expect(page1.totalPages).toBe(2);
    expect(page1.rows[0]?.id).not.toBe(page2.rows[0]?.id);
  });

  it("filters by status", () => {
    seed();
    const result = listJobsPage({ status: "merged" });
    expect(result.total).toBe(2);
    expect(result.rows.every((r) => r.status === "merged")).toBe(true);
  });

  it("filters by repoId", () => {
    const { repoA } = seed();
    const result = listJobsPage({ repoId: repoA.id });
    expect(result.total).toBe(3);
    expect(result.rows.every((r) => r.repoId === repoA.id)).toBe(true);
  });

  it("filters by model", () => {
    seed();
    const result = listJobsPage({ model: "claude-opus-4-8" });
    expect(result.total).toBe(2);
    expect(result.rows.every((r) => r.model === "claude-opus-4-8")).toBe(true);
  });

  it("includes repoName in each row", () => {
    seed();
    const result = listJobsPage({});
    for (const row of result.rows) {
      expect(["alpha", "beta"]).toContain(row.repoName);
    }
  });

  it("includes issueTitle when the issue exists", () => {
    seed();
    const result = listJobsPage({ status: "merged" });
    const titles = result.rows.map((r) => r.issueTitle);
    expect(titles).toContain("Fix login bug");
    expect(titles).toContain("Improve performance");
  });

  it("returns null issueTitle for jobs without a cached issue row", () => {
    const db = getDb();
    const repo = db.insert(repos).values({ path: "/c", name: "gamma" }).returning().get();
    db.insert(jobs)
      .values({ repoId: repo.id, issueNumber: 99, status: "queued", model: null })
      .run();
    const result = listJobsPage({});
    expect(result.rows[0]?.issueTitle).toBeNull();
  });

  it("searches by exact issue number", () => {
    seed();
    const result = listJobsPage({ search: "10" });
    expect(result.total).toBe(1);
    expect(result.rows[0]?.issueNumber).toBe(10);
  });

  it("searches by issue title substring (case-insensitive)", () => {
    seed();
    // Issue #1 "Fix login bug" has two jobs in the seed data
    const result = listJobsPage({ search: "login" });
    expect(result.total).toBe(2);
    expect(result.rows.every((r) => r.issueTitle === "Fix login bug")).toBe(true);
  });

  it("search returns all matching rows across repos", () => {
    seed();
    // "mode" matches "Add dark mode" and "Improve performance" doesn't; but "dark" is unique
    const result = listJobsPage({ search: "dark" });
    expect(result.total).toBe(1);
    expect(result.rows[0]?.issueTitle).toBe("Add dark mode");
  });

  it("escapes LIKE wildcards: '%' is matched literally", () => {
    const db = getDb();
    const repo = db.insert(repos).values({ path: "/w", name: "wild" }).returning().get();
    db.insert(issues)
      .values([
        { repoId: repo.id, number: 1, title: "Reach 100% coverage", labels: "[]" },
        { repoId: repo.id, number: 2, title: "Reach 100x coverage", labels: "[]" },
      ])
      .run();
    db.insert(jobs)
      .values([
        { repoId: repo.id, issueNumber: 1, status: "merged" },
        { repoId: repo.id, issueNumber: 2, status: "merged" },
      ])
      .run();
    const result = listJobsPage({ search: "100%" });
    expect(result.total).toBe(1);
    expect(result.rows[0]?.issueTitle).toBe("Reach 100% coverage");
  });

  it("escapes LIKE wildcards: '_' is matched literally", () => {
    const db = getDb();
    const repo = db.insert(repos).values({ path: "/w2", name: "wild2" }).returning().get();
    db.insert(issues)
      .values([
        { repoId: repo.id, number: 1, title: "Rename re_name field", labels: "[]" },
        { repoId: repo.id, number: 2, title: "Rename reXname field", labels: "[]" },
      ])
      .run();
    db.insert(jobs)
      .values([
        { repoId: repo.id, issueNumber: 1, status: "merged" },
        { repoId: repo.id, issueNumber: 2, status: "merged" },
      ])
      .run();
    const result = listJobsPage({ search: "re_name" });
    expect(result.total).toBe(1);
    expect(result.rows[0]?.issueTitle).toBe("Rename re_name field");
  });

  it("escapes LIKE wildcards: a literal backslash still matches", () => {
    const db = getDb();
    const repo = db.insert(repos).values({ path: "/w3", name: "wild3" }).returning().get();
    db.insert(issues)
      .values({ repoId: repo.id, number: 1, title: "Fix C:\\temp path handling", labels: "[]" })
      .run();
    db.insert(jobs).values({ repoId: repo.id, issueNumber: 1, status: "merged" }).run();
    const result = listJobsPage({ search: "C:\\temp" });
    expect(result.total).toBe(1);
    expect(result.rows[0]?.issueTitle).toBe("Fix C:\\temp path handling");
  });

  it("returns empty result when no jobs exist", () => {
    const result = listJobsPage({});
    expect(result.total).toBe(0);
    expect(result.rows).toHaveLength(0);
    expect(result.totalPages).toBe(0);
  });

  it("clamps page to 1 when requested page exceeds totalPages", () => {
    seed();
    const result = listJobsPage({ page: 999, pageSize: 10 });
    expect(result.rows).toHaveLength(4);
    expect(result.page).toBe(1);
  });

  it("orders same-createdAt jobs by id descending (stable tiebreaker)", () => {
    const db = getDb();
    const repo = db.insert(repos).values({ path: "/batch", name: "batch" }).returning().get();

    // Simulate a bulk enqueue: every job shares the same one-second createdAt,
    // so id (autoincrement insertion order) is the only deterministic tiebreaker.
    const sameSecond = NOW;
    const inserted = db
      .insert(jobs)
      .values([
        { repoId: repo.id, issueNumber: 1, status: "queued", createdAt: sameSecond },
        { repoId: repo.id, issueNumber: 2, status: "working", createdAt: sameSecond },
        { repoId: repo.id, issueNumber: 3, status: "merged", createdAt: sameSecond },
        { repoId: repo.id, issueNumber: 4, status: "aborted", createdAt: sameSecond },
      ])
      .returning()
      .all();

    const expectedIds = inserted.map((j) => j.id).sort((a, b) => b - a);

    // Stable across repeated reads (no non-deterministic scrambling).
    for (let i = 0; i < 3; i++) {
      const result = listJobsPage({ repoId: repo.id });
      expect(result.rows.map((r) => r.id)).toEqual(expectedIds);
    }
  });
});
