"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/ui/toast";
import type { Repo } from "@/lib/db/schema";
import { updateRepoAction } from "@/lib/repos/actions";

function parseList(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Split a comma/space separated input into a clean, de-duplicated list. */
function splitInput(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Opt-in automation controls for a repo: auto-triage and auto-processing
 * toggles plus the label/author lists that gate them. Both stages consume paid
 * agent usage, so the panel is explicit about being off by default.
 */
export function RepoAutomationBar({ repo }: { repo: Repo }) {
  const [autoTriage, setAutoTriage] = useState(repo.autoTriageEnabled);
  const [autoProcess, setAutoProcess] = useState(repo.autoProcessEnabled);
  const [autoHeal, setAutoHeal] = useState(repo.autoHealCi);
  const [autoFeedback, setAutoFeedback] = useState(repo.autoReviewFeedback);
  const [autoDecompose, setAutoDecompose] = useState(repo.autoDecompose);
  const [resolveConflicts, setResolveConflicts] = useState(repo.autoResolveMergeConflicts);
  const [progressReplies, setProgressReplies] = useState(repo.includeProgressReplies);
  const [ready, setReady] = useState(parseList(repo.readyLabels).join(", "));
  const [blocking, setBlocking] = useState(parseList(repo.blockingLabels).join(", "));
  const [whitelist, setWhitelist] = useState(parseList(repo.autoLabelWhitelist).join(", "));
  const [authors, setAuthors] = useState(parseList(repo.priorityAuthors).join(", "));
  const [reviewers, setReviewers] = useState(parseList(repo.trustedReviewers).join(", "));
  const [bots, setBots] = useState(parseList(repo.ignoredBots).join(", "));
  const [minAssoc, setMinAssoc] = useState(repo.minAuthorAssociation);
  const [maxAttempts, setMaxAttempts] = useState(repo.maxAttempts);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const { error } = useToast();

  function persist(patch: Parameters<typeof updateRepoAction>[1]) {
    setSaved(false);
    start(async () => {
      try {
        await updateRepoAction(repo.id, patch);
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      } catch (e) {
        error("Failed to update automation", e instanceof Error ? e.message : String(e));
      }
    });
  }

  const labelField = (
    id: string,
    label: string,
    value: string,
    setter: (v: string) => void,
    key:
      | "readyLabels"
      | "blockingLabels"
      | "autoLabelWhitelist"
      | "priorityAuthors"
      | "trustedReviewers"
      | "ignoredBots",
  ) => (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={id}>
      {label}
      <input
        id={id}
        value={value}
        onChange={(e) => setter(e.target.value)}
        onBlur={() => persist({ [key]: splitInput(value) })}
        placeholder="comma-separated"
        className="rounded border border-card-border bg-background px-2 py-1 text-sm text-foreground"
      />
    </label>
  );

  return (
    <div className="space-y-3 rounded-xl border border-card-border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center gap-4">
        <span className="text-sm font-semibold">Automation</span>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <input
            type="checkbox"
            checked={autoTriage}
            onChange={(e) => {
              setAutoTriage(e.target.checked);
              persist({ autoTriageEnabled: e.target.checked });
            }}
          />
          Auto-triage new issues
        </label>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <input
            type="checkbox"
            checked={autoProcess}
            onChange={(e) => {
              setAutoProcess(e.target.checked);
              persist({ autoProcessEnabled: e.target.checked });
            }}
          />
          Auto-process ready issues
        </label>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <input
            type="checkbox"
            checked={autoHeal}
            onChange={(e) => {
              setAutoHeal(e.target.checked);
              persist({ autoHealCi: e.target.checked });
            }}
          />
          Auto-heal failing CI
        </label>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <input
            type="checkbox"
            checked={autoFeedback}
            onChange={(e) => {
              setAutoFeedback(e.target.checked);
              persist({ autoReviewFeedback: e.target.checked });
            }}
          />
          Address PR review feedback
        </label>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <input
            type="checkbox"
            checked={autoDecompose}
            onChange={(e) => {
              setAutoDecompose(e.target.checked);
              persist({ autoDecompose: e.target.checked });
            }}
          />
          Decompose large issues
        </label>
        {pending && <span className="text-xs text-muted-foreground">Saving…</span>}
        {saved && <span className="text-xs text-success">Saved</span>}
      </div>

      <p className="text-xs text-muted-foreground">
        Opt-in. All stages are off by default and consume paid agent usage. Triage may only apply
        whitelisted labels; auto-processing works issues that are <em>ready</em> and not blocked;
        auto-heal attempts bounded, verified fixes for failing CI (never external or AI-review
        checks). PR review feedback is applied only for trusted reviewers (bots ignored) and runs
        the mechanical iteration for you. Decomposing large issues splits them into ordered, tracked
        subtasks (checklist/heading heuristics, with an agent fallback for prose). Drydock never
        auto-merges — a human always reviews the PR.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {labelField("ready-labels", "Ready labels", ready, setReady, "readyLabels")}
        {labelField("blocking-labels", "Blocking labels", blocking, setBlocking, "blockingLabels")}
        {labelField(
          "whitelist",
          "Auto-label whitelist",
          whitelist,
          setWhitelist,
          "autoLabelWhitelist",
        )}
        {labelField("priority-authors", "Priority authors", authors, setAuthors, "priorityAuthors")}
        {labelField(
          "trusted-reviewers",
          "Trusted reviewers (feedback)",
          reviewers,
          setReviewers,
          "trustedReviewers",
        )}
        {labelField("ignored-bots", "Ignored bots (feedback)", bots, setBots, "ignoredBots")}
        <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="min-assoc">
          Act on authors
          <select
            id="min-assoc"
            value={minAssoc}
            onChange={(e) => {
              setMinAssoc(e.target.value);
              persist({ minAuthorAssociation: e.target.value as "approved" | "any" });
            }}
            className="rounded border border-card-border bg-background px-2 py-1 text-sm text-foreground"
          >
            <option value="approved">Owners / members / collaborators</option>
            <option value="any">Anyone (public participation)</option>
          </select>
        </label>
        <label
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          htmlFor="resolve-conflicts"
        >
          <input
            id="resolve-conflicts"
            type="checkbox"
            checked={resolveConflicts}
            onChange={(e) => {
              setResolveConflicts(e.target.checked);
              persist({ autoResolveMergeConflicts: e.target.checked });
            }}
          />
          Repair trivial merge conflicts
        </label>
        <label
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          htmlFor="progress-replies"
        >
          <input
            id="progress-replies"
            type="checkbox"
            checked={progressReplies}
            onChange={(e) => {
              setProgressReplies(e.target.checked);
              persist({ includeProgressReplies: e.target.checked });
            }}
          />
          Post progress replies
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="max-attempts">
          Max attempts
          <input
            id="max-attempts"
            type="number"
            min={1}
            step={1}
            value={maxAttempts}
            onChange={(e) => setMaxAttempts(Number(e.target.value))}
            onBlur={() => persist({ maxAttempts })}
            className="w-24 rounded border border-card-border bg-background px-2 py-1 text-sm text-foreground"
          />
        </label>
      </div>
    </div>
  );
}
