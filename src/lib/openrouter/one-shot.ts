import { type DB, getDb } from "@/lib/db/client";
import { oneShotCosts } from "@/lib/db/schema";
import type { OneShotResult, OneShotType } from "@/lib/orchestrator/one-shot-runner";
import { getSettings, type Settings } from "@/lib/settings/service";
import { catalogCostEstimate, getOpenRouterModel, isModelAvailable } from "./catalog";
import { chatCompletion, OpenRouterHttpError } from "./client";
import { resolveOpenRouterApiKey } from "./config";

/**
 * One-shot text prompt over the OpenRouter API (issue #169): the HTTP
 * counterpart of the CLI stream one-shot used by decomposition, verification,
 * PR audits and plan stages. Mirrors {@link OneShotResult} so call sites stay
 * provider-agnostic; failures land in `stderr` in the classifiable
 * `OpenRouter HTTP <status>: …` shape.
 */

function failure(stderr: string): OneShotResult {
  return { text: "", exitCode: 1, costUsd: 0, stderr };
}

export async function runOpenRouterOneShot(opts: {
  /** Empty string falls back to settings.openrouterDefaultModel. */
  model: string;
  prompt: string;
  /** When omitted, cost is tracked in memory only (no DB row). */
  repoId?: number;
  type: OneShotType;
  timeoutMs?: number;
  db?: DB;
  fetchImpl?: typeof fetch;
}): Promise<OneShotResult> {
  const db = opts.db ?? getDb();
  const settings: Settings = getSettings(db);

  if (!settings.openrouterEnabled) {
    return failure("OpenRouter backend is disabled — enable it in Settings before use");
  }
  const apiKey = resolveOpenRouterApiKey(settings);
  if (!apiKey) {
    return failure(
      "no OpenRouter API key configured — set it in Settings or via DRYDOCK_OPENROUTER_API_KEY",
    );
  }
  const model = opts.model || settings.openrouterDefaultModel;
  if (!model) {
    return failure(
      "no OpenRouter model selected and settings.openrouterDefaultModel is empty — pick a model in Settings",
    );
  }
  const row = getOpenRouterModel(model, db);
  if (!row || !isModelAvailable(row)) {
    return failure(
      `OpenRouter model "${model}" is not in the synced catalog (or no longer available) — refresh the catalog in Settings or pick a different model`,
    );
  }
  if (settings.openrouterFreeModelsOnly && !row.isFree) {
    return failure(
      `OpenRouter model "${model}" is not free and the free-models-only policy is enabled`,
    );
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    timer.unref?.();
  }
  try {
    const completion = await chatCompletion({
      apiKey,
      model,
      messages: [{ role: "user", content: opts.prompt }],
      siteUrl: settings.openrouterSiteUrl || undefined,
      appName: settings.openrouterAppName || undefined,
      fetchImpl: opts.fetchImpl,
      signal: controller.signal,
    });
    const costUsd =
      completion.usage.costUsd > 0
        ? completion.usage.costUsd
        : catalogCostEstimate(
            model,
            completion.usage.promptTokens,
            completion.usage.completionTokens,
            db,
          );
    if (costUsd > 0 && opts.repoId !== undefined) {
      db.insert(oneShotCosts)
        .values({
          repoId: opts.repoId,
          type: opts.type,
          costUsd,
          inputTokens: completion.usage.promptTokens,
          outputTokens: completion.usage.completionTokens,
        })
        .run();
    }
    return { text: completion.text, exitCode: 0, costUsd, stderr: "" };
  } catch (err) {
    if (err instanceof OpenRouterHttpError) return failure(err.message);
    if (controller.signal.aborted) {
      return failure(`OpenRouter one-shot timed out after ${opts.timeoutMs}ms`);
    }
    return failure(err instanceof Error ? err.message : String(err));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
