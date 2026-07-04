import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import { getServerLogger } from "@/lib/log/server-log";
import { getActiveTemplate, saveTemplate } from "@/lib/prompts/templates";
import { addRepo } from "@/lib/repos/service";
import {
  DRYDOCK_CONFIG_VERSION,
  exportConfigBundle,
  importConfigBundle,
  parseConfigBundle,
  previewConfigBundle,
} from "@/lib/settings/config-bundle";
import { getSettings, SETTINGS_REDACTION_PLACEHOLDER, saveSettings } from "@/lib/settings/service";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

describe("exportConfigBundle", () => {
  it("produces a versioned document with global settings and per-repo config", () => {
    saveSettings({ maxParallelJobs: 5, dailyCostLimitUsd: 12 }, db);
    addRepo({ path: "/a", name: "owner/a", planFirst: true }, db);

    const bundle = exportConfigBundle(db);

    expect(bundle.drydockConfigVersion).toBe(DRYDOCK_CONFIG_VERSION);
    expect(bundle.settings.maxParallelJobs).toBe(5);
    expect(bundle.settings.dailyCostLimitUsd).toBe(12);
    expect(bundle.repos).toHaveLength(1);
    expect(bundle.repos[0]?.name).toBe("owner/a");
    expect(bundle.repos[0]?.repo.planFirst).toBe(true);
  });

  it("redacts secret settings and never emits their plaintext", () => {
    saveSettings(
      {
        telegramBotToken: "123456:AAsecrettoken",
        slackWebhookUrl: "https://hooks.slack.com/services/T/B/secret",
        smtpPass: "hunter2",
        openrouterApiKey: "sk-or-v1-secret",
      },
      db,
    );

    const bundle = exportConfigBundle(db);
    const serialized = JSON.stringify(bundle);

    expect(bundle.settings.telegramBotToken).toBe(SETTINGS_REDACTION_PLACEHOLDER);
    expect(bundle.settings.slackWebhookUrl).toBe(SETTINGS_REDACTION_PLACEHOLDER);
    expect(bundle.settings.smtpPass).toBe(SETTINGS_REDACTION_PLACEHOLDER);
    expect(bundle.settings.openrouterApiKey).toBe(SETTINGS_REDACTION_PLACEHOLDER);
    expect(serialized).not.toContain("AAsecrettoken");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("sk-or-v1-secret");
  });

  it("excludes machine-specific and secret repo fields, keeping name as identity", () => {
    addRepo(
      {
        path: "/local/clone/path",
        name: "owner/secret",
        platform: "gitlab",
        apiBaseUrl: "https://gitlab.corp.local",
        apiToken: "glpat-supersecret",
        webhookSecret: "whk-secret",
      },
      db,
    );

    const bundle = exportConfigBundle(db);
    const entry = bundle.repos[0];
    expect(entry).toBeDefined();

    // name is kept as the cross-machine matching identity...
    expect(entry?.name).toBe("owner/secret");
    // ...but the local clone path, tokens and instance-specific endpoint never travel.
    expect(entry?.repo).not.toHaveProperty("path");
    expect(entry?.repo).not.toHaveProperty("apiToken");
    expect(entry?.repo).not.toHaveProperty("webhookSecret");
    expect(entry?.repo).not.toHaveProperty("apiBaseUrl");
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("/local/clone/path");
    expect(serialized).not.toContain("glpat-supersecret");
    expect(serialized).not.toContain("whk-secret");
  });

  it("includes per-repo prompt-template overrides", () => {
    const repo = addRepo({ path: "/a", name: "owner/a" }, db);
    saveTemplate({ repoId: repo.id, name: "default", content: "custom default" }, db);

    const bundle = exportConfigBundle(db);
    expect(bundle.repos[0]?.promptTemplates).toEqual({ default: "custom default" });
  });

  it("emits an empty repos array when no repos are registered", () => {
    const bundle = exportConfigBundle(db);
    expect(bundle.repos).toEqual([]);
  });
});

