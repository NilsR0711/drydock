import { eq } from "drizzle-orm";
import { z } from "zod";
import { type DB, getDb } from "@/lib/db/client";
import { type Repo, repos } from "@/lib/db/schema";

/**
 * A label/author list column: callers pass a `string[]`, but we persist it as a
 * JSON text column (parsed back via repoAutomation). `defaultJson` seeds new
 * repos; on partial updates an omitted field is left untouched.
 */
function jsonStringArray(defaultJson: string) {
  return z
    .array(z.string())
    .default(() => JSON.parse(defaultJson) as string[])
    .transform((a) => JSON.stringify(a));
}

export const repoInputSchema = z.object({
  path: z.string().min(1, "path is required"),
  name: z.string().min(1, "name is required"),
  defaultBranch: z.string().min(1).default("main"),
  queueLabel: z.string().min(1).default("drydock:queue"),
  workingLabel: z.string().min(1).default("drydock:working"),
  needsHumanLabel: z.string().min(1).default("drydock:needs-human"),
  defaultModel: z.string().min(1).default("claude-opus-4-7"),
  agent: z.enum(["claude", "codex"]).default("claude"),
  platform: z.enum(["github", "gitlab"]).default("github"),
  apiBaseUrl: z.string().nullish(),
  apiToken: z.string().nullish(),
  dailyCostLimitUsd: z.number().nonnegative().default(10),
  adrGating: z.boolean().default(false),
  sequential: z.boolean().default(true),
  autoTriageEnabled: z.boolean().default(false),
  autoProcessEnabled: z.boolean().default(false),
  autoHealCi: z.boolean().default(false),
  autoReviewFeedback: z.boolean().default(false),
  autoResolveMergeConflicts: z.boolean().default(false),
  includeProgressReplies: z.boolean().default(false),
  autoDecompose: z.boolean().default(false),
  autoHealDeployments: z.boolean().default(false),
  deploymentPlatform: z.enum(["vercel", "railway"]).nullish(),
  readyLabels: jsonStringArray('["ready","ready-for-agent","ready-to-work"]'),
  blockingLabels: jsonStringArray(
    '["blocked","question","needs-human","needs-discussion","wontfix","duplicate","invalid"]',
  ),
  autoLabelWhitelist: jsonStringArray('["bug","enhancement","documentation","ready"]'),
  priorityAuthors: jsonStringArray("[]"),
  trustedReviewers: jsonStringArray("[]"),
  ignoredBots: jsonStringArray('["dependabot[bot]","github-actions[bot]","codecov[bot]"]'),
  minAuthorAssociation: z.enum(["approved", "any"]).default("approved"),
  maxAttempts: z.number().int().positive().default(3),
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
