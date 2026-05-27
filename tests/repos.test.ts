import { type DB, createDb } from "@/lib/db/client";
import { listRepos, listReposWithStats } from "@/lib/db/queries";
import { jobs } from "@/lib/db/schema";
import { addRepo, removeRepo, updateRepo } from "@/lib/repos/service";
import { beforeEach, describe, expect, it } from "vitest";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

describe("repos service", () => {
  it("adds a repo with defaults", () => {
    const repo = addRepo({ path: "/tmp/foo", name: "foo" }, db);
    expect(repo.id).toBeGreaterThan(0);
    expect(repo.defaultBranch).toBe("main");
    expect(repo.queueLabel).toBe("drydock:queue");
  });

  it("rejects empty path", () => {
    expect(() => addRepo({ path: "", name: "x" }, db)).toThrow();
  });

  it("updates a repo", () => {
    const repo = addRepo({ path: "/tmp/foo", name: "foo" }, db);
    const updated = updateRepo(repo.id, { name: "bar", defaultModel: "claude-haiku-4-5" }, db);
    expect(updated.name).toBe("bar");
    expect(updated.defaultModel).toBe("claude-haiku-4-5");
  });

  it("removes a repo", () => {
    const repo = addRepo({ path: "/tmp/foo", name: "foo" }, db);
    removeRepo(repo.id, db);
    expect(listRepos(db)).toHaveLength(0);
  });
});

describe("listReposWithStats", () => {
  it("counts active jobs and returns last 5 runs", () => {
    const repo = addRepo({ path: "/tmp/foo", name: "foo" }, db);
    db.insert(jobs).values({ repoId: repo.id, issueNumber: 1, status: "working" }).run();
    db.insert(jobs).values({ repoId: repo.id, issueNumber: 2, status: "merged" }).run();
    const stats = listReposWithStats(db);
    expect(stats).toHaveLength(1);
    expect(stats[0]?.activeJobs).toBe(1);
    expect(stats[0]?.recentJobs).toHaveLength(2);
  });
});
