import type { SubtaskStatus } from "@/lib/orchestrator/subtask-state";

/**
 * Decompose a large issue into ordered subtasks (issue #19). A heuristic pass
 * handles the common structured forms — GitHub task lists (`- [ ]`) and
 * "Bug N —" headings — for free and deterministically. Only when the heuristic
 * finds nothing does an injectable agent generator get a one-shot at the prose.
 * Everything here is pure (the generator is passed in) so it is fully testable
 * without spawning an agent.
 */

/** The fewest items worth tracking: a single "subtask" is just the issue. */
export const MIN_SUBTASKS = 2;

export interface DecomposeInput {
  number: number;
  title: string;
  body: string;
}

/** A one-shot agent fallback that proposes subtask titles for prose issues. */
export type SubtaskGenerator = (input: DecomposeInput) => Promise<string[]>;

export interface DecomposeOptions {
  generate?: SubtaskGenerator;
}

export interface DecomposeResult {
  titles: string[];
  source: "heuristic" | "agent" | "none";
}

/**
 * A content fingerprint of the issue body used to detect when an issue changed
 * and its decomposition should be redone. Plain djb2 keeps this dependency-free
 * and out of the edge bundle (ADR 003), mirroring the triage hash.
 */
export function computeBodyHash(body: string): string {
  let h = 5381;
  for (let i = 0; i < body.length; i++) h = ((h << 5) + h + body.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

const CHECKLIST_RE = /^\s*[-*]\s*\[[ xX]\]\s+(.+?)\s*$/;
// A "Bug N —" / "Bug N:" item, optionally under a markdown heading prefix.
const BUG_HEADING_RE = /^\s*#*\s*(Bug\s+\d+\s*(?:[—:-])\s*.+?)\s*$/;

/** Extract GitHub task-list items (`- [ ]` / `* [x]`), in document order. */
export function parseChecklist(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(CHECKLIST_RE);
    if (m?.[1]) out.push(m[1].trim());
  }
  return out;
}

/** Extract "Bug N — …" style headings, in document order. */
export function parseBugHeadings(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(BUG_HEADING_RE);
    if (m?.[1]) out.push(m[1].trim());
  }
  return out;
}

/**
 * The deterministic, agent-free decomposition: prefer an explicit task list,
 * then "Bug N —" headings. Returns nothing unless a heuristic yields at least
 * {@link MIN_SUBTASKS} items, so an issue with a single stray bullet is left
 * whole.
 */
export function heuristicDecompose(body: string): string[] {
  const checklist = parseChecklist(body);
  if (checklist.length >= MIN_SUBTASKS) return checklist;
  const bugs = parseBugHeadings(body);
  if (bugs.length >= MIN_SUBTASKS) return bugs;
  return [];
}

/**
 * Decompose one issue. Tries the heuristic first; only on an empty result does
 * it fall back to the agent generator (if provided). A generator that throws or
 * returns fewer than {@link MIN_SUBTASKS} usable titles yields no decomposition,
 * never an error — the issue is simply worked whole.
 */
export async function decompose(
  input: DecomposeInput,
  opts: DecomposeOptions = {},
): Promise<DecomposeResult> {
  const heuristic = heuristicDecompose(input.body);
  if (heuristic.length >= MIN_SUBTASKS) return { titles: heuristic, source: "heuristic" };

  if (opts.generate) {
    try {
      const proposed = await opts.generate(input);
      const titles = proposed.map((t) => t.trim()).filter(Boolean);
      if (titles.length >= MIN_SUBTASKS) return { titles, source: "agent" };
    } catch (err) {
      console.error(`[decompose] agent fallback failed for issue #${input.number}`, err);
    }
  }

  return { titles: [], source: "none" };
}

/** Per-status checklist markers for the progress comment / prompt rendering. */
function checkboxFor(status: SubtaskStatus): { box: string; suffix: string } {
  switch (status) {
    case "done":
      return { box: "[x]", suffix: "" };
    case "skipped":
      return { box: "[~]", suffix: " — skipped" };
    case "in_progress":
      return { box: "[ ]", suffix: " — in progress" };
    case "deferred":
      return { box: "[ ]", suffix: " — deferred" };
    default:
      return { box: "[ ]", suffix: "" };
  }
}

/** Render subtasks as an ordered markdown checklist reflecting their status. */
export function renderSubtaskChecklist(
  subtasks: { title: string; status: SubtaskStatus }[],
): string {
  return subtasks
    .map((s, i) => {
      const { box, suffix } = checkboxFor(s.status);
      return `${i + 1}. ${box} ${s.title}${suffix}`;
    })
    .join("\n");
}
