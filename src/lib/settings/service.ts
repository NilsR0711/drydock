import { eq } from "drizzle-orm";
import { z } from "zod";
import { type DB, getDb } from "@/lib/db/client";
import { monthCost, todayCost } from "@/lib/db/cost-queries";
import { repos, settings } from "@/lib/db/schema";
import { setServerLogLevel } from "@/lib/log/server-log";
import { LOG_LEVELS } from "@/lib/log/types";
import { isKnownModelId } from "@/lib/models";
import { NOTIFICATION_EVENTS } from "@/lib/notify/events";
import { getCredentialFailures } from "@/lib/orchestrator/credential-status";

export const settingsSchema = z.object({
  paused: z.boolean().default(false),
  // Operator-set drain mode: stop picking up new work, let in-flight jobs
  // finish. DB-backed (like `paused`) so it works across processes — the MCP
  // server runs as its own process and could never reach the orchestrator's
  // in-memory shutdown flag. The in-process flag in orchestrator/runtime.ts
  // remains for transient graceful-shutdown draining only.
  draining: z.boolean().default(false),
  // Daily USD budget gating new runs (SPEC §6.1). 0 is off (unlimited) — the
  // loop then stops only at the per-job cap, provider usage-limit auto-wait, and
  // pause/drain (issue #234). Defaults to 0 (unlimited) so a fresh install is
  // fully autonomous out of the box (issue #254); set a positive ceiling here or
  // per-repo to cap spend. A per-repo daily limit applies the same 0 = off
  // semantics independently.
  dailyCostLimitUsd: z.number().nonnegative().default(0),
  // Monthly USD budget gating new runs (issue #413), the longer-horizon sibling
  // of the daily limit. 0 is off (unlimited) with identical semantics: the gate
  // compares month-to-date spend (jobs + one-shot costs) and, when it reaches a
  // positive ceiling, stops new work for the rest of the month. Defaults to 0 so
  // a fresh install stays fully autonomous out of the box (issue #254); set a
  // positive ceiling here or per-repo to cap monthly spend. Most billing is
  // monthly, so this lets an operator express "no more than $200/month" directly
  // instead of translating it to a daily number.
  monthlyCostLimitUsd: z.number().nonnegative().default(0),
  pollIntervalSec: z.number().int().positive().default(30),
  // Hard per-tick watchdog deadline for the scheduler loop, in seconds (issue
  // #359). A single hung tick — e.g. a `gh` call stalling on a dead connection
  // with an expired token — used to wedge the whole loop indefinitely: the next
  // tick is scheduled only after the current one resolves, so once a tick never
  // resolved no queued job was ever claimed again until a manual restart. The
  // loop now races each tick against this deadline; on breach it abandons the
  // tick, clears its re-entrancy guard, and schedules the next one, so it
  // self-heals once GitHub is reachable again. Defaults to 120s — well below the
  // observed ~50 min wedge yet above any healthy tick. 0 disables the watchdog.
  // Capped at 2_147_483s (~24.8 days): * 1000 stays under Node's 32-bit setTimeout
  // ceiling (2_147_483_647 ms), above which a timer silently fires after 1ms —
  // which here would abandon *every* tick instantly, the opposite of the intent.
  maxTickSeconds: z.number().int().nonnegative().max(2_147_483).default(120),
  // Per-job turn budget (issue #254). 0 is off (unlimited): the runner drops the
  // CLI `--max-turns` flag and the OpenRouter loop skips its turn check, so a
  // long task is bounded only by maxJobMinutes / the per-job cost cap. Defaults
  // to 0 (unlimited) so a fresh install is fully autonomous out of the box —
  // ordinary issues routinely exceed any fixed turn wall and a max-turns abort
  // would otherwise escalate to needs_human. The value seeds each new job's
  // budget; set a positive ceiling here or per-call to cap turns.
  maxTurns: z.number().int().nonnegative().default(0),
  // Hard wall-clock timeout per agent session in minutes (issue #47). A hung
  // agent (network stall, MCP deadlock, stdin prompt) is aborted after this so
  // it never holds a job slot forever. Defaults to 120 so long autonomous tasks
  // finish (issue #254). A per-repo override may shorten/extend it.
  maxJobMinutes: z.number().int().positive().default(120),
  // Hard wall-clock budget for CI to start and settle after a PR is opened
  // (issue #52). If required checks sit pending/queued past this, the babysitter
  // stops polling and escalates the job to needs_human instead of looping
  // forever. A per-repo override may shorten/extend it.
  maxCiWaitMinutes: z.number().int().positive().default(60),
  // Per-job USD cost ceiling (issue #57). When a single session's accumulated
  // cost crosses this, the agent is aborted mid-stream (SIGTERM → SIGKILL) and
  // the job escalates to needs_human, bounding the blast radius of one runaway
  // session that could otherwise drain the whole daily budget by itself. 0 is
  // off (no ceiling) — the default when unset. A per-repo override may tighten
  // or relax it.
  maxJobCostUsd: z.number().nonnegative().default(0),
  // Auto-wait on Claude usage limits (issue #166, ADR 030). When a Claude
  // session fails because the account's usage/rate limit is exhausted, the job
  // parks in `waiting_limit` and resumes automatically once the window resets,
  // instead of landing in needs_human. Off restores the pre-#166 behavior.
  claudeLimitAutoWait: z.boolean().default(true),
  // Auto-wait on Codex usage limits (issue #167, ADR 030): the same park-and-
  // resume treatment for OpenAI/ChatGPT-plan limits hit by the Codex CLI.
  codexLimitAutoWait: z.boolean().default(true),
  // Auto-resume a job that exhausts its positive turn budget (issue #277). The
  // CLI aborts with an `error_max_turns` result and no provider-limit signal;
  // when on, Drydock resumes the stored session to continue the work (a bounded
  // number of times) instead of parking it in needs_human as "exited non-zero".
  // On by default per the autonomous model — a turn wall is recoverable, not an
  // operator decision. Off restores the plain escalation (with the clear
  // turn-budget reason either way). Only fires when a positive turn budget is
  // set; the default unlimited budget (0) never hits the wall.
  maxTurnsAutoResume: z.boolean().default(true),
  // Global kill-switch for opt-in release management (issue #59, ADR 028). Off by
  // default; both this and a repo's own `releaseEnabled` must be on for the
  // release pipeline to run for that repo. Cutting a public release is hard to
  // reverse, so the feature ships gated and previewable.
  releaseManagementEnabled: z.boolean().default(false),
  defaultModel: z
    .string()
    .refine(isKnownModelId, { message: "unknown model id" })
    .default("claude-opus-4-8"),
  defaultAgent: z.enum(["claude", "codex"]).default("claude"),
  claudePath: z.string().default("claude"),
  codexPath: z.string().default("codex"),
  // opencode CLI binary path (issue #349). Only used by repos whose agent is
  // opencode; defaults to the binary on PATH.
  opencodePath: z.string().default("opencode"),
  ghPath: z.string().default("gh"),
  maxParallelJobs: z.number().int().positive().default(3),
  telegramBotToken: z.string().default(""),
  telegramChatId: z.string().default(""),
  // External notification channels (issue #22). Each is optional and
  // configured independently; an empty value disables that channel.
  slackWebhookUrl: z.string().default(""),
  // Generic webhook channel (issue #414). POSTs a documented structured JSON
  // payload (`{ event, text }`) to an arbitrary URL, so integrations Drydock
  // does not ship natively — Discord, ntfy, Gotify, Pushover, Home Assistant,
  // any self-hosted relay — can be driven from one payload instead of a bespoke
  // channel each. An empty URL disables it. The optional `webhookSecret` is sent
  // as the `X-Drydock-Secret` request header so a receiver can verify the call
  // came from Drydock. Both are treated as credentials (see SECRET_SETTING_KEYS):
  // the URL can itself embed a token (e.g. a Discord webhook path), like
  // `slackWebhookUrl`.
  webhookUrl: z.string().default(""),
  webhookSecret: z.string().default(""),
  smtpHost: z.string().default(""),
  smtpPort: z.number().int().positive().default(587),
  smtpUser: z.string().default(""),
  smtpPass: z.string().default(""),
  emailFrom: z.string().default(""),
  emailTo: z.string().default(""),
  // ---- OpenRouter API key, bridged onto opencode (issue #349, ADR 039). The
  // bespoke OpenRouter HTTP backend was retired; opencode now reaches OpenRouter
  // natively via `openrouter/<model>` ids and reads OPENROUTER_API_KEY from its
  // environment. Drydock stores the key here and injects it into the spawned
  // opencode process (see agentSpawnEnv). The DRYDOCK_OPENROUTER_API_KEY env var
  // overrides it (headless deployments); redacted from logs/events like all
  // other secrets. Empty = let opencode use its own configured auth instead.
  openrouterApiKey: z.string().default(""),
  // Opt-in sandboxed agent execution (issue #182, ADR 033). The default image
  // used for a sandboxed repo when neither a per-repo override nor the repo's
  // devcontainer.json names one. The image MUST carry the agent CLI plus the
  // repo's toolchain. `containerRuntime` pins which runtime to shell out to;
  // "auto" probes docker then podman.
  sandboxDefaultImage: z.string().default("node:20-bookworm"),
  containerRuntime: z.enum(["auto", "docker", "podman"]).default("auto"),
  // Lifecycle events that trigger a notification on every configured channel.
  notifyEvents: z.array(z.enum(NOTIFICATION_EVENTS)).default([...NOTIFICATION_EVENTS]),
  // Play an in-app sound the moment a job parks in needs_human (issue #258). On
  // by default per the autonomous model — when a human IS needed, make it
  // obvious. The toast and any backgrounded-tab desktop notification still fire
  // when this is off; only the audible cue is gated. Client-side only, and it
  // honors the browser autoplay policy (sound after the first interaction).
  needsHumanSoundEnabled: z.boolean().default(true),
  // Finished jobs older than this many days have their verbose job_events
  // pruned (their cost summary rows are kept). See issue #24.
  retentionDays: z.number().int().positive().default(30),
  // Retention window for the in-process daily DB backup sweep, in days (issue
  // #411, ADR 042). The sweep writes a WAL-safe snapshot at startup and every
  // 24h, then prunes snapshots older than this. Defaults to 7 (the historical
  // `pnpm backup`/`RETENTION_DAYS` value). 0 disables the sweep entirely — no
  // snapshots are written — mirroring the `0 = off` convention of the cost/turn
  // ceilings; a manual `drydock backup` still works when it is off.
  backupRetentionDays: z.number().int().nonnegative().default(7),
  // Minimum severity written to the structured server-log sink (issue #294, ADR
  // 035). The sink also seeds its level from DRYDOCK_LOG_LEVEL before the DB is
  // available (bootstrap), then this saved value takes over at runtime. The
  // Logs page has its own independent level *filter* on top of what is written.
  logLevel: z.enum(LOG_LEVELS).default("info"),
  // First-run onboarding (issue #356). Unix seconds when the user finished or
  // dismissed the setup checklist; null while it has never been seen. Gates the
  // auto-opening welcome flow so it greets a fresh install exactly once, then
  // stays reachable on demand from Settings. Stored here (global settings row)
  // rather than browser-local so the "already onboarded" state is shared across
  // every device pointed at the same Drydock instance.
  onboardingCompletedAt: z.number().int().nullable().default(null),
});
export type Settings = z.infer<typeof settingsSchema>;

