"use server";

import { revalidatePath } from "next/cache";
import { emitDashboardChange } from "@/lib/stream/dashboard-bus";
import {
  type ConfigBundle,
  type ConfigBundlePreview,
  exportConfigBundle,
  type ImportConfigResult,
  importConfigBundle,
  previewConfigBundle,
} from "./config-bundle";

/** Parse pasted/uploaded bundle text, turning a JSON syntax error into a clear message. */
function parseBundleText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Build the current instance's config bundle (secrets redacted) for copy-to-clipboard. */
export async function exportConfigAction(): Promise<ConfigBundle> {
  return exportConfigBundle();
}

/** Validate pasted config-bundle text and return a non-destructive preview of the changes. */
export async function previewConfigImportAction(text: string): Promise<ConfigBundlePreview> {
  return previewConfigBundle(parseBundleText(text));
}

/** Apply a pasted config bundle (global settings + matched repo profiles) and refresh views. */
export async function importConfigAction(text: string): Promise<ImportConfigResult> {
  const result = importConfigBundle(parseBundleText(text));
  revalidatePath("/");
  revalidatePath("/settings");
  revalidatePath("/prompts");
  emitDashboardChange();
  return result;
}
