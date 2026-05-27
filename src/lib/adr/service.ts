import { and, desc, eq } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import { type Adr, adrs } from "@/lib/db/schema";

export const ADR_STATUSES = ["pending_review", "approved", "rejected"] as const;
export type AdrStatus = (typeof ADR_STATUSES)[number];

/** First markdown H1 (or `# ADR ...`) becomes the title; fall back to the filename. */
export function parseAdrTitle(content: string, filePath: string): string {
  for (const line of content.split("\n")) {
    const m = line.match(/^#\s+(.*\S)\s*$/);
    if (m?.[1]) return m[1];
  }
  return filePath.split("/").pop() ?? filePath;
}

/**
 * Register a discovered ADR file. Idempotent per file_path: re-seeing a file
 * does not create a duplicate row (the watcher may fire add + change).
 */
export function registerAdr(
  input: { jobId?: number; repoId?: number; filePath: string; content: string },
  db: DB = getDb(),
): Adr {
  const existing = db.select().from(adrs).where(eq(adrs.filePath, input.filePath)).get();
  if (existing) return existing;
  return db
    .insert(adrs)
    .values({
      jobId: input.jobId ?? null,
      repoId: input.repoId ?? null,
      filePath: input.filePath,
      title: parseAdrTitle(input.content, input.filePath),
      status: "pending_review",
    })
    .returning()
    .get();
}

export function listAdrs(status: AdrStatus | undefined, db: DB = getDb(), repoId?: number): Adr[] {
  const conditions = [];
  if (status) conditions.push(eq(adrs.status, status));
  if (repoId !== undefined) conditions.push(eq(adrs.repoId, repoId));
  const rows = conditions.length
    ? db
        .select()
        .from(adrs)
        .where(and(...conditions))
        .all()
    : db.select().from(adrs).all();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export function pendingCount(db: DB = getDb()): number {
  return db.select().from(adrs).where(eq(adrs.status, "pending_review")).all().length;
}

export function setAdrStatus(id: number, status: AdrStatus, db: DB = getDb()): Adr {
  const updated = db.update(adrs).set({ status }).where(eq(adrs.id, id)).returning().get();
  if (!updated) throw new Error(`adr ${id} not found`);
  return updated;
}

export function recentApproved(limit: number, db: DB = getDb()): Adr[] {
  return db
    .select()
    .from(adrs)
    .where(and(eq(adrs.status, "approved")))
    .orderBy(desc(adrs.createdAt))
    .limit(limit)
    .all();
}
