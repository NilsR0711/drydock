"use server";

import { revalidatePath } from "next/cache";
import { emitDashboardChange } from "@/lib/stream/dashboard-bus";
import {
  type BundlePreview,
  exportRepoSettings,
  type ImportResult,
  importRepoSettings,
  previewBundleChanges,
  type SettingsBundle,
} from "./settings-bundle";

/** Parse pasted/uploaded bundle text, turning a JSON syntax error into a clear message. */
function parseBundleText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Build a downloadable/copyable settings bundle for a repo. */
export async function exportRepoSettingsAction(repoId: number): Promise<SettingsBundle> {
  return exportRepoSettings(repoId);
}

/** Validate pasted bundle text and return a non-destructive preview of the changes. */
export async function previewImportAction(repoId: number, text: string): Promise<BundlePreview> {
  return previewBundleChanges(repoId, parseBundleText(text));
}

/** Apply a pasted bundle to a repo and refresh the affected views. */
export async function importRepoSettingsAction(
  repoId: number,
  text: string,
): Promise<ImportResult> {
  const result = importRepoSettings(repoId, parseBundleText(text));
  revalidatePath("/");
  revalidatePath(`/repos/${repoId}`);
  revalidatePath("/prompts");
  emitDashboardChange();
  return result;
}
