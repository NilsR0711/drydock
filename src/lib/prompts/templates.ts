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

/** Active repo template content, or the code-level default for that name. */
export function resolveTemplateContent(repoId: number, name: string, db: DB = getDb()): string {
  return (
    getActiveTemplate(repoId, name, db)?.content ?? DEFAULT_TEMPLATES[name as TemplateName] ?? ""
  );
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
