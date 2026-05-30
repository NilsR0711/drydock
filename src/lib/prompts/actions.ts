"use server";

import { revalidatePath } from "next/cache";
import {
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
