"use server";

import { revalidatePath } from "next/cache";
import {
  deleteTemplate,
  getActiveTemplate,
  getVersion,
  listVersions,
  resolveTemplateContent,
  saveTemplate,
  type TemplateInput,
} from "./templates";

export async function saveTemplateAction(input: TemplateInput) {
  const row = saveTemplate(input);
  revalidatePath("/prompts");
  return row;
}

/**
 * Remove a repo's override for a stage, reverting it to the global default.
 * Returns the now-effective (default) content so the caller can render it.
 */
export async function deleteTemplateAction(repoId: number, name: string) {
  deleteTemplate(repoId, name);
  revalidatePath("/prompts");
  return { content: resolveTemplateContent(repoId, name) };
}

/** Load a repo+name template's effective content (with default fallback) and versions. */
export async function loadTemplateAction(repoId: number, name: string) {
  return {
    content: resolveTemplateContent(repoId, name),
    versions: listVersions(repoId, name).map((v) => ({
      version: v.version,
      updatedAt: v.updatedAt,
      content: v.content,
    })),
    hasRow: Boolean(getActiveTemplate(repoId, name)),
  };
}

/** Return a single version's full content, or null when not found. */
export async function getVersionAction(
  repoId: number,
  name: string,
  version: number,
): Promise<{ version: number; content: string; updatedAt: number } | null> {
  const row = getVersion(repoId, name, version);
  if (!row) return null;
  return { version: row.version, content: row.content, updatedAt: row.updatedAt };
}
