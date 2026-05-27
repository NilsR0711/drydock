"use client";

import { useEffect, useState, useTransition } from "react";
import { IssueDetailModal } from "@/components/issue-detail-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Issue } from "@/lib/db/schema";
import {
  addToQueueAction,
  removeFromQueueAction,
  reorderIssuesAction,
  syncRepoIssuesAction,
} from "@/lib/issues/actions";

function parseLabels(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function IssueBoard({
  repoId,
  queueLabel,
  initialIssues,
  pollIntervalSec,
}: {
  repoId: number;
  queueLabel: string;
  initialIssues: Issue[];
  pollIntervalSec: number;
}) {
  const [issues, setIssues] = useState<Issue[]>(initialIssues);
  const [query, setQuery] = useState("");
  const [dragNumber, setDragNumber] = useState<number | null>(null);
  const [modalIssue, setModalIssue] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setIssues(initialIssues), [initialIssues]);

  useEffect(() => {
    const ms = Math.max(10, pollIntervalSec) * 1000;
    const t = setInterval(() => {
      syncRepoIssuesAction(repoId)
        .then(setIssues)
        .catch((e) => setError(e.message));
    }, ms);
    return () => clearInterval(t);
  }, [repoId, pollIntervalSec]);

  function manualSync() {
    setError(null);
    start(() => {
      syncRepoIssuesAction(repoId)
        .then(setIssues)
        .catch((e) => setError(e.message));
    });
  }

  const inQueue = (i: Issue) => parseLabels(i.labels).includes(queueLabel);
  const matches = (i: Issue) => {
    const q = query.toLowerCase();
    return (
      !q ||
      i.title.toLowerCase().includes(q) ||
      String(i.number).includes(q) ||
      parseLabels(i.labels).some((l) => l.toLowerCase().includes(q))
    );
  };

  const backlog = issues.filter((i) => !inQueue(i) && matches(i));
  const queue = issues.filter((i) => inQueue(i) && matches(i));

  function dropToQueue() {
    if (dragNumber === null) return;
    const moved = issues.find((i) => i.number === dragNumber);
    setDragNumber(null);
    if (!moved || inQueue(moved)) return;
    start(() => {
      addToQueueAction(repoId, moved.number)
        .then(setIssues)
        .catch((e) => setError(e.message));
    });
  }

  function dropToBacklog() {
    if (dragNumber === null) return;
    const moved = issues.find((i) => i.number === dragNumber);
    setDragNumber(null);
    if (!moved || !inQueue(moved)) return;
    start(() => {
      removeFromQueueAction(repoId, moved.number)
        .then(setIssues)
        .catch((e) => setError(e.message));
    });
  }

  function reorderWithinQueue(targetNumber: number) {
    if (dragNumber === null || dragNumber === targetNumber) return;
    const moved = issues.find((i) => i.number === dragNumber);
    if (!moved || !inQueue(moved)) return; // only reorder queued items
    const order = queue.map((i) => i.number).filter((n) => n !== dragNumber);
    const targetIdx = order.indexOf(targetNumber);
    order.splice(targetIdx, 0, dragNumber);
    setDragNumber(null);
    start(() => {
      reorderIssuesAction(repoId, order).catch((e) => setError(e.message));
    });
  }

  function Row({
    issue,
    index,
    reorderable,
  }: {
    issue: Issue;
    index: number;
    reorderable: boolean;
  }) {
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: row is primarily a drag target; keyboard users use the detail modal via other entry points
      <li
        draggable
        onDragStart={() => setDragNumber(issue.number)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.stopPropagation();
          if (reorderable) reorderWithinQueue(issue.number);
        }}
        className="issue-row flex cursor-pointer items-center gap-3 rounded-xl border border-card-border bg-card p-3"
        onClick={() => setModalIssue(issue.number)}
      >
        {reorderable && (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            {index + 1}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            #{issue.number} {issue.title}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {issue.triagedAt && (
              <Badge
                tone="primary"
                title="Labels applied by auto-triage — see the issue comment for reasons"
              >
                auto-triaged
              </Badge>
            )}
            {parseLabels(issue.labels)
              .filter((l) => l !== queueLabel)
              .map((l) => (
                <Badge key={l}>{l}</Badge>
              ))}
          </div>
        </div>
        <span className="cursor-grab text-muted-foreground" title="Drag">
          ⠿
        </span>
      </li>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Issues
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
        aria-label="Search issues by title or label"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by title or label…"
        className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop target for the backlog column */}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={dropToBacklog}
          className="space-y-2 rounded-xl border border-dashed border-card-border p-2"
        >
          <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Backlog ({backlog.length})
          </p>
          <ul className="space-y-2">
            {backlog.map((issue, i) => (
              <Row key={issue.number} issue={issue} index={i} reorderable={false} />
            ))}
            {backlog.length === 0 && (
              <li className="px-1 text-sm text-muted-foreground">No backlog issues.</li>
            )}
          </ul>
        </div>

        {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop target for the queue column */}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={dropToQueue}
          className="space-y-2 rounded-xl border border-dashed border-card-border p-2"
        >
          <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Queue ({queue.length})
          </p>
          <ul className="space-y-2">
            {queue.map((issue, i) => (
              <Row key={issue.number} issue={issue} index={i} reorderable={true} />
            ))}
            {queue.length === 0 && (
              <li className="px-1 text-sm text-muted-foreground">
                Drag issues here to auto-process them.
              </li>
            )}
          </ul>
        </div>
      </div>

      <IssueDetailModal
        repoId={repoId}
        issueNumber={modalIssue}
        open={modalIssue !== null}
        onClose={() => setModalIssue(null)}
      />
    </div>
  );
}
