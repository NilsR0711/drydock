import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { listRepos, listReposWithStats } from "@/lib/db/queries";
import { jobs } from "@/lib/db/schema";
import { repoAutomation } from "@/lib/repos/automation";
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

  it("defaults automation to off with safe label/author defaults", () => {
    const repo = addRepo({ path: "/auto", name: "auto" }, db);
    expect(repo.autoTriageEnabled).toBe(false);
    expect(repo.autoProcessEnabled).toBe(false);
    expect(repo.autoHealCi).toBe(false);
    expect(repoAutomation(repo).autoHealCi).toBe(false);
    expect(repo.maxAttempts).toBe(3);
    expect(repo.minAuthorAssociation).toBe("approved");
    const cfg = repoAutomation(repo);
    expect(cfg.readyLabels).toContain("ready");
    expect(cfg.blockingLabels).toContain("blocked");
    expect(cfg.autoLabelWhitelist).toContain("bug");
    expect(cfg.priorityAuthors).toEqual([]);
  });

  it("updateRepo can enable automation and override label lists", () => {
    const repo = addRepo({ path: "/auto2", name: "auto2" }, db);
    const updated = updateRepo(
      repo.id,
      {
        autoTriageEnabled: true,
        autoProcessEnabled: true,
        autoHealCi: true,
        readyLabels: ["go"],
        blockingLabels: ["hold"],
        autoLabelWhitelist: ["bug", "ready"],
        priorityAuthors: ["octocat"],
        minAuthorAssociation: "any",
        maxAttempts: 5,
      },
      db,
    );
    expect(updated.autoTriageEnabled).toBe(true);
    expect(updated.autoProcessEnabled).toBe(true);
    expect(updated.autoHealCi).toBe(true);
    expect(repoAutomation(updated).autoHealCi).toBe(true);
    expect(updated.maxAttempts).toBe(5);
    expect(updated.minAuthorAssociation).toBe("any");
    const cfg = repoAutomation(updated);
    expect(cfg.readyLabels).toEqual(["go"]);
    expect(cfg.blockingLabels).toEqual(["hold"]);
    expect(cfg.priorityAuthors).toEqual(["octocat"]);
  });

  it("defaults agent instructions to empty (no behavior change when unset)", () => {
    const repo = addRepo({ path: "/ai", name: "ai" }, db);
    expect(repo.agentInstructions ?? "").toBe("");
  });

  it("stores and updates custom agent instructions", () => {
    const repo = addRepo(
      { path: "/ai2", name: "ai2", agentInstructions: "Always run pnpm test." },
      db,
    );
    expect(repo.agentInstructions).toBe("Always run pnpm test.");
    const updated = updateRepo(repo.id, { agentInstructions: "Don't touch legacy/." }, db);
    expect(updated.agentInstructions).toBe("Don't touch legacy/.");
  });

  it("rejects agent instructions that exceed the length cap", () => {
    expect(() =>
      addRepo({ path: "/ai3", name: "ai3", agentInstructions: "x".repeat(4001) }, db),
    ).toThrow();
  });

  it("rejects an unknown author-association value", () => {
    expect(() =>
      addRepo({ path: "/bad", name: "bad", minAuthorAssociation: "everyone" } as never, db),
    ).toThrow();
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