/**
 * Global-settings keys that carry credentials and must never leave the process
 * verbatim. This is the single source of truth for "which settings are secrets":
 * the MCP `get_settings` tool and the settings export/import bundle (issue #412)
 * both redact against it, so a field added here is masked everywhere at once.
 * `openrouterApiKey` lives here too — its schema comment already promises it is
 * "redacted from logs/events like all other secrets" (ADR 039).
 */
export const SECRET_SETTING_KEYS = [
  "telegramBotToken",
  "slackWebhookUrl",
  "webhookUrl",
  "webhookSecret",
  "smtpPass",
  "openrouterApiKey",
] as const satisfies readonly (keyof Settings)[];

export type SecretSettingKey = (typeof SECRET_SETTING_KEYS)[number];

/** Fixed mask substituted for a non-empty secret; also the sentinel an import ignores. */
export const SETTINGS_REDACTION_PLACEHOLDER = "***";

/**
 * Return a copy of `settings` with every non-empty credential field masked. An
 * empty secret stays empty (nothing to hide), and non-secret fields are copied
 * through untouched. The input is never mutated.
 */
export function redactSettingsSecrets<T extends Record<string, unknown>>(settings: T): T {
  const out = { ...settings };
  for (const key of SECRET_SETTING_KEYS) {
    if (typeof out[key] === "string" && out[key] !== "") {
      (out as Record<string, unknown>)[key] = SETTINGS_REDACTION_PLACEHOLDER;
    }
  }
  return out;
}