describe("parseConfigBundle", () => {
  it("rejects a bundle that is not an object", () => {
    expect(() => parseConfigBundle("nope")).toThrow();
    expect(() => parseConfigBundle(null)).toThrow();
    expect(() => parseConfigBundle([1, 2, 3])).toThrow();
  });

  it("rejects a missing or non-integer version", () => {
    expect(() => parseConfigBundle({ settings: {}, repos: [] })).toThrow(/version/i);
    expect(() => parseConfigBundle({ drydockConfigVersion: 1.5 })).toThrow(/version/i);
  });

  it("rejects a bundle from a newer, unsupported version", () => {
    expect(() => parseConfigBundle({ drydockConfigVersion: DRYDOCK_CONFIG_VERSION + 1 })).toThrow(
      /version/i,
    );
  });

  it("accepts a bundle with omitted settings and repos", () => {
    const parsed = parseConfigBundle({ drydockConfigVersion: DRYDOCK_CONFIG_VERSION });
    expect(parsed.settings).toEqual({});
    expect(parsed.repos).toEqual([]);
  });

  it("validates settings values and rejects an invalid one with a clear error", () => {
    expect(() =>
      parseConfigBundle({
        drydockConfigVersion: DRYDOCK_CONFIG_VERSION,
        settings: { maxParallelJobs: -3 },
      }),
    ).toThrow();
  });

  it("keeps known non-secret settings and drops unknown ones with a warning", () => {
    const parsed = parseConfigBundle({
      drydockConfigVersion: DRYDOCK_CONFIG_VERSION,
      settings: { maxParallelJobs: 4, bogusField: true },
    });
    expect(parsed.settings.maxParallelJobs).toBe(4);
    expect(parsed.settings).not.toHaveProperty("bogusField");
    expect(parsed.warnings.join(" ")).toMatch(/bogusField/);
  });

  it("never imports secret settings, so a redacted export can't overwrite credentials", () => {
    const parsed = parseConfigBundle({
      drydockConfigVersion: DRYDOCK_CONFIG_VERSION,
      settings: {
        maxParallelJobs: 2,
        telegramBotToken: "***",
        smtpPass: "***",
        openrouterApiKey: "sk-or-v1-realkey-pasted-by-hand",
      },
    });
    expect(parsed.settings.maxParallelJobs).toBe(2);
    expect(parsed.settings).not.toHaveProperty("telegramBotToken");
    expect(parsed.settings).not.toHaveProperty("smtpPass");
    // Even a real (non-placeholder) secret pasted into the bundle is refused.
    expect(parsed.settings).not.toHaveProperty("openrouterApiKey");
    expect(parsed.warnings.join(" ")).toMatch(/telegramBotToken|smtpPass|openrouterApiKey|secret/i);
  });

  it("validates and sanitizes each repo entry, keeping name and dropping excluded fields", () => {
    const parsed = parseConfigBundle({
      drydockConfigVersion: DRYDOCK_CONFIG_VERSION,
      repos: [
        {
          name: "owner/a",
          repo: {
            planFirst: true,
            path: "/should/be/ignored",
            apiToken: "glpat-secret",
            unknownField: 1,
          },
          promptTemplates: { default: "custom" },
        },
      ],
    });
    expect(parsed.repos).toHaveLength(1);
    expect(parsed.repos[0]?.name).toBe("owner/a");
    expect(parsed.repos[0]?.repo.planFirst).toBe(true);
    expect(parsed.repos[0]?.repo).not.toHaveProperty("path");
    expect(parsed.repos[0]?.repo).not.toHaveProperty("apiToken");
    expect(parsed.repos[0]?.repo).not.toHaveProperty("unknownField");
    expect(parsed.repos[0]?.promptTemplates).toEqual({ default: "custom" });
  });

  it("rejects a repo entry without a name (needed to match on import)", () => {
    expect(() =>
      parseConfigBundle({
        drydockConfigVersion: DRYDOCK_CONFIG_VERSION,
        repos: [{ repo: { planFirst: true } }],
      }),
    ).toThrow(/name/i);
  });

  it("rejects an invalid repo field value with a clear error", () => {
    expect(() =>
      parseConfigBundle({
        drydockConfigVersion: DRYDOCK_CONFIG_VERSION,
        repos: [{ name: "owner/a", repo: { dailyCostLimitUsd: -5 } }],
      }),
    ).toThrow();
  });
});

