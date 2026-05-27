import { type DB, getDb } from "@/lib/db/client";
import type { IssueSubtask, Repo } from "@/lib/db/schema";
import { type CommandRunner, spawnRunner } from "@/lib/exec/runner";
import type { IssueDetail } from "@/lib/github/gh";
import {
  type DecomposeInput,
  MIN_SUBTASKS,
  renderSubtaskChecklist,
  type SubtaskGenerator,
} from "@/lib/issues/decompose";
import { ensureSubtasks, listSubtasks, transitionSubtask } from "@/lib/issues/subtasks";
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

/** Parse a JSON array of subtask titles out of an agent's free-form output. */
export function parseSubtaskList(stdout: string): string[] {
  const match = stdout.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
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
 * checkout. Best-effort: a non-zero exit or unparseable output yields no
 * subtasks (the issue is then worked whole) rather than an error.
 */
export function buildSubtaskGenerator(deps: {
  command: string;
  model: string;
  cwd: string;
  runner?: CommandRunner;
}): SubtaskGenerator {
  const runner = deps.runner ?? spawnRunner;
  return async (input) => {
    const res = await runner(
      deps.command,
      ["-p", subtaskPrompt(input), "--model", deps.model],
      deps.cwd,
    );
    if (res.exitCode !== 0) return [];
    return parseSubtaskList(res.stdout);
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
      console.error(`[subtasks] decomposition failed for ${repo.name}#${candidate.number}`, err);
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
