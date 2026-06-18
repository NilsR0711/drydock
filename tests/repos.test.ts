import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { listRepos, listReposWithStats } from "@/lib/db/queries";
import { jobs, openrouterModels } from "@/lib/db/schema";
import { repoAutomation } from "@/lib/repos/automation";
import { addRepo, removeRepo, updateRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

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

  it("rejects an apiBaseUrl that is not an absolute http(s) URL (issue #110)", () => {
    expect(() =>
      addRepo({ path: "/bad-url", name: "x", apiBaseUrl: "javascript:alert(1)" }, db),
    ).toThrow();
    expect(() =>
      addRepo({ path: "/bad-url2", name: "x", apiBaseUrl: "gitlab.corp.local" }, db),
    ).toThrow();
    expect(() =>
      addRepo({ path: "/bad-url3", name: "x", apiBaseUrl: "file:///etc/passwd" }, db),
    ).toThrow();
  });

  it("accepts a valid absolute https apiBaseUrl and treats empty as unset (issue #110)", () => {
    const repo = addRepo(
      { path: "/ok-url", name: "x", apiBaseUrl: "https://gitlab.corp.local:8443" },
      db,
    );
    expect(repo.apiBaseUrl).toBe("https://gitlab.corp.local:8443");
    const empty = addRepo({ path: "/empty-url", name: "y", apiBaseUrl: "" }, db);
    expect(empty.apiBaseUrl ?? "").toBe("");
  });

  it("new repo defaults to the opus model (schema/service consistent)", () => {
    const repo = addRepo({ path: "/m", name: "m" }, db);
    expect(repo.defaultModel).toBe("claude-opus-4-8");
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

  it("defaults the merge-without-checks policy to off and can opt in (issue #207)", () => {
    const repo = addRepo({ path: "/mwc", name: "mwc" }, db);
    expect(repo.mergeWithoutChecks).toBe(false);
    expect(repoAutomation(repo).mergeWithoutChecks).toBe(false);
    const updated = updateRepo(repo.id, { mergeWithoutChecks: true }, db);
    expect(updated.mergeWithoutChecks).toBe(true);
    expect(repoAutomation(updated).mergeWithoutChecks).toBe(true);
  });

  it("defaults review-feedback ON with sensible trusted-bot defaults and can opt out (issue #213)", () => {
    const repo = addRepo({ path: "/arf", name: "arf" }, db);
    // Autonomous operation: act on review-bot feedback out of the box.
    expect(repo.autoReviewFeedback).toBe(true);
    expect(repoAutomation(repo).autoReviewFeedback).toBe(true);
    // The loop is inert without trusted bots, so ship well-known reviewers.
    expect(repoAutomation(repo).trustedBots).toEqual(["cursor[bot]", "coderabbitai[bot]"]);
    // Opt-out per repo remains available.
    const off = updateRepo(repo.id, { autoReviewFeedback: false }, db);
    expect(off.autoReviewFeedback).toBe(false);
    expect(repoAutomation(off).autoReviewFeedback).toBe(false);
  });

  it("lets a repo override the default trusted bots (issue #213)", () => {
    const repo = addRepo({ path: "/tb", name: "tb", trustedBots: ["coderabbitai[bot]"] }, db);
    expect(repoAutomation(repo).trustedBots).toEqual(["coderabbitai[bot]"]);
    const updated = updateRepo(repo.id, { trustedBots: [] }, db);
    expect(repoAutomation(updated).trustedBots).toEqual([]);
  });

  it("defaults the per-job cost ceiling override to unset (issue #57)", () => {
    const repo = addRepo({ path: "/jc", name: "jc" }, db);
    expect(repo.maxJobCostUsd).toBeNull();
  });

  it("stores and updates a per-job cost ceiling override (issue #57)", () => {
    const repo = addRepo({ path: "/jc2", name: "jc2", maxJobCostUsd: 3 }, db);
    expect(repo.maxJobCostUsd).toBe(3);
    const updated = updateRepo(repo.id, { maxJobCostUsd: 1.5 }, db);
    expect(updated.maxJobCostUsd).toBe(1.5);
  });

  it("rejects a negative per-job cost ceiling override (issue #57)", () => {
    expect(() => addRepo({ path: "/jc3", name: "jc3", maxJobCostUsd: -2 }, db)).toThrow();
  });

  it("defaults the per-repo time-limit overrides to unset (issues #47/#52)", () => {
    const repo = addRepo({ path: "/tl", name: "tl" }, db);
    expect(repo.maxJobMinutes).toBeNull();
    expect(repo.maxCiWaitMinutes).toBeNull();
  });

  it("stores and updates per-repo time-limit overrides (issues #47/#52)", () => {
    const repo = addRepo(
      { path: "/tl2", name: "tl2", maxJobMinutes: 90, maxCiWaitMinutes: 45 },
      db,
    );
    expect(repo.maxJobMinutes).toBe(90);
    expect(repo.maxCiWaitMinutes).toBe(45);
    const updated = updateRepo(repo.id, { maxJobMinutes: 120, maxCiWaitMinutes: 60 }, db);
    expect(updated.maxJobMinutes).toBe(120);
    expect(updated.maxCiWaitMinutes).toBe(60);
  });

  it("clears a per-repo time-limit override back to the global default via null", () => {
    const repo = addRepo(
      { path: "/tl3", name: "tl3", maxJobMinutes: 90, maxCiWaitMinutes: 45 },
      db,
    );
    const updated = updateRepo(repo.id, { maxJobMinutes: null, maxCiWaitMinutes: null }, db);
    expect(updated.maxJobMinutes).toBeNull();
    expect(updated.maxCiWaitMinutes).toBeNull();
  });

  it("rejects negative or non-integer time-limit overrides", () => {
    expect(() => addRepo({ path: "/tl4", name: "tl4", maxJobMinutes: -1 }, db)).toThrow();
    expect(() => addRepo({ path: "/tl5", name: "tl5", maxCiWaitMinutes: -5 }, db)).toThrow();
    expect(() => addRepo({ path: "/tl6", name: "tl6", maxJobMinutes: 1.5 }, db)).toThrow();
    expect(() => addRepo({ path: "/tl7", name: "tl7", maxCiWaitMinutes: 2.5 }, db)).toThrow();
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

  it("defaults model escalation on retry to off and lets a repo opt in (issue #179)", () => {
    const repo = addRepo({ path: "/esc", name: "esc" }, db);
    expect(repo.escalateModelOnRetry).toBe(false);
    const updated = updateRepo(repo.id, { escalateModelOnRetry: true }, db);
    expect(updated.escalateModelOnRetry).toBe(true);
  });

  it("defaults release management to off and parses it (issue #59)", () => {
    const repo = addRepo({ path: "/rel", name: "rel" }, db);
    expect(repo.releaseEnabled).toBe(false);
    expect(repoAutomation(repo).releaseEnabled).toBe(false);
    const updated = updateRepo(repo.id, { releaseEnabled: true }, db);
    expect(updated.releaseEnabled).toBe(true);
    expect(repoAutomation(updated).releaseEnabled).toBe(true);
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

  it("rejects an unknown defaultModel id in addRepo (issue #93)", () => {
    expect(() =>
      addRepo({ path: "/bad-model", name: "x", defaultModel: "claude-fake-99" }, db),
    ).toThrow();
  });

  it("rejects an unknown defaultModel id in updateRepo (issue #93)", () => {
    const repo = addRepo({ path: "/upd-model", name: "upd" }, db);
    expect(() => updateRepo(repo.id, { defaultModel: "claude-fake-99" }, db)).toThrow();
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

describe("updateRepo partial semantics", () => {
  it("leaves omitted defaulted fields untouched on a partial update", () => {
    const repo = addRepo(
      {
        path: "/p",
        name: "p",
        agent: "codex",
        defaultModel: "gpt-5",
        adrGating: true,
        readyLabels: ["go"],
        dailyCostLimitUsd: 42,
      },
      db,
    );
    const updated = updateRepo(repo.id, { mergeGateMinutes: 7 }, db);
    expect(updated.mergeGateMinutes).toBe(7);
    // None of these were part of the patch — they must keep their stored
    // values instead of snapping back to the schema defaults.
    expect(updated.agent).toBe("codex");
    expect(updated.defaultModel).toBe("gpt-5");
    expect(updated.adrGating).toBe(true);
    expect(updated.readyLabels).toBe('["go"]');
    expect(updated.dailyCostLimitUsd).toBe(42);
  });

  it("returns the repo unchanged for an empty patch", () => {
    const repo = addRepo({ path: "/p", name: "p", agent: "codex", defaultModel: "gpt-5" }, db);
    const updated = updateRepo(repo.id, {}, db);
    expect(updated.agent).toBe("codex");
    expect(updated.defaultModel).toBe("gpt-5");
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

describe("PR audit settings (issue #168)", () => {
  it("defaults to off with inherited agent/model and English output", () => {
    const repo = addRepo({ path: "/tmp/foo", name: "foo" }, db);
    expect(repo.autoPrAudit).toBe(false);
    expect(repo.prAuditAgent).toBeNull();
    expect(repo.prAuditModel).toBeNull();
    expect(repo.prAuditLanguage).toBe("en");
    expect(repo.prAuditPostOnPr).toBe(false);
  });

  it("persists explicit audit settings", () => {
    const repo = addRepo(
      {
        path: "/tmp/foo",
        name: "foo",
        autoPrAudit: true,
        prAuditAgent: "codex",
        prAuditModel: "gpt-5-codex",
        prAuditLanguage: "de",
        prAuditPostOnPr: true,
      },
      db,
    );
    expect(repo.autoPrAudit).toBe(true);
    expect(repo.prAuditAgent).toBe("codex");
    expect(repo.prAuditModel).toBe("gpt-5-codex");
    expect(repo.prAuditLanguage).toBe("de");
    expect(repo.prAuditPostOnPr).toBe(true);
  });

  it("updates audit settings and clears overrides back to inherit", () => {
    const repo = addRepo(
      { path: "/tmp/foo", name: "foo", prAuditAgent: "claude", prAuditModel: "claude-opus-4-8" },
      db,
    );
    const updated = updateRepo(
      repo.id,
      { autoPrAudit: true, prAuditAgent: null, prAuditModel: null },
      db,
    );
    expect(updated.autoPrAudit).toBe(true);
    expect(updated.prAuditAgent).toBeNull();
    expect(updated.prAuditModel).toBeNull();
  });

  it("rejects an unknown audit model id", () => {
    expect(() => addRepo({ path: "/x", name: "x", prAuditModel: "gpt-99-nonsense" }, db)).toThrow();
  });

  it("rejects an unknown audit agent", () => {
    expect(() =>
      addRepo({ path: "/x", name: "x", prAuditAgent: "copilot" } as never, db),
    ).toThrow();
  });

  it("accepts simple and BCP 47 language codes and rejects junk", () => {
    expect(addRepo({ path: "/a", name: "a", prAuditLanguage: "pt-BR" }, db).prAuditLanguage).toBe(
      "pt-BR",
    );
    expect(() => addRepo({ path: "/b", name: "b", prAuditLanguage: "" }, db)).toThrow();
    expect(() => addRepo({ path: "/c", name: "c", prAuditLanguage: "not a code" }, db)).toThrow();
  });
});

describe("openrouter repos (issue #169)", () => {
  function seedModel(id: string, over: Record<string, unknown> = {}) {
    db.insert(openrouterModels)
      .values({
        id,
        name: id,
        supportedParameters: '["tools"]',
        supportsTools: true,
        isFree: false,
        syncedAt: 1,
        ...over,
      })
      .run();
  }

  it("accepts an openrouter agent with an available catalog model", () => {
    seedModel("meta-llama/llama-3.3-70b-instruct:free", { isFree: true });
    const repo = addRepo(
      {
        path: "/or",
        name: "or",
        agent: "openrouter",
        defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
      },
      db,
    );
    expect(repo.agent).toBe("openrouter");
    expect(repo.defaultModel).toBe("meta-llama/llama-3.3-70b-instruct:free");
  });

  it("rejects an openrouter model missing from the synced catalog", () => {
    expect(() =>
      addRepo({ path: "/or", name: "or", agent: "openrouter", defaultModel: "missing/model" }, db),
    ).toThrow(/catalog/i);
  });

  it("rejects removed and expired catalog models", () => {
    seedModel("legacy/gone", { removedAt: 1 });
    seedModel("legacy/expired", { expirationDate: 1 });
    expect(() =>
      addRepo({ path: "/a", name: "a", agent: "openrouter", defaultModel: "legacy/gone" }, db),
    ).toThrow(/catalog/i);
    expect(() =>
      addRepo({ path: "/b", name: "b", agent: "openrouter", defaultModel: "legacy/expired" }, db),
    ).toThrow(/catalog/i);
  });

  it("enforces the global free-models-only policy at write time", () => {
    saveSettings({ openrouterFreeModelsOnly: true }, db);
    seedModel("openai/gpt-4o-mini");
    expect(() =>
      addRepo(
        { path: "/or", name: "or", agent: "openrouter", defaultModel: "openai/gpt-4o-mini" },
        db,
      ),
    ).toThrow(/free/i);
  });

  it("still rejects unknown CLI model ids (issue #93 regression)", () => {
    expect(() =>
      addRepo({ path: "/x", name: "x", defaultModel: "claude-nonexistent-99" }, db),
    ).toThrow(/unknown model id/i);
  });

  it("revalidates the model when an update switches the agent", () => {
    seedModel("anthropic/claude-fable-5");
    const repo = addRepo({ path: "/or", name: "or" }, db);
    // The repo's claude default model is not an OpenRouter catalog id.
    expect(() => updateRepo(repo.id, { agent: "openrouter" }, db)).toThrow(/catalog/i);
    const ok = updateRepo(
      repo.id,
      { agent: "openrouter", defaultModel: "anthropic/claude-fable-5" },
      db,
    );
    expect(ok.agent).toBe("openrouter");
    // And back: switching to codex with an OpenRouter id must fail too.
    expect(() => updateRepo(repo.id, { agent: "codex" }, db)).toThrow(/unknown model id/i);
  });
});