describe("importConfigBundle", () => {
  it("applies validated global settings", () => {
    const result = importConfigBundle(
      {
        drydockConfigVersion: DRYDOCK_CONFIG_VERSION,
        settings: { maxParallelJobs: 7, dailyCostLimitUsd: 25 },
      },
      db,
    );
    expect(getSettings(db).maxParallelJobs).toBe(7);
    expect(getSettings(db).dailyCostLimitUsd).toBe(25);
    expect(result.appliedSettings).toEqual(
      expect.arrayContaining(["maxParallelJobs", "dailyCostLimitUsd"]),
    );
  });

  it("applies a per-repo profile to the local repo matched by name", () => {
    const repo = addRepo({ path: "/local/a", name: "owner/a", planFirst: false }, db);
    const result = importConfigBundle(
      {
        drydockConfigVersion: DRYDOCK_CONFIG_VERSION,
        repos: [
          {
            name: "owner/a",
            repo: { planFirst: true, sequential: false },
            promptTemplates: { default: "shared default" },
          },
        ],
      },
      db,
    );

    expect(getRepo(repo.id, db)?.planFirst).toBe(true);
    expect(getRepo(repo.id, db)?.sequential).toBe(false);
    expect(getActiveTemplate(repo.id, "default", db)?.content).toBe("shared default");
    expect(result.appliedRepos).toHaveLength(1);
    expect(result.appliedRepos[0]?.name).toBe("owner/a");
    expect(result.skippedRepos).toEqual([]);
  });

  it("never overwrites a repo's local clone path or stored credentials", () => {
    const repo = addRepo({ path: "/local/a", name: "owner/a", apiToken: "glpat-keepme" }, db);
    importConfigBundle(
      {
        drydockConfigVersion: DRYDOCK_CONFIG_VERSION,
        repos: [{ name: "owner/a", repo: { path: "/somewhere/else", apiToken: "glpat-evil" } }],
      },
      db,
    );
    const after = getRepo(repo.id, db);
    expect(after?.path).toBe("/local/a");
    expect(after?.apiToken).toBe("glpat-keepme");
  });

  it("skips a profile with no matching local repo and reports it", () => {
    const result = importConfigBundle(
      {
        drydockConfigVersion: DRYDOCK_CONFIG_VERSION,
        repos: [{ name: "owner/missing", repo: { planFirst: true } }],
      },
      db,
    );
    expect(result.appliedRepos).toEqual([]);
    expect(result.skippedRepos).toEqual(["owner/missing"]);
    expect(result.warnings.join(" ")).toMatch(/owner\/missing/);
  });

  it("rolls back atomically and does not leak the live log level on failure", () => {
    // Establish a known live log level distinct from the bundle's.
    saveSettings({ logLevel: "info" }, db);
    expect(getServerLogger().getLevel()).toBe("info");
    addRepo({ path: "/local/a", name: "owner/a" }, db);

    // A repo profile with a claude agent on an unknown model makes updateRepo
    // throw mid-transaction, after the settings (incl. logLevel) were applied.
    const bundle = {
      drydockConfigVersion: DRYDOCK_CONFIG_VERSION,
      settings: { logLevel: "debug" },
      repos: [{ name: "owner/a", repo: { agent: "claude", defaultModel: "totally-bogus-model" } }],
    };
    expect(() => importConfigBundle(bundle, db)).toThrow();

    // The persisted settings row rolled back...
    expect(getSettings(db).logLevel).toBe("info");
    // ...and the process-wide logger singleton must not have been left on "debug".
    expect(getServerLogger().getLevel()).toBe("info");
  });

  it("re-importing a redacted export leaves stored secrets intact", () => {
    saveSettings({ smtpPass: "original-secret", maxParallelJobs: 2 }, db);
    const bundle = exportConfigBundle(db);
    // The exported secret is the placeholder, not the real value.
    expect(bundle.settings.smtpPass).toBe(SETTINGS_REDACTION_PLACEHOLDER);
    // Change an unrelated field in the bundle, then re-import it.
    bundle.settings.maxParallelJobs = 9;
    importConfigBundle(bundle, db);
    expect(getSettings(db).smtpPass).toBe("original-secret");
    expect(getSettings(db).maxParallelJobs).toBe(9);
  });
});

