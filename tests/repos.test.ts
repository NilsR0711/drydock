import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { listRepos, listReposWithStats } from "@/lib/db/queries";
import { jobs } from "@/lib/db/schema";
import { addRepo, removeRepo, updateRepo } from "@/lib/repos/service";

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

  it("defaults the platform to github (no regression for existing repos)", () => {
    const repo = addRepo({ path: "/gh", name: "gh" }, db);
    expect(repo.platform).toBe("github");
    expect(repo.apiBaseUrl).toBeNull();
    expect(repo.apiToken).toBeNull();
  });

  it("adds a gitlab repo with a self-hosted base URL and token", () => {
    const repo = addRepo(
      {
        path: "/gl",
        name: "gl",
        platform: "gitlab",
        apiBaseUrl: "https://gitlab.corp.local",
        apiToken: "glpat-xyz",
      },
      db,
    );
    expect(repo.platform).toBe("gitlab");
    expect(repo.apiBaseUrl).toBe("https://gitlab.corp.local");
    expect(repo.apiToken).toBe("glpat-xyz");
  });

  it("rejects an unknown platform", () => {
    expect(() => addRepo({ path: "/x", name: "x", platform: "bitbucket" } as never, db)).toThrow();
  });

  it("new repo defaults to the opus model (schema/service consistent)", () => {
    const repo = addRepo({ path: "/m", name: "m" }, db);
    expect(repo.defaultModel).toBe("claude-opus-4-7");
  });

  it("new repo gets the default daily cost limit", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    expect(repo.dailyCostLimitUsd).toBe(10);
  });

  it("updateRepo can change the daily cost limit", () => {
    const repo = addRepo({ path: "/r2", name: "r2" }, db);
    const updated = updateRepo(repo.id, { dailyCostLimitUsd: 25 }, db);
    expect(updated.dailyCostLimitUsd).toBe(25);
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
