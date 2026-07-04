import { type AgentProvider, WAITABLE_LIMIT_KINDS } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import type { IssueSubtask, Repo } from "@/lib/db/schema";
import type { CommandRunner } from "@/lib/exec/runner";
import type { IssueDetail } from "@/lib/github/gh";
import {
  type DecomposeInput,
  MIN_SUBTASKS,
  renderSubtaskChecklist,
  type SubtaskGenerator,
} from "@/lib/issues/decompose";
import { ensureSubtasks, listSubtasks, transitionSubtask } from "@/lib/issues/subtasks";
import { logError } from "@/lib/log/logger";
import { runOneShotAndRecordCost } from "./one-shot-runner";
import { latchProviderLimit, limitAutoWaitEnabled, ProviderLimitError } from "./provider-limit";
import type { SubtaskStatus } from "./subtask-state";

/**
 * The driver-side glue for decomposing large issues into tracked subtasks
 * (issue #19): the agent one-shot generator, the per-repo decomposition sweep,
 * and the helpers run-job uses to surface subtasks in the agent prompt and
 * reflect progress as a job runs. Pure decision logic lives in `decompose.ts`
 * and persistence in `subtasks.ts`; this module wires them to the forge/agent.
 */

const SUBTASK_COMMENT_HEADER =
  "Drydock decomposed this issue into subtasks and will work them in order:";

interface ParsedSubtasks {
  /** Trimmed, non-empty string titles found in the agent's JSON array. */
  titles: string[];
  /**
   * Whether a JSON array was actually found and parsed. `true` even for a
   * well-formed empty array (`[]`) — the agent's legitimate "do not split"
   * answer — and `false` when the output contained no parseable array at all
   * (a crashed or garbled reply). Lets callers distinguish an intentional empty
   * result from a silent parse failure worth logging (issue #422).
   */
  parsed: boolean;
}

/** Parse an agent's free-form output into subtask titles, tracking parseability. */
function parseSubtaskResult(stdout: string): ParsedSubtasks {
  const match = stdout.match(/\[[\s\S]*\]/);
  if (!match) return { titles: [], parsed: false };
  try {
    const value: unknown = JSON.parse(match[0]);
    if (!Array.isArray(value)) return { titles: [], parsed: false };
    return {
      titles: value
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.trim())
        .filter(Boolean),
      parsed: true,
    };
  } catch {
    return { titles: [], parsed: false };
  }
}

/** Parse a JSON array of subtask titles out of an agent's free-form output. */
export function parseSubtaskList(stdout: string): string[] {
  return parseSubtaskResult(stdout).titles;
}

/** The one-shot prompt asking the agent to split a prose issue into subtasks. */
function subtaskPrompt(input: DecomposeInput): string {
  return [
    `Break the following GitHub issue into an ordered list of independent subtasks`,
    `that can each be implemented and reviewed on their own.`,
    "",
    `Title: ${input.title}`,
    "",
    input.body.trim(),
    "",
    `Respond with ONLY a JSON array of short subtask title strings, in the order`,
    `they should be done. If the issue is a single coherent task that should not`,
    `be split, respond with an empty array [].`,
  ].join("\n");
}

/**
 * A {@link SubtaskGenerator} backed by a one-shot agent run in the repo's
 * checkout. The CLI invocation is built from the repo's {@link AgentProvider}
 * (issue #49) so a Codex repo decomposes via `codex exec` and a Claude repo via
 * `claude -p` — never a hardcoded Claude shape. Best-effort: a non-zero exit or
 * unparseable output yields no subtasks (the issue is then worked whole) rather
 * than an error — except a waitable provider limit (issue #167), which latches
 * the agent and throws {@link ProviderLimitError} so the caller defers instead
 * of stamping the issue as non-decomposable.
 */
export function buildSubtaskGenerator(deps: {
  provider: AgentProvider;
  command: string;
  model: string;
  cwd: string;
  repoId?: number;
  db?: DB;
  runner?: CommandRunner;
}): SubtaskGenerator {
  return async (input) => {
    const { text, exitCode, stderr } = await runOneShotAndRecordCost({
      provider: deps.provider,
      command: deps.command,
      model: deps.model,
      cwd: deps.cwd,
      prompt: subtaskPrompt(input),
      repoId: deps.repoId,
      type: "decompose",
      runner: deps.runner,
      db: deps.db,
    });
    if (exitCode !== 0) {
      const limit = deps.provider.classifyFailure?.({ exitCode, stderr, resultText: text });
      if (limit && WAITABLE_LIMIT_KINDS.includes(limit.kind)) {
        const db = deps.db ?? getDb();
        if (limitAutoWaitEnabled(deps.provider.id, db)) {
          latchProviderLimit(limit, db);
          throw new ProviderLimitError(limit);
        }
      }
      // Not a waitable limit we're deferring on: the issue will be stamped and
      // worked whole, so leave a trace of why decomposition never ran (issue
      // #422) instead of silently returning [].
      logError(
        `[subtasks] decompose one-shot exited ${exitCode} for issue #${input.number}`,
        stderr.trim().slice(0, 500),
      );
      return [];
    }
    const { titles, parsed } = parseSubtaskResult(text);
    if (!parsed) {
      // A zero exit with no parseable JSON array is a garbled reply, not the
      // agent's legitimate empty-array "do not split" answer — log it so the
      // stamped-non-decomposable state is explainable (issue #422).
      logError(
        `[subtasks] decompose one-shot returned an unparseable subtask list for issue #${input.number}`,
        text.trim().slice(0, 500),
      );
    }
    return titles;
  };
}

