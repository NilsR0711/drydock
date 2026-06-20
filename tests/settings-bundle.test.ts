import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { repos } from "@/lib/db/schema";
import { saveTemplate } from "@/lib/prompts/templates";
import { addRepo } from "@/lib/repos/service";
import {
  DRYDOCK_SETTINGS_VERSION,
  EXCLUDED_BUNDLE_FIELDS,
  exportRepoSettings,
  importRepoSettings,
  parseSettingsBundle,
  previewBundleChanges,
} from "@/lib/repos/settings-bundle";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

describe("exportRepoSettings", () => {
  it("produces a versioned bundle of repo settings and template overrides", () => {
    const repo = addRepo(
      { path: "/src", name: "src", planFirst: true, trustedBots: ["coderabbitai[bot]"] },
      db,
    );
    saveTemplate({ repoId: repo.id, name: "default", content: "custom default" }, db);
    saveTemplate({ repoId: repo.id, name: "pr-format", content: "custom pr" }, db);

    const bundle = exportRepoSettings(repo.id, db);

    expect(bundle.drydockSettingsVersion).toBe(DRYDOCK_SETTINGS_VERSION);
    expect(bundle.repo.planFirst).toBe(true);
    // JSON-array columns are exported as real arrays for readability.
    expect(bundle.repo.trustedBots).toEqual(["coderabbitai[bot]"]);
    expect(bundle.promptTemplates).toEqual({ default: "custom default", "pr-format": "custom pr" });
  });

  it("excludes identity and secret fields from the bundle", () => {
    const repo = addRepo(
      {
        path: "/secret",
        name: "secret-repo",
        platform: "gitlab",
        apiBaseUrl: "https://gitlab.corp.local",
        apiToken: "glpat-supersecret",
        webhookSecret: "whk-secret",
      },
      db,
    );

    const bundle = exportRepoSettings(repo.id, db);

    for (const field of EXCLUDED_BUNDLE_FIELDS) {
      expect(bundle.repo).not.toHaveProperty(field);
    }
    expect(JSON.stringify(bundle)).not.toContain("glpat-supersecret");
    expect(JSON.stringify(bundle)).not.toContain("whk-secret");
  });

  it("only exports repo-level template overrides, not implicit defaults", () => {
    const repo = addRepo({ path: "/p", name: "p" }, db);
    const bundle = exportRepoSettings(repo.id, db);
    expect(bundle.promptTemplates).toEqual({});
  });

  it("throws for an unknown repo", () => {
    expect(() => exportRepoSettings(999, db)).toThrow();
  });
});

describe("parseSettingsBundle", () => {
  it("rejects a bundle that is not an object", () => {
    expect(() => parseSettingsBundle("nope")).toThrow();
    expect(() => parseSettingsBundle([])).toThrow();
    expect(() => parseSettingsBundle(null)).toThrow();
  });

  it("rejects a bundle without a version", () => {
    expect(() => parseSettingsBundle({ repo: {} })).toThrow(/version/i);
  });

  it("rejects a bundle from a newer, unsupported version", () => {
    expect(() =>
      parseSettingsBundle({ drydockSettingsVersion: DRYDOCK_SETTINGS_VERSION + 1, repo: {} }),
    ).toThrow(/version/i);
  });

  it("drops unknown repo fields with a warning rather than failing", () => {
    const parsed = parseSettingsBundle({
      drydockSettingsVersion: 1,
      repo: { planFirst: true, bogusField: 42 },
    });
    expect(parsed.repo.planFirst).toBe(true);
    expect(parsed.repo).not.toHaveProperty("bogusField");
    expect(parsed.warnings.join(" ")).toMatch(/bogusField/);
  });

  it("ignores excluded identity/secret fields with a warning", () => {
    const parsed = parseSettingsBundle({
      drydockSettingsVersion: 1,
      repo: { apiToken: "evil", name: "evil", sequential: false },
    });
    expect(parsed.repo).not.toHaveProperty("apiToken");
    expect(parsed.repo).not.toHaveProperty("name");
    expect(parsed.repo.sequential).toBe(false);
    expect(parsed.warnings.join(" ")).toMatch(/apiToken/);
  });

  it("rejects a bundle with an invalid field value", () => {
    expect(() =>
      parseSettingsBundle({ drydockSettingsVersion: 1, repo: { maxAttempts: -1 } }),
    ).toThrow();
  });

  it("drops unknown prompt template names with a warning", () => {
    const parsed = parseSettingsBundle({
      drydockSettingsVersion: 1,
      repo: {},
      promptTemplates: { default: "ok", bogusStage: "nope" },
    });
    expect(parsed.promptTemplates).toEqual({ default: "ok" });
    expect(parsed.warnings.join(" ")).toMatch(/bogusStage/);
  });
});