const KEY = "global";

export function getSettings(db: DB = getDb()): Settings {
  const row = db.select().from(settings).where(eq(settings.key, KEY)).get();
  if (!row) return settingsSchema.parse({});
  try {
    return settingsSchema.parse(JSON.parse(row.value));
  } catch {
    return settingsSchema.parse({});
  }
}

export function saveSettings(patch: Partial<Settings>, db: DB = getDb()): Settings {
  const merged = settingsSchema.parse({ ...getSettings(db), ...patch });
  const value = JSON.stringify(merged);
  const existing = db.select().from(settings).where(eq(settings.key, KEY)).get();
  if (existing) {
    db.update(settings).set({ value }).where(eq(settings.key, KEY)).run();
  } else {
    db.insert(settings).values({ key: KEY, value }).run();
  }
  // Apply the persisted log level to the live sink so a Settings change takes
  // effect immediately, without a restart (issue #294).
  setServerLogLevel(merged.logLevel);
  return merged;
}

export interface GateResult {
  allowed: boolean;
  reason?: "paused" | "draining" | "auth" | "cost_limit" | "repo_cost_limit";
}

/** Whether the driver loop may start new jobs right now (SPEC §6.1). */
export function jobsAllowed(db: DB = getDb()): GateResult {
  const s = getSettings(db);
  if (s.paused) return { allowed: false, reason: "paused" };
  if (s.draining) return { allowed: false, reason: "draining" };
  // Credential watchdog gate (issue #177): expired gh/GitLab/agent auth stops
  // new work from starting against dead credentials; in-flight jobs finish.
  // The next healthy probe clears the persisted failures and re-opens the gate.
  if (getCredentialFailures(db).length > 0) return { allowed: false, reason: "auth" };
  // A daily budget of 0 means "off / unlimited" (issue #234), mirroring the
  // per-job cost cap: only the per-job cap, provider usage-limit auto-wait, and
  // pause/drain remain as stops. A positive budget still gates new runs.
  if (s.dailyCostLimitUsd > 0 && todayCost(db) >= s.dailyCostLimitUsd) {
    return { allowed: false, reason: "cost_limit" };
  }
  // Monthly budget gate (issue #413): same 0 = off semantics as the daily one,
  // measured against month-to-date spend. Reported under the shared `cost_limit`
  // reason so the existing edge notification and MCP gate messaging cover both
  // horizons without change — a spend cap tripped, daily or monthly.
  if (s.monthlyCostLimitUsd > 0 && monthCost(db) >= s.monthlyCostLimitUsd) {
    return { allowed: false, reason: "cost_limit" };
  }
  return { allowed: true };
}

/** Whether new jobs may start for a specific repo (its own daily limit). */
export function repoJobsAllowed(repoId: number, db: DB = getDb()): GateResult {
  const repo = db.select().from(repos).where(eq(repos.id, repoId)).get();
  if (!repo) return { allowed: false, reason: "repo_cost_limit" };
  // 0 = off / unlimited for the repo's daily budget too (issue #234).
  if (repo.dailyCostLimitUsd > 0 && todayCost(db, repoId) >= repo.dailyCostLimitUsd) {
    return { allowed: false, reason: "repo_cost_limit" };
  }
  // Per-repo monthly budget gate (issue #413), mirroring the global monthly gate
  // and the repo's own daily one: 0 = off, otherwise month-to-date repo spend
  // against the ceiling. Same `repo_cost_limit` reason as the daily case.
  if (repo.monthlyCostLimitUsd > 0 && monthCost(db, repoId) >= repo.monthlyCostLimitUsd) {
    return { allowed: false, reason: "repo_cost_limit" };
  }
  return { allowed: true };
}
