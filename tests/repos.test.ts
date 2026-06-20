import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { getRepo, listRepos, listReposWithStats } from "@/lib/db/queries";
import { jobs, openrouterModels } from "@/lib/db/schema";
import { RELEASE_PLAYBOOK_MAX_CHARS } from "@/lib/orchestrator/release-playbook";
import { repoAutomation } from "@/lib/repos/automation";
import { addRepo, removeRepo, setReleasePlaybook, updateRepo } from "@/lib/repos/service";
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

  it("new repo has no daily cost limit by default (unlimited, issue #254)", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    expect(repo.dailyCostLimitUsd).toBe(0);
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

  it("defaults backlog-driving automation OFF (opt-in) while keeping the in-flight pipeline ON (issue #285)", () => {
    const repo = addRepo({ path: "/auto", name: "auto" }, db);
    // Safe by default (issue #285): the flags that act on a whole backlog the
    // moment a repo is registered — auto-triage labelling, auto-processing the
    // ready queue into jobs, and decomposing large issues — are opt-in. A fresh
    // repo does nothing automatically until the user turns them on per repo.
    expect(repo.autoTriageEnabled).toBe(false);
    expect(repo.autoProcessEnabled).toBe(false);
    expect(repo.autoDecompose).toBe(false);
    // The in-flight pipeline that only acts on work the user already started
    // (a queued job's PR) stays autonomous out of the box: CI heal, review
    // feedback, merge-conflict repair, and post-PR verification.
    expect(repo.autoHealCi).toBe(true);
    expect(repoAutomation(repo).autoHealCi).toBe(true);
    expect(repo.autoReviewFeedback).toBe(true);
    expect(repo.autoResolveMergeConflicts).toBe(true);
    expect(repo.verifyPr).toBe(true);
    // Safe-by-default gates stay conservative: author association and label
    // gating are unchanged, and releases remain manual (hard to reverse).
    expect(repo.releaseEnabled).toBe(false);
    expect(repo.maxAttempts).toBe(3);
    expect(repo.minAuthorAssociation).toBe("approved");
    const cfg = repoAutomation(repo);
    expect(cfg.readyLabels).toContain("ready");
    expect(cfg.blockingLabels).toContain("blocked");
    expect(cfg.autoLabelWhitelist).toContain("bug");
    expect(cfg.priorityAuthors).toEqual([]);
  });

  it("lets a repo opt in to backlog-driving automation (issue #285)", () => {
    const repo = addRepo({ path: "/optin", name: "optin" }, db);
    const on = updateRepo(
      repo.id,
      { autoTriageEnabled: true, autoProcessEnabled: true, autoDecompose: true },
      db,
    );
    expect(on.autoTriageEnabled).toBe(true);
    expect(on.autoProcessEnabled).toBe(true);
    expect(on.autoDecompose).toBe(true);
  });

  it("lets a repo opt out of any autonomous default (issue #254)", () => {
    const repo = addRepo({ path: "/optout", name: "optout" }, db);
    const off = updateRepo(
      repo.id,
      {
        autoProcessEnabled: false,
        autoHealCi: false,
        verifyPr: false,
        autoDecompose: false,
        autoResolveMergeConflicts: false,
        autoPrAudit: false,
        dailyCostLimitUsd: 10,
      },
      db,
    );
    expect(off.autoProcessEnabled).toBe(false);
    expect(off.autoHealCi).toBe(false);
    expect(off.verifyPr).toBe(false);
    expect(off.autoDecompose).toBe(false);
    expect(off.autoResolveMergeConflicts).toBe(false);
    expect(off.autoPrAudit).toBe(false);
    expect(off.dailyCostLimitUsd).toBe(10);
  });

  it("defaults agent-assisted conflict resolution OFF and lets a repo opt in (issue #327)", () => {
    const repo = addRepo({ path: "/agentconf", name: "agentconf" }, db);
    // Off by default: resolving genuine content conflicts with an agent is
    // riskier than the plain rebase, so it is a deliberate per-repo choice and
    // independent of autoResolveMergeConflicts (which stays on by default).
    expect(repo.resolveConflictsWithAgent).toBe(false);
    expect(repo.autoResolveMergeConflicts).toBe(true);
    expect(repoAutomation(repo).resolveConflictsWithAgent).toBe(false);
    const on = updateRepo(repo.id, { resolveConflictsWithAgent: true }, db);
    expect(on.resolveConflictsWithAgent).toBe(true);
    expect(repoAutomation(on).resolveConflictsWithAgent).toBe(true);
  });

  it("defaults model escalation on retry to off and lets a repo opt in (issue #179)", () => {
    const repo = addRepo({ path: "/esc", name: "esc" }, db);
    expect(repo.escalateModelOnRetry).toBe(false);
    const updated = updateRepo(repo.id, { escalateModelOnRetry: true }, db);
    expect(updated.escalateModelOnRetry).toBe(true);
  });

  it("defaults bypass-permissions to off and lets a repo opt in (issue #283)", () => {
    const repo = addRepo({ path: "/byp", name: "byp" }, db);
    // Off by default: granting unrestricted shell access is dangerous and must
    // be an explicit per-repo opt-in, never the default.
    expect(repo.bypassPermissions).toBe(false);
    const updated = updateRepo(repo.id, { bypassPermissions: true }, db);
    expect(updated.bypassPermissions).toBe(true);
    const back = updateRepo(updated.id, { bypassPermissions: false }, db);
    expect(back.bypassPermissions).toBe(false);
  });

  it("defaults the command allowlist to empty and round-trips it (issue #329)", () => {
    const repo = addRepo({ path: "/allow", name: "allow" }, db);
    // No commands pre-approved by default: an empty allowlist leaves the agent
    // in the default edits-only mode (no headless Bash) until a repo opts in.
    expect(repoAutomation(repo).allowedCommands).toEqual([]);
    const updated = updateRepo(
      repo.id,
      { allowedCommands: ["git", "xcodebuild", "xcrun", "swift"] },
      db,
    );
    expect(repoAutomation(updated).allowedCommands).toEqual([
      "git",
      "xcodebuild",
      "xcrun",
      "swift",
    ]);
    // Independent of bypassPermissions — they are orthogonal opt-ins.
    expect(updated.bypassPermissions).toBe(false);
    const cleared = updateRepo(updated.id, { allowedCommands: [] }, db);
    expect(repoAutomation(cleared).allowedCommands).toEqual([]);
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
  it("defaults the audit OFF (opt-in) with inherited agent/model and English output (issue #316)", () => {
    // Opt-in by default (issue #316): a repo that already runs an external
    // reviewer (CodeRabbit, Cursor BugBot) must not pay for a second whole-PR
    // review by accident. The agent/model/language defaults still apply so the
    // audit is fully configured the moment a repo opts in.
    const repo = addRepo({ path: "/tmp/foo", name: "foo" }, db);
    expect(repo.autoPrAudit).toBe(false);
    expect(repo.prAuditAgent).toBeNull();
    expect(repo.prAuditModel).toBeNull();
    expect(repo.prAuditLanguage).toBe("en");
    // The audit is posted on the PR by default (issue #317); mirroring it onto
    // the issue stays opt-in.
    expect(repo.prAuditPostOnIssue).toBe(false);
  });

  it("lets a repo opt in to the audit (issue #316)", () => {
    const repo = addRepo({ path: "/tmp/foo", name: "foo", autoPrAudit: true }, db);
    expect(repo.autoPrAudit).toBe(true);
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
        prAuditPostOnIssue: true,
      },
      db,
    );
    expect(repo.autoPrAudit).toBe(true);
    expect(repo.prAuditAgent).toBe("codex");
    expect(repo.prAuditModel).toBe("gpt-5-codex");
    expect(repo.prAuditLanguage).toBe("de");
    expect(repo.prAuditPostOnIssue).toBe(true);
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

describe("repos service — sandboxed execution (issue #182)", () => {
  it("defaults to no sandbox for a new repo (no behavior change)", () => {
    const repo = addRepo({ path: "/s0", name: "s0" }, db);
    expect(repo.sandbox).toBe("none");
    expect(repo.sandboxImage).toBeNull();
    expect(repo.sandboxAllowNetwork).toBe(false);
    expect(repo.sandboxCpus).toBeNull();
    expect(repo.sandboxMemory).toBeNull();
  });

  it("persists an opted-in docker sandbox with its isolation knobs", () => {
    const repo = addRepo(
      {
        path: "/s1",
        name: "s1",
        sandbox: "docker",
        sandboxImage: "my/image:1",
        sandboxAllowNetwork: true,
        sandboxCpus: "2",
        sandboxMemory: "4g",
      },
      db,
    );
    expect(repo.sandbox).toBe("docker");
    expect(repo.sandboxImage).toBe("my/image:1");
    expect(repo.sandboxAllowNetwork).toBe(true);
    expect(repo.sandboxCpus).toBe("2");
    expect(repo.sandboxMemory).toBe("4g");
  });

  it("rejects an unknown sandbox mode", () => {
    expect(() => addRepo({ path: "/s2", name: "s2", sandbox: "vm" } as never, db)).toThrow();
  });

  it("toggles the sandbox on an existing repo without touching other fields", () => {
    const repo = addRepo({ path: "/s3", name: "s3" }, db);
    const updated = updateRepo(repo.id, { sandbox: "docker" }, db);
    expect(updated.sandbox).toBe("docker");
    expect(updated.name).toBe("s3");
  });

  it("exposes the sandbox fields through repoAutomation", () => {
    const repo = addRepo({ path: "/s4", name: "s4", sandbox: "docker", sandboxImage: "img:2" }, db);
    const auto = repoAutomation(repo);
    expect(auto.sandbox).toBe("docker");
    expect(auto.sandboxImage).toBe("img:2");
  });

  describe("setReleasePlaybook (issue #352)", () => {
    it("defaults the release playbook to null", () => {
      const repo = addRepo({ path: "/pb1", name: "pb1" }, db);
      expect(repo.releasePlaybook).toBeNull();
    });

    it("round-trips a playbook through the repos service", () => {
      const repo = addRepo({ path: "/pb2", name: "pb2" }, db);
      const updated = setReleasePlaybook(repo.id, "1. dispatch release-please\n2. publish", db);
      expect(updated.releasePlaybook).toBe("1. dispatch release-please\n2. publish");
      expect(getRepo(repo.id, db)?.releasePlaybook).toBe("1. dispatch release-please\n2. publish");
    });

    it("trims and length-caps the stored playbook", () => {
      const repo = addRepo({ path: "/pb3", name: "pb3" }, db);
      const updated = setReleasePlaybook(
        repo.id,
        `  ${"y".repeat(RELEASE_PLAYBOOK_MAX_CHARS + 50)}  `,
        db,
      );
      expect((updated.releasePlaybook as string).length).toBeLessThanOrEqual(
        RELEASE_PLAYBOOK_MAX_CHARS + 20,
      );
      expect(updated.releasePlaybook).toMatch(/truncated/);
    });

    it("clears the playbook when given null", () => {
      const repo = addRepo({ path: "/pb4", name: "pb4" }, db);
      setReleasePlaybook(repo.id, "something", db);
      const cleared = setReleasePlaybook(repo.id, null, db);
      expect(cleared.releasePlaybook).toBeNull();
    });

    it("leaves other fields untouched", () => {
      const repo = addRepo({ path: "/pb5", name: "pb5", agentInstructions: "be careful" }, db);
      const updated = setReleasePlaybook(repo.id, "steps", db);
      expect(updated.name).toBe("pb5");
      expect(updated.agentInstructions).toBe("be careful");
    });
  });
});
