process.env.DRYDOCK_DB = ":memory:";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { promptTemplates, repos } from "@/lib/db/schema";
import { addRepo } from "@/lib/repos/service";
import {
  exportRepoSettingsAction,
  importRepoSettingsAction,
  previewImportAction,
} from "@/lib/repos/settings-bundle-actions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

beforeEach(() => {
  const db = getDb();
  db.delete(promptTemplates).run();
  db.delete(repos).run();
});

describe("settings bundle actions", () => {
  it("exports a repo's settings as a bundle", async () => {
    const repo = addRepo({ path: "/a", name: "a", planFirst: true });
    const bundle = await exportRepoSettingsAction(repo.id);
    expect(bundle.repo.planFirst).toBe(true);
    expect(bundle.drydockSettingsVersion).toBe(1);
  });

  it("previews changes from pasted bundle text", async () => {
    const repo = addRepo({ path: "/b", name: "b", planFirst: false });
    const text = JSON.stringify({ drydockSettingsVersion: 1, repo: { planFirst: true } });
    const preview = await previewImportAction(repo.id, text);
    expect(preview.repoChanges).toContainEqual({ field: "planFirst", from: false, to: true });
  });

  it("rejects invalid JSON in preview with a helpful error", async () => {
    const repo = addRepo({ path: "/c", name: "c" });
    await expect(previewImportAction(repo.id, "{not json")).rejects.toThrow(/JSON/i);
  });

  it("imports a pasted bundle and applies it", async () => {
    const repo = addRepo({ path: "/d", name: "d" });
    const text = JSON.stringify({
      drydockSettingsVersion: 1,
      repo: { planFirst: true },
      promptTemplates: { default: "hi" },
    });
    const result = await importRepoSettingsAction(repo.id, text);
    expect(result.repo.planFirst).toBe(true);
    expect(result.appliedTemplates).toContain("default");
  });

  it("rejects invalid JSON on import", async () => {
    const repo = addRepo({ path: "/e", name: "e" });
    await expect(importRepoSettingsAction(repo.id, "nope")).rejects.toThrow(/JSON/i);
  });
});
