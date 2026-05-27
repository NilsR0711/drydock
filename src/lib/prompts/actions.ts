"use server";

import { revalidatePath } from "next/cache";
import {
  type TemplateInput,
  getActiveTemplate,
  listVersions,
  resolveTemplateContent,
  saveTemplate,
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
    })),
    hasRow: Boolean(getActiveTemplate(repoId, name)),
  };
}