/** The forge operations the decomposition sweep needs; a subset of ForgeClient. */
export interface DecomposeForge {
  viewIssue(issueNumber: number): Promise<IssueDetail>;
  commentIssue(issueNumber: number, body: string): Promise<void>;
}

/**
 * Decompose each candidate issue for a repo (issue #19). For every issue it
 * fetches the body, runs the idempotent {@link ensureSubtasks}, and — only on a
 * fresh decomposition that produced subtasks — leaves a single comment listing
 * the plan. Per-issue failures are isolated so one bad issue never stalls the
 * sweep. Callers gate this on the repo's opt-in `autoDecompose` flag and pass a
 * bounded candidate set (issues actually queued/ready for work).
 */
export async function decomposeRepo(
  repo: Repo,
  forge: DecomposeForge,
  candidates: { number: number }[],
  db: DB = getDb(),
  opts: { generate?: SubtaskGenerator } = {},
): Promise<void> {
  for (const candidate of candidates) {
    try {
      const detail = await forge.viewIssue(candidate.number);
      const result = await ensureSubtasks(
        repo,
        { number: detail.number, title: detail.title, body: detail.body },
        db,
        { generate: opts.generate },
      );
      if (!result.skipped && result.subtasks.length >= MIN_SUBTASKS) {
        const checklist = renderSubtaskChecklist(
          result.subtasks.map((s) => ({ title: s.title, status: s.status as SubtaskStatus })),
        );
        await forge.commentIssue(detail.number, `${SUBTASK_COMMENT_HEADER}\n\n${checklist}`);
      }
    } catch (err) {
      // A waitable provider limit aborts the whole sweep (issue #167): the
      // agent is latched, every remaining candidate would bounce too, and the
      // un-stamped issue is retried once the latch clears.
      if (err instanceof ProviderLimitError) throw err;
      logError(`[subtasks] decomposition failed for ${repo.name}#${candidate.number}`, err);
    }
  }
}

/**
 * The subtask section appended to a job's agent prompt, instructing it to work
 * the subtasks top-to-bottom within this one piece of work. Empty when the issue
 * has no subtasks, so non-decomposed issues are wholly unaffected.
 */
export function subtaskPromptSection(subtasks: { title: string; status: SubtaskStatus }[]): string {
  if (subtasks.length === 0) return "";
  return [
    "",
    "",
    "## Subtasks",
    "",
    "This issue has been broken into the ordered subtasks below. Work through them",
    "in order, top to bottom, as part of this single change:",
    "",
    renderSubtaskChecklist(subtasks),
  ].join("\n");
}

/** Mark an issue's pending subtasks as in progress when its job starts work. */
export function markSubtasksWorking(repoId: number, issueNumber: number, db: DB = getDb()): void {
  for (const s of listSubtasks(repoId, issueNumber, db)) {
    if (s.status === "pending") transitionSubtask(s.id, "in_progress", db);
  }
}

function advanceToDone(subtask: IssueSubtask, db: DB): void {
  const status = subtask.status as SubtaskStatus;
  if (status === "done" || status === "skipped") return;
  if (status === "in_progress") {
    transitionSubtask(subtask.id, "done", db);
    return;
  }
  // pending or deferred: step through in_progress to satisfy the state machine.
  transitionSubtask(subtask.id, "in_progress", db);
  transitionSubtask(subtask.id, "done", db);
}

/** Mark all of an issue's non-terminal subtasks done once its job merges. */
export function markSubtasksDone(repoId: number, issueNumber: number, db: DB = getDb()): void {
  for (const s of listSubtasks(repoId, issueNumber, db)) advanceToDone(s, db);
}

/**
 * Reset in-progress subtasks back to pending so a retry resumes correctly
 * (issue #96). Called on every non-merge terminal outcome to undo the
 * markSubtasksWorking call that fired at job start. Terminal subtasks (done,
 * skipped) and already-pending ones are left untouched.
 *
 * The state machine has no direct in_progress → pending edge, so we step
 * through deferred: in_progress → deferred → pending.
 */
export function markSubtasksParked(repoId: number, issueNumber: number, db: DB = getDb()): void {
  for (const s of listSubtasks(repoId, issueNumber, db)) {
    if (s.status === "in_progress") {
      transitionSubtask(s.id, "deferred", db);
      transitionSubtask(s.id, "pending", db);
    }
  }
}
