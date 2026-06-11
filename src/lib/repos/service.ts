import { and, eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import { type DB, getDb } from "@/lib/db/client";
import { jobs, type Repo, repos } from "@/lib/db/schema";
import { isValidForgeBaseUrl } from "@/lib/forge/url-guard";
import { isKnownModelId } from "@/lib/models";
import { TERMINAL_STATES } from "@/lib/orchestrator/state-machine";
import { AGENT_INSTRUCTIONS_MAX_CHARS } from "@/lib/repos/agent-instructions";

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
  defaultModel: z
    .string()
    .min(1)
    .refine(isKnownModelId, { message: "unknown model id" })
    .default("claude-opus-4-8"),
  agent: z.enum(["claude", "codex"]).default("claude"),
  platform: z.enum(["github", "gitlab"]).default("github"),
  // A self-hosted forge API base URL. Validated as an absolute http(s) URL so a
  // bogus/attacker-influenced scheme (file:, javascript:, relative) can never be
  // stored and later fetched server-side with a token attached (issue #110).
  // Empty string is treated as "unset" alongside null/undefined.
  apiBaseUrl: z
    .string()
    .refine((v) => v === "" || isValidForgeBaseUrl(v), {
      message: "apiBaseUrl must be an absolute http(s) URL",
    })
    .nullish(),
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
  planFirst: z.boolean().default(false),
  verifyPr: z.boolean().default(false),
  autoHealDeployments: z.boolean().default(false),
  releaseEnabled: z.boolean().default(false),
  deploymentPlatform: z.enum(["vercel", "railway"]).nullish(),
  readyLabels: jsonStringArray('["ready","ready-for-agent","ready-to-work"]'),
  blockingLabels: jsonStringArray(
    '["blocked","question","needs-human","needs-discussion","wontfix","duplicate","invalid"]',
  ),
  autoLabelWhitelist: jsonStringArray('["bug","enhancement","documentation","ready"]'),
  priorityAuthors: jsonStringArray("[]"),
  trustedReviewers: jsonStringArray("[]"),
  trustedBots: jsonStringArray("[]"),
  ignoredBots: jsonStringArray('["dependabot[bot]","github-actions[bot]","codecov[bot]"]'),
  minAuthorAssociation: z.enum(["approved", "any"]).default("approved"),
  maxAttempts: z.number().int().positive().default(3),
  // Optional per-repo wall-clock session timeout in minutes (issue #47).
  // Null/undefined falls back to the global settings.maxJobMinutes default.
  maxJobMinutes: z.number().int().nonnegative().nullish(),
  // Optional per-repo wall-clock CI wait budget in minutes (issue #52).
  // Null/undefined falls back to the global settings.maxCiWaitMinutes default.
  maxCiWaitMinutes: z.number().int().nonnegative().nullish(),
  // Review settle gate in minutes (issue #159). 0 merges immediately on green
  // CI (today's behavior); a positive value keeps polling that long after the
  // first all-green poll so late bot/human reviews can land before the merge.
  mergeGateMinutes: z.number().int().nonnegative().default(0),
  // Optional per-repo per-job USD cost ceiling (issue #57). Null/undefined falls
  // back to the global settings.maxJobCostUsd default.
  maxJobCostUsd: z.number().nonnegative().nullish(),
  agentInstructions: z.string().max(AGENT_INSTRUCTIONS_MAX_CHARS).nullish(),
  // Per-repo inbound webhook secret (issue #61). Non-empty enables webhook-driven
  // sync; null/empty disables it and leaves polling as the sole sync path.
  webhookSecret: z.string().nullish(),
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

/**
 * Remove a repo. Refused while any of its jobs is still live (non-terminal):
 * the jobs cascade-delete with the repo row, which would yank the job and its
 * cost ledger out from under a running agent session — the orphaned agent
 * keeps spending and pushes a branch/PR with no local record left. Abort or
 * finish the repo's jobs first, then remove it.
 */
export function removeRepo(id: number, db: DB = getDb()): void {
  const live = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.repoId, id), notInArray(jobs.status, [...TERMINAL_STATES])))
    .all();
  if (live.length > 0) {
    throw new Error(
      `Cannot remove this repository: ${live.length} job(s) are still active. ` +
        "Abort or finish them first.",
    );
  }
  db.delete(repos).where(eq(repos.id, id)).run();
}
