import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import {
  getCatalogMeta,
  getOpenRouterModel,
  isCatalogStale,
  listOpenRouterModels,
  parseOpenRouterCatalog,
  shouldSyncCatalog,
  syncOpenRouterCatalog,
} from "@/lib/openrouter/catalog";

const FIXTURE = readFileSync(
  fileURLToPath(new URL("./fixtures/openrouter/models.json", import.meta.url)),
  "utf8",
);

/** Epoch seconds well after the fixture's 2025-01-01 expiration date. */
const NOW = Math.floor(Date.UTC(2026, 5, 11) / 1000);

function okFetch(body: string = FIXTURE, status = 200): typeof fetch {
  return async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } });
}

function fixtureWithout(id: string): string {
  const parsed = JSON.parse(FIXTURE) as { data: Array<{ id: string }> };
  return JSON.stringify({ data: parsed.data.filter((m) => m.id !== id) });
}

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

describe("parseOpenRouterCatalog", () => {
  it("maps API entries to catalog records", () => {
    const records = parseOpenRouterCatalog(JSON.parse(FIXTURE));
    expect(records).toHaveLength(5);
    const fable = records.find((r) => r.id === "anthropic/claude-fable-5");
    expect(fable).toMatchObject({
      name: "Anthropic: Claude Fable 5",
      contextLength: 1000000,
      promptCostPerToken: 0.00001,
      completionCostPerToken: 0.00005,
      isFree: false,
      supportsTools: true,
      expirationDate: null,
    });
    expect(fable?.supportedParameters).toContain("tools");
  });

  it("derives isFree from zero pricing", () => {
    const records = parseOpenRouterCatalog(JSON.parse(FIXTURE));
    const llama = records.find((r) => r.id === "meta-llama/llama-3.3-70b-instruct:free");
    expect(llama?.isFree).toBe(true);
    expect(llama?.promptCostPerToken).toBe(0);
  });

  it("derives isFree from a :free id suffix even with nonzero pricing", () => {
    const records = parseOpenRouterCatalog({
      data: [
        {
          id: "vendor/model:free",
          name: "Vendor Model",
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
      ],
    });
    expect(records[0]?.isFree).toBe(true);
  });

  it("derives supportsTools from supported_parameters", () => {
    const records = parseOpenRouterCatalog(JSON.parse(FIXTURE));
    expect(records.find((r) => r.id === "google/gemma-2-9b-it:free")?.supportsTools).toBe(false);
    expect(records.find((r) => r.id === "openai/gpt-4o-mini")?.supportsTools).toBe(true);
  });

  it("parses expiration_date into epoch seconds", () => {
    const records = parseOpenRouterCatalog(JSON.parse(FIXTURE));
    const sunset = records.find((r) => r.id === "legacy/sunset-model");
    expect(sunset?.expirationDate).toBe(Math.floor(Date.UTC(2025, 0, 1) / 1000));
  });

  it("skips malformed entries instead of throwing", () => {
    const records = parseOpenRouterCatalog({
      data: [
        { name: "no id here" },
        { id: "ok/model", name: "OK", pricing: { prompt: "0", completion: "0" } },
      ],
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe("ok/model");
  });

  it("throws on a payload without a data array", () => {
    expect(() => parseOpenRouterCatalog({ models: [] })).toThrow();
  });
});

describe("syncOpenRouterCatalog", () => {
  it("inserts all models on first sync and records meta", async () => {
    const result = await syncOpenRouterCatalog({ db, fetchImpl: okFetch(), now: NOW });
    expect(result.ok).toBe(true);
    const all = listOpenRouterModels({ db, now: NOW, includeUnavailable: true });
    expect(all).toHaveLength(5);
    const meta = getCatalogMeta(db);
    expect(meta.lastSuccessAt).toBe(NOW);
    expect(meta.modelCount).toBe(5);
    expect(meta.consecutiveFailures).toBe(0);
    expect(meta.lastError).toBeNull();
  });

  it("sends the Authorization header only when an api key is given", async () => {
    const seen: Array<Record<string, string>> = [];
    const spyFetch: typeof fetch = async (_url, init) => {
      seen.push({ ...((init?.headers ?? {}) as Record<string, string>) });
      return new Response(FIXTURE, { status: 200 });
    };
    await syncOpenRouterCatalog({ db, fetchImpl: spyFetch, now: NOW, apiKey: "sk-or-v1-abc" });
    await syncOpenRouterCatalog({ db, fetchImpl: spyFetch, now: NOW });
    expect(seen[0]?.Authorization).toBe("Bearer sk-or-v1-abc");
    expect(seen[1]?.Authorization).toBeUndefined();
  });

  it("upserts changed pricing on re-sync", async () => {
    await syncOpenRouterCatalog({ db, fetchImpl: okFetch(), now: NOW });
    const parsed = JSON.parse(FIXTURE) as {
      data: Array<{ id: string; pricing: { prompt: string } }>;
    };
    const target = parsed.data.find((m) => m.id === "openai/gpt-4o-mini");
    if (target) target.pricing.prompt = "0.000001";
    await syncOpenRouterCatalog({ db, fetchImpl: okFetch(JSON.stringify(parsed)), now: NOW + 60 });
    const row = getOpenRouterModel("openai/gpt-4o-mini", db);
    expect(row?.promptCostPerToken).toBe(0.000001);
    expect(listOpenRouterModels({ db, now: NOW, includeUnavailable: true })).toHaveLength(5);
  });

  it("soft-deletes models missing from the response and revives returning ones", async () => {
    await syncOpenRouterCatalog({ db, fetchImpl: okFetch(), now: NOW });
    await syncOpenRouterCatalog({
      db,
      fetchImpl: okFetch(fixtureWithout("openai/gpt-4o-mini")),
      now: NOW + 60,
    });
    expect(getOpenRouterModel("openai/gpt-4o-mini", db)?.removedAt).toBe(NOW + 60);

    await syncOpenRouterCatalog({ db, fetchImpl: okFetch(), now: NOW + 120 });
    expect(getOpenRouterModel("openai/gpt-4o-mini", db)?.removedAt).toBeNull();
  });

  it("keeps the stale catalog and records the error on HTTP failure", async () => {
    await syncOpenRouterCatalog({ db, fetchImpl: okFetch(), now: NOW });
    const result = await syncOpenRouterCatalog({
      db,
      fetchImpl: okFetch("oops", 500),
      now: NOW + 60,
    });
    expect(result.ok).toBe(false);
    expect(listOpenRouterModels({ db, now: NOW, includeUnavailable: true })).toHaveLength(5);
    const meta = getCatalogMeta(db);
    expect(meta.lastError).toContain("500");
    expect(meta.consecutiveFailures).toBe(1);
    expect(meta.lastSuccessAt).toBe(NOW);
  });

  it("keeps the stale catalog when fetch rejects", async () => {
    await syncOpenRouterCatalog({ db, fetchImpl: okFetch(), now: NOW });
    const failing: typeof fetch = async () => {
      throw new Error("network down");
    };
    const result = await syncOpenRouterCatalog({ db, fetchImpl: failing, now: NOW + 60 });
    expect(result.ok).toBe(false);
    expect(listOpenRouterModels({ db, now: NOW, includeUnavailable: true })).toHaveLength(5);
    expect(getCatalogMeta(db).lastError).toContain("network down");
  });

  it("counts consecutive failures and resets them on success", async () => {
    const failing = okFetch("oops", 503);
    await syncOpenRouterCatalog({ db, fetchImpl: failing, now: NOW });
    await syncOpenRouterCatalog({ db, fetchImpl: failing, now: NOW + 60 });
    expect(getCatalogMeta(db).consecutiveFailures).toBe(2);
    await syncOpenRouterCatalog({ db, fetchImpl: okFetch(), now: NOW + 120 });
    expect(getCatalogMeta(db).consecutiveFailures).toBe(0);
  });
});

describe("listOpenRouterModels", () => {
  beforeEach(async () => {
    await syncOpenRouterCatalog({ db, fetchImpl: okFetch(), now: NOW });
  });

  it("hides expired and removed models by default", async () => {
    await syncOpenRouterCatalog({
      db,
      fetchImpl: okFetch(fixtureWithout("openai/gpt-4o-mini")),
      now: NOW + 60,
    });
    const ids = listOpenRouterModels({ db, now: NOW + 60 }).map((m) => m.id);
    expect(ids).not.toContain("legacy/sunset-model");
    expect(ids).not.toContain("openai/gpt-4o-mini");
    expect(ids).toContain("anthropic/claude-fable-5");
  });

  it("filters to free models", () => {
    const ids = listOpenRouterModels({ db, now: NOW, freeOnly: true }).map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "meta-llama/llama-3.3-70b-instruct:free",
        "google/gemma-2-9b-it:free",
      ]),
    );
    expect(ids).not.toContain("anthropic/claude-fable-5");
  });

  it("filters to tool-capable models", () => {
    const ids = listOpenRouterModels({ db, now: NOW, requireTools: true }).map((m) => m.id);
    expect(ids).toContain("meta-llama/llama-3.3-70b-instruct:free");
    expect(ids).not.toContain("google/gemma-2-9b-it:free");
  });

  it("includes everything with includeUnavailable", () => {
    const ids = listOpenRouterModels({ db, now: NOW, includeUnavailable: true }).map((m) => m.id);
    expect(ids).toContain("legacy/sunset-model");
  });
});

