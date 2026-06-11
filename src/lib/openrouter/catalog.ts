import { eq } from "drizzle-orm";
import { z } from "zod";
import { type DB, getDb } from "@/lib/db/client";
import { type OpenRouterModel, openrouterModels, settings } from "@/lib/db/schema";

/**
 * Local mirror of the OpenRouter model catalog (issue #169). The catalog is
 * fetched from the public Models API, persisted to SQLite, and refreshed on an
 * interval so new/renamed/deprecated OpenRouter models show up without a
 * Drydock release. Sync failures keep the last-good snapshot (offline-safe).
 */

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Sync metadata, stored in the settings KV table under its own key. */
export interface CatalogMeta {
  /** Epoch seconds of the last sync attempt (success or failure). */
  lastSyncAt: number | null;
  /** Epoch seconds of the last successful sync. */
  lastSuccessAt: number | null;
  lastError: string | null;
  modelCount: number;
  /** Failed attempts since the last success; drives retry backoff. */
  consecutiveFailures: number;
}

const META_KEY = "openrouter_catalog_meta";

const metaSchema = z.object({
  lastSyncAt: z.number().nullable().default(null),
  lastSuccessAt: z.number().nullable().default(null),
  lastError: z.string().nullable().default(null),
  modelCount: z.number().int().nonnegative().default(0),
  consecutiveFailures: z.number().int().nonnegative().default(0),
});

const EMPTY_META: CatalogMeta = {
  lastSyncAt: null,
  lastSuccessAt: null,
  lastError: null,
  modelCount: 0,
  consecutiveFailures: 0,
};

/** A single catalog entry parsed from the Models API response. */
export interface OpenRouterModelRecord {
  id: string;
  name: string;
  description: string;
  contextLength: number;
  /** USD per token, exactly as the API reports it. */
  promptCostPerToken: number;
  completionCostPerToken: number;
  supportedParameters: string[];
  /** Epoch seconds, or null when the model has no announced sunset. */
  expirationDate: number | null;
  isFree: boolean;
  supportsTools: boolean;
}

/** Lenient per-entry schema: unknown fields ignored, only `id` is required. */
const apiModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().nullish(),
  context_length: z.number().nullish(),
  pricing: z
    .object({
      prompt: z.union([z.string(), z.number()]).optional(),
      completion: z.union([z.string(), z.number()]).optional(),
    })
    .passthrough()
    .nullish(),
  supported_parameters: z.array(z.string()).nullish(),
  expiration_date: z.union([z.string(), z.number()]).nullish(),
});

const apiResponseSchema = z.object({
  data: z.array(z.unknown()),
});

