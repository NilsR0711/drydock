process.env.DRYDOCK_DB = ":memory:";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { promptTemplates, repos, settings } from "@/lib/db/schema";
import { addRepo } from "@/lib/repos/service";
import { DRYDOCK_CONFIG_VERSION } from "@/lib/settings/config-bundle";
import {
  exportConfigAction,
  importConfigAction,
  previewConfigImportAction,
} from "@/lib/settings/config-bundle-actions";
import { getSettings, SETTINGS_REDACTION_PLACEHOLDER, saveSettings } from "@/lib/settings/service";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

beforeEach(() => {
  const db = getDb();
  db.delete(promptTemplates).run();
  db.delete(repos).run();
  db.delete(settings).run();
});

describe("config bundle actions", () => {
  it("exports the current config as a redacted bundle", async () => {
    saveSettings({ maxParallelJobs: 4, smtpPass: "top-secret" });
    addRepo({ path: "/a", name: "owner/a" });
    const bundle = await exportConfigAction();
    expect(bundle.drydockConfigVersion).toBe(DRYDOCK_CONFIG_VERSION);
    expect(bundle.settings.maxParallelJobs).toBe(4);
    expect(bundle.settings.smtpPass).toBe(SETTINGS_REDACTION_PLACEHOLDER);
    expect(bundle.repos.map((r) => r.name)).toContain("owner/a");
  });

  it("previews changes from pasted bundle text", async () => {
    addRepo({ path: "/a", name: "owner/a", planFirst: false });
    const text = JSON.stringify({
      drydockConfigVersion: DRYDOCK_CONFIG_VERSION,
      settings: { maxParallelJobs: 8 },
      repos: [{ name: "owner/a", repo: { planFirst: true } }],
    });
    const preview = await previewConfigImportAction(text);
    expect(preview.settingsChanges).toContainEqual({
      field: "maxParallelJobs",
      from: getSettings().maxParallelJobs,
      to: 8,
    });
    expect(preview.repos.find((r) => r.name === "owner/a")?.matched).toBe(true);
  });

  it("rejects invalid JSON in preview with a helpful error", async () => {
    await expect(previewConfigImportAction("{not json")).rejects.toThrow(/JSON/i);
  });

  it("applies a pasted bundle: global settings and matched repo profile", async () => {
    const repo = addRepo({ path: "/a", name: "owner/a", planFirst: false });
    const text = JSON.stringify({
      drydockConfigVersion: DRYDOCK_CONFIG_VERSION,
      settings: { maxParallelJobs: 5 },
      repos: [{ name: "owner/a", repo: { planFirst: true } }],
    });
    const result = await importConfigAction(text);
    expect(getSettings().maxParallelJobs).toBe(5);
    expect(result.appliedRepos.map((r) => r.name)).toContain("owner/a");
    expect(getDb().select().from(repos).all()[0]?.planFirst).toBe(true);
    expect(repo.id).toBeGreaterThan(0);
  });
});
