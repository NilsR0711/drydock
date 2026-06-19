import { and, eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import { type DB, getDb } from "@/lib/db/client";
import { jobs, type Repo, repos } from "@/lib/db/schema";
import { isValidForgeBaseUrl } from "@/lib/forge/url-guard";
import { isKnownModelId } from "@/lib/models";
import { getOpenRouterModel, isModelAvailable } from "@/lib/openrouter/catalog";
import { TERMINAL_STATES } from "@/lib/orchestrator/state-machine";
import { AGENT_INSTRUCTIONS_MAX_CHARS } from "@/lib/repos/agent-instructions";
import { getSettings } from "@/lib/settings/service";

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
  // Model ids are validated against the agent after parsing (see
  // assertModelAllowedForAgent): CLI agents check the static MODELS list,
  // openrouter checks the synced catalog (issue #169).
  defaultModel: z.string().min(1).default("claude-opus-4-8"),
  agent: z.enum(["claude", "codex", "openrouter"]).default("claude"),
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
  // 0 = off / unlimited daily budget for this repo (issue #234). Defaults to 0
  // so a freshly added repo is fully autonomous out of the box (issue #254).
  dailyCostLimitUsd: z.number().nonnegative().default(0),
  adrGating: z.boolean().default(false),
  sequential: z.boolean().default(true),
  // Backlog-driving automation is opt-in (issue #285): a freshly added repo
  // does nothing to its whole backlog until the user turns these on per repo.
  // Default-on here meant registering a repo could silently auto-triage and
  // mass-enqueue every `ready` issue in one tick (cost + dozens of PRs). The
  // in-flight pipeline (CI heal, review feedback, verify) stays on below — it
  // only acts on work the user already started. Kept in sync with the schema
  // column defaults.
  autoTriageEnabled: z.boolean().default(false),
  autoProcessEnabled: z.boolean().default(false),
  autoHealCi: z.boolean().default(true),
  // Defaults ON for autonomous operation (issue #213); opt-out per repo. Paired
  // with the trustedBots defaults below, since the loop is inert without them.
  autoReviewFeedback: z.boolean().default(true),
  autoResolveMergeConflicts: z.boolean().default(true),
  includeProgressReplies: z.boolean().default(false),
  // Opt-in (issue #285): decomposition fires slow `claude -p` one-shots across
  // the backlog and can stall the driver loop, so it must be a deliberate choice.
  autoDecompose: z.boolean().default(false),
  planFirst: z.boolean().default(false),
  verifyPr: z.boolean().default(true),
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
  // Sensible defaults so review-feedback acts on well-known bots out of the
  // box (issue #213); kept in sync with the schema column default.
  trustedBots: jsonStringArray('["cursor[bot]","coderabbitai[bot]"]'),
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
  // Opt-in auto-merge for PRs with no CI checks at all (issue #207). Off by
  // default: absent automated CI means absent verification, so a repo must opt
  // in explicitly. See the schema column for the full rationale.
  mergeWithoutChecks: z.boolean().default(false),
  // Optional per-repo per-job USD cost ceiling (issue #57). Null/undefined falls
  // back to the global settings.maxJobCostUsd default.
  maxJobCostUsd: z.number().nonnegative().nullish(),
  agentInstructions: z.string().max(AGENT_INSTRUCTIONS_MAX_CHARS).nullish(),
  // Per-repo inbound webhook secret (issue #61). Non-empty enables webhook-driven
  // sync; null/empty disables it and leaves polling as the sole sync path.
  webhookSecret: z.string().nullish(),
  // AI PR audit (issue #168), defaulted ON for autonomous review (issue #254).
  // Agent/model null inherits the repo's agent/defaultModel; the output language
  // is a simple or BCP 47 code.
  autoPrAudit: z.boolean().default(true),
  prAuditAgent: z.enum(["claude", "codex"]).nullish(),
  prAuditModel: z.string().min(1).refine(isKnownModelId, { message: "unknown model id" }).nullish(),
  prAuditLanguage: z
    .string()
    .regex(/^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/, {
      message: "prAuditLanguage must be a simple or BCP 47 language code",
    })
    .default("en"),
  prAuditPostOnPr: z.boolean().default(false),
  // Opt-in model escalation ladder on requeue (issue #179).
  escalateModelOnRetry: z.boolean().default(false),
  // Opt-in sandboxed agent execution (issue #182, ADR 033). "docker" runs the
  // repo's agent sessions inside a container; "none" (default) keeps today's
  // host execution. Image/cpu/memory overrides are free text validated by the
  // container runtime at spawn time, not here.
  sandbox: z.enum(["none", "docker"]).default("none"),
  sandboxImage: z.string().nullish(),
  sandboxAllowNetwork: z.boolean().default(false),
  sandboxCpus: z.string().nullish(),
  sandboxMemory: z.string().nullish(),
  // Opt-in claude-mem worktree adoption (issue #274). Off by default: it depends
  // on the external claude-mem plugin being installed. See the schema column.
  adoptClaudeMem: z.boolean().default(false),
  // Quiet mode for the issue thread (issue #289). Off by default: existing repos
  // keep the full audit trail. See the schema column for what it suppresses.
  quietComments: z.boolean().default(false),
  // Opt-in unrestricted shell access (issue #283). Off by default — it runs the
  // agent with `--dangerously-skip-permissions`, granting full shell access. See
  // the schema column for the full rationale and security trade-off.
  bypassPermissions: z.boolean().default(false),
});
export type RepoInput = z.input<typeof repoInputSchema>;