function toPerTokenUsd(value: string | number | undefined): number {
  if (value === undefined) return 0;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function toEpochSeconds(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.floor(value) : null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/**
 * Parse a Models API payload into catalog records. Individual malformed
 * entries are skipped (a single bad model must not break the whole sync);
 * a payload without a `data` array throws.
 */
export function parseOpenRouterCatalog(payload: unknown): OpenRouterModelRecord[] {
  const { data } = apiResponseSchema.parse(payload);
  const records: OpenRouterModelRecord[] = [];
  for (const entry of data) {
    const parsed = apiModelSchema.safeParse(entry);
    if (!parsed.success) continue;
    const m = parsed.data;
    const promptCostPerToken = toPerTokenUsd(m.pricing?.prompt);
    const completionCostPerToken = toPerTokenUsd(m.pricing?.completion);
    const supportedParameters = m.supported_parameters ?? [];
    records.push({
      id: m.id,
      name: m.name ?? m.id,
      description: m.description ?? "",
      contextLength: m.context_length ?? 0,
      promptCostPerToken,
      completionCostPerToken,
      supportedParameters,
      expirationDate: toEpochSeconds(m.expiration_date),
      isFree: m.id.endsWith(":free") || (promptCostPerToken === 0 && completionCostPerToken === 0),
      supportsTools: supportedParameters.includes("tools"),
    });
  }
  return records;
}

export function getCatalogMeta(db: DB = getDb()): CatalogMeta {
  const row = db.select().from(settings).where(eq(settings.key, META_KEY)).get();
  if (!row) return { ...EMPTY_META };
  try {
    return metaSchema.parse(JSON.parse(row.value));
  } catch {
    return { ...EMPTY_META };
  }
}

function saveMeta(meta: CatalogMeta, db: DB): void {
  const value = JSON.stringify(meta);
  const existing = db.select().from(settings).where(eq(settings.key, META_KEY)).get();
  if (existing) {
    db.update(settings).set({ value }).where(eq(settings.key, META_KEY)).run();
  } else {
    db.insert(settings).values({ key: META_KEY, value }).run();
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);

export type SyncResult = { ok: true; modelCount: number } | { ok: false; error: string };

/**
 * Fetch the Models API and mirror it into SQLite: upsert every listed model,
 * soft-delete rows that vanished, revive rows that returned. On any failure
 * the last-good snapshot stays untouched and the error lands in the meta
 * record so the UI can surface a stale-catalog warning.
 */
export async function syncOpenRouterCatalog(opts: {
  db?: DB;
  fetchImpl?: typeof fetch;
  now?: number;
  /** Optional: authenticated listing (account-specific model visibility). */
  apiKey?: string;
}): Promise<SyncResult> {
  const db = opts.db ?? getDb();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? nowSec();
  const meta = getCatalogMeta(db);
  meta.lastSyncAt = now;

  let records: OpenRouterModelRecord[];
  try {
    const headers: Record<string, string> = {};
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    const res = await fetchImpl(OPENROUTER_MODELS_URL, { headers });
    if (!res.ok) throw new Error(`OpenRouter models API returned HTTP ${res.status}`);
    records = parseOpenRouterCatalog(await res.json());
  } catch (err) {
    meta.lastError = err instanceof Error ? err.message : String(err);
    meta.consecutiveFailures += 1;
    saveMeta(meta, db);
    return { ok: false, error: meta.lastError };
  }

  const listedIds = new Set(records.map((r) => r.id));
  db.transaction((tx) => {
    for (const r of records) {
      const values = {
        id: r.id,
        name: r.name,
        description: r.description,
        contextLength: r.contextLength,
        promptCostPerToken: r.promptCostPerToken,
        completionCostPerToken: r.completionCostPerToken,
        supportedParameters: JSON.stringify(r.supportedParameters),
        expirationDate: r.expirationDate,
        isFree: r.isFree,
        supportsTools: r.supportsTools,
        removedAt: null,
        syncedAt: now,
      };
      tx.insert(openrouterModels)
        .values(values)
        .onConflictDoUpdate({ target: openrouterModels.id, set: values })
        .run();
    }
    // Soft-delete models the API no longer lists (preserve historical labels).
    const existing = tx.select({ id: openrouterModels.id }).from(openrouterModels).all();
    for (const row of existing) {
      if (!listedIds.has(row.id)) {
        tx.update(openrouterModels)
          .set({ removedAt: now })
          .where(eq(openrouterModels.id, row.id))
          .run();
      }
    }
  });

  meta.lastSuccessAt = now;
  meta.lastError = null;
  meta.modelCount = records.length;
  meta.consecutiveFailures = 0;
  saveMeta(meta, db);
  return { ok: true, modelCount: records.length };
}

/** Whether a catalog row is selectable: still listed and not past its sunset. */
export function isModelAvailable(row: OpenRouterModel, now: number = nowSec()): boolean {
  if (row.removedAt !== null) return false;
  if (row.expirationDate !== null && row.expirationDate <= now) return false;
  return true;
}

export function listOpenRouterModels(opts: {
  db?: DB;
  now?: number;
  freeOnly?: boolean;
  requireTools?: boolean;
  /** Include removed and expired models (history views). */
  includeUnavailable?: boolean;
}): OpenRouterModel[] {
  const db = opts.db ?? getDb();
  const now = opts.now ?? nowSec();
  let rows = db.select().from(openrouterModels).all();
  if (!opts.includeUnavailable) rows = rows.filter((r) => isModelAvailable(r, now));
  if (opts.freeOnly) rows = rows.filter((r) => r.isFree);
  if (opts.requireTools) rows = rows.filter((r) => r.supportsTools);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export function getOpenRouterModel(id: string, db: DB = getDb()): OpenRouterModel | undefined {
  return db.select().from(openrouterModels).where(eq(openrouterModels.id, id)).get();
}

/**
 * Estimate the USD cost of a generation from catalog pricing (per-token USD
 * rates). Fallback only: OpenRouter's stream usage accounting reports the
 * exact cost and always wins when present. Unknown models estimate at 0 —
 * execution paths reject models missing from the catalog before any request.
 */
export function catalogCostEstimate(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  db: DB = getDb(),
): number {
  const row = getOpenRouterModel(modelId, db);
  if (!row) return 0;
  return promptTokens * row.promptCostPerToken + completionTokens * row.completionCostPerToken;
}

/** Failure backoff: 5 min doubling per consecutive failure, capped at 1 h. */
const BACKOFF_BASE_SEC = 5 * 60;
const BACKOFF_CAP_SEC = 3600;

/**
 * Whether the driver tick should kick off a catalog sync now: the catalog is
 * empty, or the refresh interval elapsed. After failures an exponential
 * backoff window (instead of the full interval) gates the retry.
 */
export function shouldSyncCatalog(opts: { db?: DB; refreshHours: number; now?: number }): boolean {
  const db = opts.db ?? getDb();
  const now = opts.now ?? nowSec();
  const meta = getCatalogMeta(db);
  if (meta.lastSyncAt === null) return true;
  if (meta.modelCount === 0 && meta.consecutiveFailures === 0) return true;
  const interval =
    meta.consecutiveFailures > 0
      ? Math.min(BACKOFF_BASE_SEC * 2 ** (meta.consecutiveFailures - 1), BACKOFF_CAP_SEC)
      : Math.floor(opts.refreshHours * 3600);
  return now - meta.lastSyncAt >= interval;
}

/**
 * A catalog is stale when it has never synced successfully or the last
 * success is older than twice the refresh interval — the UI surfaces this
 * as a warning while pickers keep working from the last-good snapshot.
 */
export function isCatalogStale(opts: { db?: DB; refreshHours: number; now?: number }): boolean {
  const db = opts.db ?? getDb();
  const now = opts.now ?? nowSec();
  const meta = getCatalogMeta(db);
  if (meta.lastSuccessAt === null) return true;
  return now - meta.lastSuccessAt > 2 * opts.refreshHours * 3600;
}
