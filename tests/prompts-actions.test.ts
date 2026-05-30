process.env.DRYDOCK_DB = ":memory:";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { getVersionAction, loadTemplateAction, saveTemplateAction } from "@/lib/prompts/actions";
import { TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { addRepo } from "@/lib/repos/service";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let repoId: number;
beforeEach(() => {
  repoId = addRepo({ path: "/tmp/r", name: "acme" }, getDb()).id;
});

describe("loadTemplateAction", () => {
  it("returns effective content and an empty version list for a repo with no saved template", async () => {
    const res = await loadTemplateAction(repoId, TEMPLATE_NAMES.main);
    expect(typeof res.content).toBe("string");
    expect(res.content.length).toBeGreaterThan(0);
    expect(res.versions).toEqual([]);
    expect(res.hasRow).toBe(false);
  });

  it("includes full content for each version", async () => {
    await saveTemplateAction({ repoId, name: TEMPLATE_NAMES.main, content: "v1 content" });
    await saveTemplateAction({ repoId, name: TEMPLATE_NAMES.main, content: "v2 content" });

    const res = await loadTemplateAction(repoId, TEMPLATE_NAMES.main);

    expect(res.versions).toHaveLength(2);
    // newest first
    expect(res.versions[0]?.version).toBe(2);
    expect(res.versions[0]?.content).toBe("v2 content");
    expect(res.versions[1]?.version).toBe(1);
    expect(res.versions[1]?.content).toBe("v1 content");
  });

  it("includes updatedAt for each version", async () => {
    await saveTemplateAction({ repoId, name: TEMPLATE_NAMES.main, content: "hello" });

    const res = await loadTemplateAction(repoId, TEMPLATE_NAMES.main);

    expect(typeof res.versions[0]?.updatedAt).toBe("number");
  });
});

describe("getVersionAction", () => {
  it("returns the full content of a specific version", async () => {
    await saveTemplateAction({ repoId, name: TEMPLATE_NAMES.main, content: "first" });
    await saveTemplateAction({ repoId, name: TEMPLATE_NAMES.main, content: "second" });

    const v1 = await getVersionAction(repoId, TEMPLATE_NAMES.main, 1);
    expect(v1?.content).toBe("first");
    expect(v1?.version).toBe(1);
  });

  it("returns null for a version that does not exist", async () => {
    const result = await getVersionAction(repoId, TEMPLATE_NAMES.main, 99);
    expect(result).toBeNull();
  });

  it("does not leak content from another repo", async () => {
    const otherId = addRepo({ path: "/tmp/r2", name: "other" }, getDb()).id;
    await saveTemplateAction({ repoId, name: TEMPLATE_NAMES.main, content: "secret" });

    const result = await getVersionAction(otherId, TEMPLATE_NAMES.main, 1);
    expect(result).toBeNull();
  });
});