describe("shouldSyncCatalog", () => {
  it("wants a sync when the catalog is empty", () => {
    expect(shouldSyncCatalog({ db, refreshHours: 6, now: NOW })).toBe(true);
  });

  it("does not re-sync inside the refresh window", async () => {
    await syncOpenRouterCatalog({ db, fetchImpl: okFetch(), now: NOW });
    expect(shouldSyncCatalog({ db, refreshHours: 6, now: NOW + 3600 })).toBe(false);
  });

  it("re-syncs once the refresh interval elapsed", async () => {
    await syncOpenRouterCatalog({ db, fetchImpl: okFetch(), now: NOW });
    expect(shouldSyncCatalog({ db, refreshHours: 6, now: NOW + 6 * 3600 + 1 })).toBe(true);
  });

  it("backs off after a failure instead of hammering the API", async () => {
    await syncOpenRouterCatalog({ db, fetchImpl: okFetch(), now: NOW });
    await syncOpenRouterCatalog({ db, fetchImpl: okFetch("oops", 500), now: NOW + 6 * 3600 });
    // Right after the failure the backoff window is active …
    expect(shouldSyncCatalog({ db, refreshHours: 6, now: NOW + 6 * 3600 + 60 })).toBe(false);
    // … but a later tick retries well before the next full refresh interval.
    expect(shouldSyncCatalog({ db, refreshHours: 6, now: NOW + 7 * 3600 })).toBe(true);
  });
});

describe("isCatalogStale", () => {
  it("is fresh right after a successful sync", async () => {
    await syncOpenRouterCatalog({ db, fetchImpl: okFetch(), now: NOW });
    expect(isCatalogStale({ db, refreshHours: 6, now: NOW + 3600 })).toBe(false);
  });

  it("turns stale when the last success is older than twice the interval", async () => {
    await syncOpenRouterCatalog({ db, fetchImpl: okFetch(), now: NOW });
    expect(isCatalogStale({ db, refreshHours: 6, now: NOW + 13 * 3600 })).toBe(true);
  });

  it("treats a never-synced catalog as stale", () => {
    expect(isCatalogStale({ db, refreshHours: 6, now: NOW })).toBe(true);
  });
});
