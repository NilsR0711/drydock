import type { AgentId } from "@/lib/agents/types";
import type { Job } from "@/lib/db/schema";
import { EmptyCommitError, type Worktree } from "@/lib/git/worktree";
import type { AgentSessionResult, SessionLimitInfo } from "./agent-session";
import { type ResumeOutcome, resumeFailureReason } from "./ci-babysitter";

/**
 * Pure prompt/message builders for the job driver (issue #431): the plan and
 * human-guidance prompt sections, provider-limit park messaging, and the CI-fix
 * resume assembly. Extracted from `run-job.ts` so the driver file keeps only the
 * state machine and orchestration glue — mirroring the `issues/pr-audit.ts` /
 * `orchestrator/pr-audit-driver.ts` split. Everything here is trivially
 * unit-testable without spawning an agent or touching the database.
 */

/**
 * How many times a job that keeps exhausting its turn budget is auto-resumed
 * before escalating to a human (issue #277). Each resume grants a fresh budget's
 * worth of turns, so this bounds total work at roughly (1 + cap) × the budget —
 * enough for a task that legitimately needs a few more passes, while still
 * converging on needs_human for one that never finishes.
 */
export const MAX_TURN_RESUMES = 3;

/** Keeps an unexpectedly verbose plan from flooding the work prompt. */
const PLAN_MAX_CHARS = 10_000;

/** Upper bound on the human instruction injected into a fresh-run prompt (issue #257). */
export const HUMAN_INSTRUCTION_MAX_CHARS = 4000;

/** Truncate to a max length with a clear marker, matching the plan-section cap. */
export function capPromptText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

/** Render the plan as a dedicated, length-capped prompt section (issue #160). */
export function planPromptSection(plan: string): string {
  const trimmed = plan.trim();
  if (!trimmed) return "";
  const capped =
    trimmed.length > PLAN_MAX_CHARS
      ? `${trimmed.slice(0, PLAN_MAX_CHARS)}\n… (truncated)`
      : trimmed;
  return [
    "",
    "",
    "## Implementation plan",
    "Follow this plan unless the code contradicts it:",
    "",
    capped,
  ].join("\n");
}

/**
 * Render the operator's human-guided-resume instruction as a dedicated,
 * length-capped prompt section (issue #257). Used on the fresh-run fallback,
 * when the job had no resumable session to feed the instruction into directly.
 */
export function humanInstructionPromptSection(instruction: string): string {
  const trimmed = instruction.trim();
  if (!trimmed) return "";
  const capped = capPromptText(trimmed, HUMAN_INSTRUCTION_MAX_CHARS);
  return [
    "",
    "",
    "## Human guidance",
    "A human reviewed where this job got stuck and gave the following instruction.",
    "Follow it to get unblocked:",
    "",
    capped,
  ].join("\n");
}

/** Operator-facing description of a parked job's limit kind (issues #166/#167). */
export function limitParkMessage(kind: SessionLimitInfo["kind"], agent: AgentId): string {
  const [vendor, label] = agent === "codex" ? ["OpenAI", "Codex"] : ["Anthropic", "Claude"];
  switch (kind) {
    case "rate_limit":
      return `${vendor} API rate limit hit — waiting for the window to clear`;
    case "overloaded":
      return `${vendor} API overloaded — waiting before retrying`;
    default:
      return `${label} usage limit reached — waiting for the quota to reset`;
  }
}

/**
 * Minimal worktree surface the CI-fix resume needs: commit + push the fix into
 * the job's PR branch. Kept structural (rather than importing the driver's full
 * WorktreeApi) so this module never depends back on `run-job.ts`.
 */
interface CommitAndPushWorktree {
  commitAndPush(wt: Worktree, message: string): Promise<void>;
}

/**
 * Build the babysitter's CI-fix resume callback. The fix session must run in
 * the job's worktree — the PR branch is checked out there, not in the
 * operator's primary checkout — and its result must be committed and pushed,
 * or the PR head never changes and the babysitter burns its whole retry
 * budget re-observing the same failed checks. Exported for tests.
 */
export function buildCiFixResume(opts: {
  worktrees: CommitAndPushWorktree;
  /** Resolves the job's live worktree; the babysitter only runs while it exists. */
  worktree: () => Worktree | undefined;
  /** Whether an outside actor (abort, emergency stop) settled the job. */
  settled?: () => boolean;
  resume: (
    job: Job,
    sessionId: string,
    failedLog: string,
    cwd: string,
  ) => Promise<AgentSessionResult>;
}): (job: Job, sessionId: string, failedLog: string) => Promise<ResumeOutcome> {
  return async (job, sessionId, failedLog) => {
    const wt = opts.worktree();
    if (!wt) throw new Error(`job ${job.id} has no live worktree to resume in`);
    const result = await opts.resume(job, sessionId, failedLog, wt.path);
    const outcome: ResumeOutcome = {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      costExceeded: result.costExceeded,
      spawnError: result.spawnError,
      limit: result.limit,
    };
    if (resumeFailureReason(outcome)) return outcome;
    // An abort that landed while the fix session ran must win: never push an
    // aborted job's partial work. The babysitter escalates on the reason; for
    // an already-settled job its transition throws and runJobCore's catch
    // returns the settled row untouched.
    if (opts.settled?.()) return { ...outcome, settledExternally: true };
    try {
      await opts.worktrees.commitAndPush(wt, `Fix CI for #${job.issueNumber}`);
    } catch (err) {
      // A fix session that changed nothing cannot turn CI green; report it so
      // the babysitter escalates instead of polling an unchanged PR head.
      if (err instanceof EmptyCommitError) return { ...outcome, noChanges: true };
      throw err;
    }
    return outcome;
  };
}
