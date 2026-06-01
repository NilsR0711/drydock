import { and, eq } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import { issues, type Repo } from "@/lib/db/schema";
import type { GhIssue, IssueDetail } from "@/lib/github/gh";
import { logError } from "@/lib/log/logger";
import { authorAllowed, repoAutomation } from "@/lib/repos/automation";
import { evaluateIssue } from "./evaluator";

/** The forge operations auto-triage performs; a subset of ForgeClient. */
export interface TriageForge {
  viewIssue(issueNumber: number): Promise<IssueDetail>;
  ensureLabel(name: string, opts?: { color?: string; description?: string }): Promise<void>;
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  commentIssue(issueNumber: number, body: string): Promise<void>;
}

export interface TriageResult {
  number: number;
  applied: string[];
  reasons: string[];
  /** Set when triage took no action: author not approved, or content unchanged. */
  skipped?: "author" | "unchanged";
}

/** Keyword rules mapping issue content to a classification label. */
const CLASSIFIERS: { label: string; re: RegExp }[] = [
  { label: "bug", re: /\b(bug|crash|crashes|broken|error|exception|fails?|regression|defect)\b/i },
  {
    label: "enhancement",
    re: /\b(add|support|feature|implement|enhancement|would be nice|allow|introduce)\b/i,
  },
  { label: "documentation", re: /\b(docs?|documentation|readme|typo|wording|clarify)\b/i },
];

/**
 * Propose classification labels from the issue's text, restricted to the
 * caller's whitelist. Returns at most one label per rule, in rule order, so a
 * defect that also says "add" prefers "bug".
 */
export function classifyLabels(
  content: { title: string; body: string },
  whitelist: string[],
): string[] {
  const allow = new Set(whitelist);
  const haystack = `${content.title}\n${content.body}`;
  const out: string[] = [];
  for (const { label, re } of CLASSIFIERS) {
    if (allow.has(label) && re.test(haystack) && !out.includes(label)) out.push(label);
  }
  return out;
}

/**
 * A content fingerprint used to skip re-triaging unchanged issues. Derived from
 * the listed title + sorted label names (the fields available without a detail
 * fetch); editing either re-opens the issue for triage. Plain djb2 hash keeps
 * this dependency-free and out of the edge bundle (ADR 003).
 */
export function computeTriageHash(listed: { title: string; labels: { name: string }[] }): string {
  const key = JSON.stringify([listed.title, listed.labels.map((l) => l.name).sort()]);
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function mirrorLabelsLocal(repoId: number, number: number, add: string[], db: DB): void {
  const row = db
    .select()
    .from(issues)
    .where(and(eq(issues.repoId, repoId), eq(issues.number, number)))
    .get();
  if (!row) return;
  let labels: string[];
  try {
    const v = JSON.parse(row.labels);
    labels = Array.isArray(v) ? v : [];
  } catch {
    labels = [];
  }
  const next = [...labels];
  for (const l of add) if (!next.includes(l)) next.push(l);
  db.update(issues)
    .set({ labels: JSON.stringify(next) })
    .where(eq(issues.id, row.id))
    .run();
}

function markTriaged(repoId: number, number: number, hash: string, db: DB): void {
  db.update(issues)
    .set({ triageHash: hash, triagedAt: Math.floor(Date.now() / 1000) })
    .where(and(eq(issues.repoId, repoId), eq(issues.number, number)))
    .run();
}

/**
 * Analyze and label a single issue. Honors the repo's author gate and output
 * allowlist (only whitelisted classification labels and the repo's configured
 * ready/blocking labels may be applied), leaves an explanatory marker comment,
 * and records a content hash so unchanged issues aren't re-triaged.
 */
export async function triageIssue(
  repo: Repo,
  forge: TriageForge,
  listed: GhIssue,
  db: DB = getDb(),
): Promise<TriageResult> {
  const cfg = repoAutomation(repo);
  const hash = computeTriageHash(listed);

  const row = db
    .select()
    .from(issues)
    .where(and(eq(issues.repoId, repo.id), eq(issues.number, listed.number)))
    .get();
  if (row?.triagedAt && row.triageHash === hash) {
    return { number: listed.number, applied: [], reasons: [], skipped: "unchanged" };
  }

  if (!authorAllowed(cfg, listed.authorAssociation)) {
    markTriaged(repo.id, listed.number, hash, db);
    return {
      number: listed.number,
      applied: [],
      reasons: ["author not approved"],
      skipped: "author",
    };
  }

  const detail = await forge.viewIssue(listed.number);
  const verdict = evaluateIssue({
    number: detail.number,
    title: detail.title,
    body: detail.body,
    labels: detail.labels,
  });

  const reasons: string[] = [];
  const proposed = classifyLabels(detail, cfg.autoLabelWhitelist);
  for (const l of proposed) reasons.push(`classified as ${l}`);

  if (verdict.decision === "approved") {
    const ready = cfg.readyLabels[0];
    if (ready) {
      proposed.push(ready);
      reasons.push("safe and well-specified");
    }
  } else {
    const blocking = cfg.blockingLabels[0];
    if (blocking) {
      proposed.push(blocking);
      reasons.push(...(verdict.reasons.length ? verdict.reasons : ["flagged for human review"]));
    }
  }

  // Output allowlist: classification whitelist plus the repo's own automation
  // labels. Drop anything already on the issue.
  const allowed = new Set([...cfg.autoLabelWhitelist, ...cfg.readyLabels, ...cfg.blockingLabels]);
  const existing = new Set(detail.labels);
  const applied = [...new Set(proposed)].filter((l) => allowed.has(l) && !existing.has(l));

  if (applied.length > 0) {
    for (const label of applied) await forge.ensureLabel(label);
    await forge.addLabels(listed.number, applied);
    const labelList = applied.map((l) => `\`${l}\``).join(", ");
    await forge.commentIssue(
      listed.number,
      `auto-triage: applied ${labelList} — reasons: ${reasons.join("; ")}.`,
    );
    mirrorLabelsLocal(repo.id, listed.number, applied, db);
  }

  markTriaged(repo.id, listed.number, hash, db);
  return { number: listed.number, applied, reasons };
}

/** Triage every fetched issue for a repo, isolating per-issue failures. */
export async function triageRepo(
  repo: Repo,
  forge: TriageForge,
  fetched: GhIssue[],
  db: DB = getDb(),
): Promise<TriageResult[]> {
  const results: TriageResult[] = [];
  for (const listed of fetched) {
    try {
      results.push(await triageIssue(repo, forge, listed, db));
    } catch (err) {
      logError(`[triage] issue #${listed.number} failed for ${repo.name}`, err);
    }
  }
  return results;
}
