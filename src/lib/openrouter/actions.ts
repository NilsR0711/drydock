"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db/client";
import { getSettings } from "@/lib/settings/service";
import { type SyncResult, syncOpenRouterCatalog } from "./catalog";
import { checkOpenRouterKey } from "./client";
import { resolveOpenRouterApiKey } from "./config";

/**
 * Settings-page actions for the OpenRouter backend (issue #169). Both take an
 * optional fetch override purely for tests; Next.js server actions receive
 * only serializable arguments from the client, so callers in the UI invoke
 * them without arguments.
 */

/** Force a catalog sync now (the "Refresh models" button). */
export async function refreshOpenRouterCatalogAction(
  fetchImpl?: typeof fetch,
): Promise<SyncResult> {
  const db = getDb();
  const settings = getSettings(db);
  const result = await syncOpenRouterCatalog({
    db,
    fetchImpl,
    apiKey: resolveOpenRouterApiKey(settings) || undefined,
  });
  revalidatePath("/settings");
  return result;
}

/** Probe the configured API key (the "Test connection" button). */
export async function testOpenRouterConnectionAction(
  fetchImpl?: typeof fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const settings = getSettings(getDb());
  const apiKey = resolveOpenRouterApiKey(settings);
  if (!apiKey) {
    return {
      ok: false,
      error:
        "no OpenRouter API key configured — save one first (or set DRYDOCK_OPENROUTER_API_KEY)",
    };
  }
  return checkOpenRouterKey(apiKey, fetchImpl);
}
