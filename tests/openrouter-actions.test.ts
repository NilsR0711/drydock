process.env.DRYDOCK_DB = ":memory:";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { openrouterModels, settings } from "@/lib/db/schema";
import {
  refreshOpenRouterCatalogAction,
  testOpenRouterConnectionAction,
} from "@/lib/openrouter/actions";
import { getCatalogMeta } from "@/lib/openrouter/catalog";
import { checkOpenRouterKey } from "@/lib/openrouter/client";
import { saveSettings } from "@/lib/settings/service";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const FIXTURE = readFileSync(
  fileURLToPath(new URL("./fixtures/openrouter/models.json", import.meta.url)),
  "utf8",
);

beforeEach(() => {
  getDb().delete(settings).run();
  getDb().delete(openrouterModels).run();
});

describe("checkOpenRouterKey (issue #169)", () => {
  it("reports ok for a 200 from the key endpoint", async () => {
    const res = await checkOpenRouterKey("sk-or-v1-k", async (url, init) => {
      expect(String(url)).toContain("/api/v1/key");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-v1-k");
      return new Response('{"data":{}}', { status: 200 });
    });
    expect(res).toEqual({ ok: true });
  });

  it("reports the HTTP status for a rejected key", async () => {
    const res = await checkOpenRouterKey(
      "sk-or-v1-bad",
      async () => new Response("Unauthorized", { status: 401 }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("401");
  });

  it("reports network failures", async () => {
    const res = await checkOpenRouterKey("sk-or-v1-k", async () => {
      throw new Error("offline");
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("offline");
  });
});

describe("openrouter server actions (issue #169)", () => {
  it("refreshOpenRouterCatalogAction syncs the catalog and reports the count", async () => {
    const result = await refreshOpenRouterCatalogAction(
      async () => new Response(FIXTURE, { status: 200 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.modelCount).toBe(5);
    expect(getCatalogMeta(getDb()).modelCount).toBe(5);
  });

  it("refreshOpenRouterCatalogAction surfaces sync errors", async () => {
    const result = await refreshOpenRouterCatalogAction(
      async () => new Response("oops", { status: 500 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("500");
  });

  it("testOpenRouterConnectionAction fails without a configured key", async () => {
    const result = await testOpenRouterConnectionAction();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/api key/i);
  });

  it("testOpenRouterConnectionAction checks the stored key", async () => {
    saveSettings({ openrouterApiKey: "sk-or-v1-k" });
    const result = await testOpenRouterConnectionAction(
      async () => new Response("{}", { status: 200 }),
    );
    expect(result).toEqual({ ok: true });
  });
});
