import { type DB, getDb } from "@/lib/db/client";
import { type Repo, repos } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";

export const repoInputSchema = z.object({
  path: z.string().min(1, "path is required"),
  name: z.string().min(1, "name is required"),
  defaultBranch: z.string().min(1).default("main"),
  queueLabel: z.string().min(1).default("autoclaude:queue"),
  workingLabel: z.string().min(1).default("autoclaude:working"),
  needsHumanLabel: z.string().min(1).default("autoclaude:needs-human"),
  defaultModel: z.string().min(1).default("claude-opus-4-7"),
});
export type RepoInput = z.input<typeof repoInputSchema>;

export function addRepo(input: RepoInput, db: DB = getDb()): Repo {
  const data = repoInputSchema.parse(input);
  const inserted = db.insert(repos).values(data).returning().get();
  return inserted;
}

export function updateRepo(id: number, input: Partial<RepoInput>, db: DB = getDb()): Repo {
  const data = repoInputSchema.partial().parse(input);
  const updated = db.update(repos).set(data).where(eq(repos.id, id)).returning().get();
  if (!updated) throw new Error(`repo ${id} not found`);
  return updated;
}

export function removeRepo(id: number, db: DB = getDb()): void {
  db.delete(repos).where(eq(repos.id, id)).run();
}
