"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Issue } from "@/lib/db/schema";
import { reorderIssuesAction, startIssueAction, syncRepoIssuesAction } from "@/lib/issues/actions";
import { useEffect, useState, useTransition } from "react";

function parseLabels(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function IssueQueue({
  repoId,
  initialIssues,
  pollIntervalSec,
}: {
  repoId: number;
  initialIssues: Issue[];
  pollIntervalSec: number;
}) {
  const [issues, setIssues] = useState<Issue[]>(initialIssues);
  const [query, setQuery] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setIssues(initialIssues), [initialIssues]);

  // Automatic background sync on the configured interval.
  useEffect(() => {
    const ms = Math.max(10, pollIntervalSec) * 1000;
    const t = setInterval(() => {
      syncRepoIssuesAction(repoId)
        .then((fresh) => setIssues(fresh))
        .catch((e) => setError(e.message));
    }, ms);
    return () => clearInterval(t);
  }, [repoId, pollIntervalSec]);

  function manualSync() {
    setError(null);
    start(() => {
      syncRepoIssuesAction(repoId)
        .then((fresh) => setIssues(fresh))
        .catch((e) => setError(e.message));
    });
  }

  function onDrop(targetIndex: number) {
    if (dragIndex === null || dragIndex === targetIndex) return;
    const next = [...issues];
    const [moved] = next.splice(dragIndex, 1);
    if (!moved) return;
    next.splice(targetIndex, 0, moved);
    setIssues(next);
    setDragIndex(null);
    start(() => {
      reorderIssuesAction(
        repoId,
        next.map((i) => i.number),
      ).catch((e) => setError(e.message));
    });
  }

  const filtered = issues.filter((i) => {
    const q = query.toLowerCase();
    return (
      !q ||
      i.title.toLowerCase().includes(q) ||
      String(i.number).includes(q) ||
      parseLabels(i.labels).some((l) => l.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Issue queue
        </h2>
        <span className="text-xs text-muted-foreground">({issues.length})</span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={pending}
          onClick={manualSync}
        >
          {pending ? "Syncing…" : "Refresh"}
        </Button>
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by title or label…"
        className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      />

      {error && <p className="text-xs text-destructive">{error}</p>}
      {filtered.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No issues. “Refresh” pulls labelled issues from GitHub.
        </p>
      )}

      <ul className="space-y-2">
        {filtered.map((issue, index) => (
          <li
            key={issue.number}
            draggable
            onDragStart={() => setDragIndex(index)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(index)}
            className={`issue-row flex items-center gap-3 rounded-xl border border-card-border bg-card p-3 ${
              dragIndex === index ? "dragging" : ""
            }`}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                #{issue.number} {issue.title}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {parseLabels(issue.labels).map((l) => (
                  <Badge key={l}>{l}</Badge>
                ))}
              </div>
            </div>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => start(() => startIssueAction(repoId, issue.number).then(() => {}))}
            >
              Start now
            </Button>
            <span className="cursor-grab text-muted-foreground" title="Drag to reorder">
              ⠿
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