/**
 * Validate the agent/model pair (issue #169): CLI agents must use a model
 * from the static MODELS list (issue #93); openrouter ids must exist in the
 * synced catalog, still be available (not removed/expired), and honor the
 * global free-models-only policy. Runs after Zod parsing because the check is
 * cross-field and (for openrouter) needs the database.
 */
function assertModelAllowedForAgent(agent: string, model: string, db: DB): void {
  if (agent === "openrouter") {
    const row = getOpenRouterModel(model, db);
    if (!row || !isModelAvailable(row)) {
      throw new Error(
        `OpenRouter model "${model}" is not in the synced catalog (or no longer available) — refresh the catalog in Settings or pick a different model`,
      );
    }
    if (getSettings(db).openrouterFreeModelsOnly && !row.isFree) {
      throw new Error(
        `OpenRouter model "${model}" is not free and the free-models-only policy is enabled`,
      );
    }
    return;
  }
  if (!isKnownModelId(model)) throw new Error("unknown model id");
}

export function addRepo(input: RepoInput, db: DB = getDb()): Repo {
  const data = repoInputSchema.parse(input);
  assertModelAllowedForAgent(data.agent, data.defaultModel, db);
  const inserted = db.insert(repos).values(data).returning().get();
  return inserted;
}

export function updateRepo(id: number, input: Partial<RepoInput>, db: DB = getDb()): Repo {
  const parsed = repoInputSchema.partial().parse(input);
  // `.partial()` does not make `.default()`ed fields truly optional: Zod
  // treats a defaulted field as already-optional and fills the default for
  // every omitted key, so writing `parsed` verbatim would reset all defaulted
  // columns on each partial update. Keep only the keys the caller sent —
  // an omitted field must stay untouched (see the jsonStringArray contract).
  const data = Object.fromEntries(
    Object.entries(parsed).filter(
      ([key]) => key in input && input[key as keyof RepoInput] !== undefined,
    ),
  ) as Partial<typeof parsed>;
  // Re-validate the effective agent/model pair whenever either side changes,
  // so switching agents can never leave the repo on a model the new agent
  // cannot run (issue #169).
  let current: Repo | undefined;
  if (data.agent !== undefined || data.defaultModel !== undefined) {
    current = db.select().from(repos).where(eq(repos.id, id)).get();
    if (!current) throw new Error(`repo ${id} not found`);
    assertModelAllowedForAgent(
      data.agent ?? current.agent,
      data.defaultModel ?? current.defaultModel,
      db,
    );
  }
  if (Object.keys(data).length === 0) {
    current ??= db.select().from(repos).where(eq(repos.id, id)).get();
    if (!current) throw new Error(`repo ${id} not found`);
    return current;
  }
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
  // Guard and delete in one transaction: better-sqlite3 transactions are
  // synchronous, so a job enqueued between the check and the delete cannot
  // interleave and be cascade-deleted with the repo.
  db.transaction(() => {
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
  });
}