describe("previewConfigBundle", () => {
  it("lists settings changes without applying them", () => {
    saveSettings({ maxParallelJobs: 3 }, db);
    const preview = previewConfigBundle(
      { drydockConfigVersion: DRYDOCK_CONFIG_VERSION, settings: { maxParallelJobs: 8 } },
      db,
    );
    expect(preview.settingsChanges).toContainEqual({ field: "maxParallelJobs", from: 3, to: 8 });
    // Non-destructive: nothing changed.
    expect(getSettings(db).maxParallelJobs).toBe(3);
  });

  it("shows field and template changes for a matched repo", () => {
    const repo = addRepo({ path: "/local/a", name: "owner/a", planFirst: false }, db);
    const preview = previewConfigBundle(
      {
        drydockConfigVersion: DRYDOCK_CONFIG_VERSION,
        repos: [{ name: "owner/a", repo: { planFirst: true }, promptTemplates: { default: "x" } }],
      },
      db,
    );
    const entry = preview.repos.find((r) => r.name === "owner/a");
    expect(entry?.matched).toBe(true);
    expect(entry?.repoChanges).toContainEqual({ field: "planFirst", from: false, to: true });
    expect(entry?.templateChanges).toContainEqual({ name: "default", action: "create" });
    expect(getRepo(repo.id, db)?.planFirst).toBe(false);
  });

  it("marks a profile with no matching local repo as unmatched", () => {
    const preview = previewConfigBundle(
      {
        drydockConfigVersion: DRYDOCK_CONFIG_VERSION,
        repos: [{ name: "owner/missing", repo: { planFirst: true } }],
      },
      db,
    );
    const entry = preview.repos.find((r) => r.name === "owner/missing");
    expect(entry?.matched).toBe(false);
  });
});

describe("round-trip export → import", () => {
  it("reproduces global settings and per-repo config on a fresh instance", () => {
    // Source instance.
    const src = createDb(":memory:");
    saveSettings({ maxParallelJobs: 6, dailyCostLimitUsd: 40 }, src);
    const srcRepo = addRepo({ path: "/src/a", name: "owner/a", planFirst: true }, src);
    saveTemplate({ repoId: srcRepo.id, name: "default", content: "src default" }, src);
    const bundle = exportConfigBundle(src);

    // Target instance: same repo re-registered under a different local path.
    const dst = createDb(":memory:");
    const dstRepo = addRepo({ path: "/dst/a", name: "owner/a" }, dst);
    importConfigBundle(bundle, dst);

    expect(getSettings(dst).maxParallelJobs).toBe(6);
    expect(getSettings(dst).dailyCostLimitUsd).toBe(40);
    expect(getRepo(dstRepo.id, dst)?.planFirst).toBe(true);
    // Local clone path is preserved, not overwritten with the source path.
    expect(getRepo(dstRepo.id, dst)?.path).toBe("/dst/a");
    expect(getActiveTemplate(dstRepo.id, "default", dst)?.content).toBe("src default");
  });
});
