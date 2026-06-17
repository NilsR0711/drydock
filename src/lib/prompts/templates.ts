import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { type DB, getDb } from "@/lib/db/client";
import { type PromptTemplate, promptTemplates } from "@/lib/db/schema";
import { DEFAULT_TEMPLATES, type TemplateName } from "./defaults";

export type { TemplateVar, TemplateVars } from "./render";
export { renderTemplate, SUPPORTED_VARIABLES } from "./render";

export const MAX_VERSIONS = 20;

const templateInput = z.object({
  repoId: z.number().int().positive(),
  name: z.string().min(1),
  content: z.string(),
});
export type TemplateInput = z.infer<typeof templateInput>;

/** Active (latest) version of a named template for a repo. */
export function getActiveTemplate(
  repoId: number,
  name: string,
  db: DB = getDb(),
): PromptTemplate | undefined {
  return db
    .select()
    .from(promptTemplates)
    .where(and(eq(promptTemplates.repoId, repoId), eq(promptTemplates.name, name)))
    .orderBy(desc(promptTemplates.version))
    .get();
}

/** A resolved template: its content, and the repo version it came from. */
export interface ResolvedTemplate {
  content: string;
  /** Saved repo version used, or null when the code-level default was resolved. */
  version: number | null;
}

/**
 * Resolve a named template to the content that will run plus the version it
 * came from. A saved repo template wins and carries its version; otherwise the
 * code-level default is used and the version is null. Lets callers record the
 * exact prompt revision a job ran with (issue #178).
 */
export function resolveTemplate(repoId: number, name: string, db: DB = getDb()): ResolvedTemplate {
  const active = getActiveTemplate(repoId, name, db);
  if (active) return { content: active.content, version: active.version };
  return { content: DEFAULT_TEMPLATES[name as TemplateName] ?? "", version: null };
}

/** Active repo template content, or the code-level default for that name. */
export function resolveTemplateContent(repoId: number, name: string, db: DB = getDb()): string {
  return resolveTemplate(repoId, name, db).content;
}

/**
 * Remove every version row for a repo+name, so the runtime resolves the
 * code-level default again. Used when a repo prompt stage is switched back to
 * "Standard" — a local UI toggle alone would not change what the agent runs.
 */
export function deleteTemplate(repoId: number, name: string, db: DB = getDb()): void {
  db.delete(promptTemplates)
    .where(and(eq(promptTemplates.repoId, repoId), eq(promptTemplates.name, name)))
    .run();
}

/** A specific version of a named template for a repo, including its full content. */
export function getVersion(
  repoId: number,
  name: string,
  version: number,
  db: DB = getDb(),
): PromptTemplate | undefined {
  return db
    .select()
    .from(promptTemplates)
    .where(
      and(
        eq(promptTemplates.repoId, repoId),
        eq(promptTemplates.name, name),
        eq(promptTemplates.version, version),
      ),
    )
    .get();
}

export function listVersions(repoId: number, name: string, db: DB = getDb()): PromptTemplate[] {
  return db
    .select()
    .from(promptTemplates)
    .where(and(eq(promptTemplates.repoId, repoId), eq(promptTemplates.name, name)))
    .orderBy(desc(promptTemplates.version))
    .all();
}

/**
 * Save a template version. The first save is version 1; each subsequent save
 * appends a new version row and prunes anything beyond the newest MAX_VERSIONS.
 */
export function saveTemplate(input: TemplateInput, db: DB = getDb()): PromptTemplate {
  const data = templateInput.parse(input);
  const current = getActiveTemplate(data.repoId, data.name, db);
  const nextVersion = (current?.version ?? 0) + 1;
  const row = db
    .insert(promptTemplates)
    .values({
      repoId: data.repoId,
      name: data.name,
      content: data.content,
      version: nextVersion,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .returning()
    .get();

  const versions = listVersions(data.repoId, data.name, db);
  for (const old of versions.slice(MAX_VERSIONS)) {
    db.delete(promptTemplates).where(eq(promptTemplates.id, old.id)).run();
  }
  return row;
}