describe("importRepoSettings", () => {
  it("applies repo fields without clobbering secrets or identity", () => {
    const target = addRepo(
      { path: "/keep", name: "keep", apiToken: "keep-token", platform: "gitlab" },
      db,
    );
    const result = importRepoSettings(
      target.id,
      {
        drydockSettingsVersion: 1,
        repo: { apiToken: "evil", name: "renamed", planFirst: true, sequential: false },
      },
      db,
    );
    const updated = db.select().from(repos).where(eq(repos.id, target.id)).get();
    expect(updated?.apiToken).toBe("keep-token");
    expect(updated?.name).toBe("keep");
    expect(updated?.planFirst).toBe(true);
    expect(updated?.sequential).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/apiToken/);
  });

  it("handles unknown fields gracefully (warn + skip, not fatal)", () => {
    const target = addRepo({ path: "/u", name: "u" }, db);
    const result = importRepoSettings(
      target.id,
      { drydockSettingsVersion: 1, repo: { bogusField: 1, planFirst: true } },
      db,
    );
    const updated = db.select().from(repos).where(eq(repos.id, target.id)).get();
    expect(updated?.planFirst).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/bogusField/);
  });

  it("imports repo-level prompt templates and skips unknown stages", () => {
    const target = addRepo({ path: "/t", name: "t" }, db);
    importRepoSettings(
      target.id,
      {
        drydockSettingsVersion: 1,
        repo: {},
        promptTemplates: { default: "imported default", bogus: "x" },
      },
      db,
    );
    const bundle = exportRepoSettings(target.id, db);
    expect(bundle.promptTemplates).toEqual({ default: "imported default" });
  });

  it("leaves unrelated repo fields untouched", () => {
    const target = addRepo({ path: "/x", name: "x", maxAttempts: 7 }, db);
    importRepoSettings(target.id, { drydockSettingsVersion: 1, repo: { planFirst: true } }, db);
    const updated = db.select().from(repos).where(eq(repos.id, target.id)).get();
    expect(updated?.maxAttempts).toBe(7);
  });
});

describe("round-trip export → import", () => {
  it("reproduces the same effective configuration in a fresh repo", () => {
    const source = addRepo(
      {
        path: "/source",
        name: "source",
        planFirst: true,
        sequential: false,
        autoTriageEnabled: true,
        dailyCostLimitUsd: 25,
        maxAttempts: 5,
        maxJobMinutes: 90,
        defaultModel: "claude-haiku-4-5",
        readyLabels: ["go", "ship"],
        trustedBots: ["coderabbitai[bot]"],
        allowedCommands: ["git", "make"],
        agentInstructions: "Run pnpm test before finishing.",
        sandbox: "docker",
        sandboxImage: "my/image:1",
      },
      db,
    );
    saveTemplate({ repoId: source.id, name: "default", content: "src default" }, db);
    saveTemplate({ repoId: source.id, name: "release", content: "src release" }, db);

    const bundle = exportRepoSettings(source.id, db);

    const fresh = addRepo({ path: "/fresh", name: "fresh" }, db);
    importRepoSettings(fresh.id, bundle, db);

    const sourceRow = db.select().from(repos).where(eq(repos.id, source.id)).get();
    const freshRow = db.select().from(repos).where(eq(repos.id, fresh.id)).get();
    const ignore = new Set([...EXCLUDED_BUNDLE_FIELDS, "id", "createdAt"]);
    for (const key of Object.keys(sourceRow ?? {})) {
      if (ignore.has(key)) continue;
      expect(freshRow?.[key as keyof typeof freshRow]).toEqual(
        sourceRow?.[key as keyof typeof sourceRow],
      );
    }
    // Templates round-trip too.
    expect(exportRepoSettings(fresh.id, db).promptTemplates).toEqual({
      default: "src default",
      release: "src release",
    });
  });
});

describe("previewBundleChanges", () => {
  it("lists changed repo fields and template actions without applying them", () => {
    const target = addRepo({ path: "/prev", name: "prev", planFirst: false }, db);
    saveTemplate({ repoId: target.id, name: "default", content: "old" }, db);

    const preview = previewBundleChanges(
      target.id,
      {
        drydockSettingsVersion: 1,
        repo: { planFirst: true, sequential: true },
        promptTemplates: { default: "new", release: "fresh" },
      },
      db,
    );

    const planFirstChange = preview.repoChanges.find((c) => c.field === "planFirst");
    expect(planFirstChange).toMatchObject({ from: false, to: true });
    // sequential defaults to true, so it is unchanged and not listed.
    expect(preview.repoChanges.find((c) => c.field === "sequential")).toBeUndefined();
    expect(preview.templateChanges).toContainEqual({ name: "default", action: "update" });
    expect(preview.templateChanges).toContainEqual({ name: "release", action: "create" });

    // Nothing applied.
    const row = db.select().from(repos).where(eq(repos.id, target.id)).get();
    expect(row?.planFirst).toBe(false);
  });
});
