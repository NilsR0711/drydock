"use client";

import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
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
import { moveIssueDown, moveIssueUp } from "@/lib/issues/order";

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
  defaultModel,
  defaultAgent,
}: {
  repoId: number;
  queueLabel: string;
  initialIssues: Issue[];
  pollIntervalSec: number;
  defaultModel: string;
  defaultAgent: string;
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

  function Row({ issue, reorderable }: { issue: Issue; reorderable: boolean }) {
    const allQueue = issues.filter(inQueue);
    const fullIdx = allQueue.findIndex((i) => i.number === issue.number);
    const isFirst = fullIdx === 0;
    const isLast = fullIdx === allQueue.length - 1;

    function handleAddToQueue(e: React.MouseEvent) {
      e.stopPropagation();
      start(() => {
        addToQueueAction(repoId, issue.number)
          .then(setIssues)
          .catch((err: Error) => setError(err.message));
      });
    }

    function handleRemoveFromQueue(e: React.MouseEvent) {
      e.stopPropagation();
      start(() => {
        removeFromQueueAction(repoId, issue.number)
          .then(setIssues)
          .catch((err: Error) => setError(err.message));
      });
    }

    function handleMoveUp(e: React.MouseEvent) {
      e.stopPropagation();
      const newOrder = moveIssueUp(
        allQueue.map((i) => i.number),
        issue.number,
      );
      start(() => {
        reorderIssuesAction(repoId, newOrder).catch((err: Error) => setError(err.message));
      });
    }

    function handleMoveDown(e: React.MouseEvent) {
      e.stopPropagation();
      const newOrder = moveIssueDown(
        allQueue.map((i) => i.number),
        issue.number,
      );
      start(() => {
        reorderIssuesAction(repoId, newOrder).catch((err: Error) => setError(err.message));
      });
    }

    return (
      <li
        draggable
        onDragStart={() => setDragNumber(issue.number)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.stopPropagation();
          if (reorderable) reorderWithinQueue(issue.number);
        }}
        className="issue-row flex items-center gap-3 rounded-xl border border-card-border bg-card p-3"
      >
        {reorderable && (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            {fullIdx + 1}
          </span>
        )}
        <button
          type="button"
          className="min-w-0 flex-1 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setModalIssue(issue.number)}
        >
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
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          {reorderable ? (
            <>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Move #${issue.number} up in queue`}
                disabled={isFirst || pending}
                onClick={handleMoveUp}
                className="h-7 w-7"
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Move #${issue.number} down in queue`}
                disabled={isLast || pending}
                onClick={handleMoveDown}
                className="h-7 w-7"
              >
                <ArrowDown />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Remove #${issue.number} from queue`}
                disabled={pending}
                onClick={handleRemoveFromQueue}
                className="h-7 w-7 text-destructive hover:text-destructive"
              >
                <X />
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={`Add #${issue.number} to queue`}
              disabled={pending}
              onClick={handleAddToQueue}
              className="h-7 w-7"
            >
              <Plus />
            </Button>
          )}
        </div>
        <span aria-hidden className="cursor-grab text-muted-foreground" title="Drag to reorder">
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
        {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for drag-and-drop; keyboard path is via the action buttons on each row */}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={dropToBacklog}
          className="space-y-2 rounded-xl border border-dashed border-card-border p-2"
        >
          <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Backlog ({backlog.length})
          </p>
          <ul className="space-y-2">
            {backlog.map((issue) => (
              <Row key={issue.number} issue={issue} reorderable={false} />
            ))}
            {backlog.length === 0 && (
              <li className="px-1 text-sm text-muted-foreground">No backlog issues.</li>
            )}
          </ul>
        </div>

        {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for drag-and-drop; keyboard path is via the action buttons on each row */}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={dropToQueue}
          className="space-y-2 rounded-xl border border-dashed border-card-border p-2"
        >
          <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Queue ({queue.length})
          </p>
          <ul className="space-y-2">
            {queue.map((issue) => (
              <Row key={issue.number} issue={issue} reorderable={true} />
            ))}
            {queue.length === 0 && (
              <li className="px-1 text-sm text-muted-foreground">
                Drag issues here to queue them, or use the + button.
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
        queueLabel={queueLabel}
        defaultModel={defaultModel}
        defaultAgent={defaultAgent}
      />
    </div>
  );
}
