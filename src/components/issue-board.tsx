"use client";

import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  Inbox,
  Plus,
  RefreshCw,
  Search,
  Tag,
  Wand2,
  X,
} from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { IssueDetailModal } from "@/components/issue-detail-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import type { Issue } from "@/lib/db/schema";
import {
  addToQueueAction,
  bulkAddToQueueAction,
  bulkApplyLabelAction,
  bulkRemoveFromQueueAction,
  removeFromQueueAction,
  reorderIssuesAction,
  syncRepoIssuesAction,
} from "@/lib/issues/actions";
import { moveIssueDown, moveIssueUp } from "@/lib/issues/order";
import { cn } from "@/lib/utils";

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
  const [overNumber, setOverNumber] = useState<number | null>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const [modalIssue, setModalIssue] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkLabel, setBulkLabel] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { success } = useToast();

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
    const num = dragNumber;
    const title = moved?.title;
    setDragNumber(null);
    setOverNumber(null);
    if (!moved || inQueue(moved)) return;
    setFlash(num);
    setTimeout(() => setFlash((f) => (f === num ? null : f)), 1200);
    success("Issue queued", `#${num} ${title ?? ""}`.trim());
    start(() => {
      addToQueueAction(repoId, num)
        .then(setIssues)
        .catch((e) => setError(e.message));
    });
  }

  function dropToBacklog() {
    if (dragNumber === null) return;
    const moved = issues.find((i) => i.number === dragNumber);
    setDragNumber(null);
    setOverNumber(null);
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
    setOverNumber(null);
    start(() => {
      reorderIssuesAction(repoId, order).catch((e) => setError(e.message));
    });
  }

  function toggleSelect(number: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(number)) next.delete(number);
      else next.add(number);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  /** Run a bulk action over the current selection, refresh the board, and clear it. */
  function runBulk(action: (numbers: number[]) => Promise<Issue[]>) {
    const numbers = [...selected];
    if (numbers.length === 0) return;
    setError(null);
    start(() => {
      action(numbers)
        .then((next) => {
          setIssues(next);
          clearSelection();
        })
        .catch((e) => setError(e.message));
    });
  }

  function queueAllFiltered() {
    const numbers = backlog.map((i) => i.number);
    if (numbers.length === 0) return;
    setError(null);
    start(() => {
      bulkAddToQueueAction(repoId, numbers)
        .then(setIssues)
        .catch((e) => setError(e.message));
    });
  }

  function Row({ issue, reorderable }: { issue: Issue; reorderable: boolean }) {
    const allQueue = issues.filter(inQueue);
    const fullIdx = allQueue.findIndex((i) => i.number === issue.number);
    const isFirst = fullIdx === 0;
    const isLast = fullIdx === allQueue.length - 1;
    const labels = parseLabels(issue.labels).filter((l) => l !== queueLabel);
    const isDragging = dragNumber === issue.number;
    const isOver =
      overNumber === issue.number && dragNumber !== null && dragNumber !== issue.number;
    const isFlash = flash === issue.number;
    const selectId = `issue-select-${issue.number}`;

    function handleAddToQueue() {
      start(() => {
        addToQueueAction(repoId, issue.number)
          .then(setIssues)
          .catch((err: Error) => setError(err.message));
      });
    }

    function handleRemoveFromQueue() {
      start(() => {
        removeFromQueueAction(repoId, issue.number)
          .then(setIssues)
          .catch((err: Error) => setError(err.message));
      });
    }

    function handleMoveUp() {
      const newOrder = moveIssueUp(
        allQueue.map((i) => i.number),
        issue.number,
      );
      start(() => {
        reorderIssuesAction(repoId, newOrder).catch((err: Error) => setError(err.message));
      });
    }

    function handleMoveDown() {
      const newOrder = moveIssueDown(
        allQueue.map((i) => i.number),
        issue.number,
      );
      start(() => {
        reorderIssuesAction(repoId, newOrder).catch((err: Error) => setError(err.message));
      });
    }

    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: draggable issue row; the keyboard path is the per-row action buttons (open, +, up/down, remove) and the checkbox
      <div
        draggable
        onDragStart={(e) => {
          setDragNumber(issue.number);
          e.dataTransfer.effectAllowed = "move";
          try {
            e.dataTransfer.setData("text/plain", String(issue.number));
          } catch {}
        }}
        onDragEnter={() => setOverNumber(issue.number)}
        onDragOver={(e) => e.preventDefault()}
        onDragEnd={() => {
          setDragNumber(null);
          setOverNumber(null);
        }}
        onDrop={(e) => {
          e.stopPropagation();
          if (reorderable) reorderWithinQueue(issue.number);
        }}
        className={cn(
          "issue-row group flex items-center gap-3 rounded-lg border border-transparent bg-card px-3 py-2.5 hover-elevate",
          isDragging && "opacity-40",
          isOver && "ring-1 ring-primary/70",
          isFlash && "bg-success/[0.06] ring-1 ring-success/70",
        )}
      >
        <GripVertical
          aria-hidden
          className="h-[15px] w-[15px] shrink-0 cursor-grab text-muted-foreground/40 group-hover:text-muted-foreground active:cursor-grabbing"
        />
        <Checkbox
          id={selectId}
          checked={selected.has(issue.number)}
          onChange={() => toggleSelect(issue.number)}
          aria-label={`Select #${issue.number} for bulk actions`}
          className="shrink-0"
        />
        {reorderable && (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold tabular-nums text-primary-foreground">
            {fullIdx + 1}
          </span>
        )}
        <button
          type="button"
          onClick={() => setModalIssue(issue.number)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-ring"
        >
          <span className="shrink-0 font-mono text-xs text-muted-foreground">#{issue.number}</span>
          <span className="truncate text-sm group-hover:text-foreground">{issue.title}</span>
        </button>
        <div className="hidden shrink-0 items-center gap-1.5 md:flex">
          {issue.triagedAt && (
            <Tooltip content="Labels applied by auto-triage — see the issue comment for reasons">
              <Badge tone="primary">auto-triaged</Badge>
            </Tooltip>
          )}
          {labels.slice(0, 2).map((l) => (
            <span
              key={l}
              className="rounded-md bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground"
            >
              {l}
            </span>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {reorderable ? (
            <>
              <Button
                type="button"
                size="icon-sm"
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
                size="icon-sm"
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
                size="icon-sm"
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
              size="icon-sm"
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
      </div>
    );
  }

  const dropping = dragNumber !== null;

  function Zone({
    zone,
    icon: ZoneIcon,
    title,
    count,
    hint,
    empty,
    emptyDrop,
    onDrop,
    children,
    isEmpty,
  }: {
    zone: "queue" | "backlog";
    icon: typeof Inbox;
    title: string;
    count: number;
    hint: string;
    empty: string;
    emptyDrop: string;
    onDrop: () => void;
    children: React.ReactNode;
    isEmpty: boolean;
  }) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: drop zone for drag-and-drop; the keyboard path is the per-row action buttons (+, up/down, remove)
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (e.currentTarget === e.target) setOverNumber(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          onDrop();
        }}
        data-zone={zone}
        className={cn(
          "rounded-xl border p-2 transition-colors",
          dropping ? "border-dashed border-primary/45 bg-primary/[0.03]" : "border-card-border",
        )}
      >
        <div className="flex items-center gap-2 px-2 py-1.5">
          <ZoneIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-sm font-semibold">{title}</span>
          <Badge tone="neutral">{count}</Badge>
          <span className="ml-auto hidden text-xs text-muted-foreground sm:block">{hint}</span>
        </div>
        {isEmpty ? (
          <div
            className={cn(
              "m-1 rounded-lg border border-dashed px-3 py-6 text-center text-xs transition-colors",
              dropping ? "border-primary/50 text-primary" : "border-border text-muted-foreground",
            )}
          >
            {dropping ? emptyDrop : empty}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5 p-1">{children}</div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <GripVertical className="h-3.5 w-3.5" /> Drag to set priority, or drop an issue into the
          queue to schedule it.
        </p>
        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search issues by title or label"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter issues"
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || backlog.length === 0}
            onClick={queueAllFiltered}
          >
            <Inbox className="h-3.5 w-3.5" /> Queue all
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={manualSync}>
            <RefreshCw className={cn("h-3.5 w-3.5", pending && "dd-spin")} />
            {pending ? "Syncing…" : "Refresh"}
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {selected.size > 0 && (
        <div className="dd-fade-up flex flex-wrap items-center gap-2 rounded-xl border border-primary/40 bg-primary/[0.04] p-2">
          <span className="px-1 text-sm font-medium">{selected.size} selected</span>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => runBulk((numbers) => bulkAddToQueueAction(repoId, numbers))}
          >
            <Inbox className="h-3.5 w-3.5" /> Add to queue
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => runBulk((numbers) => bulkRemoveFromQueueAction(repoId, numbers))}
          >
            <X className="h-3.5 w-3.5" /> Remove from queue
          </Button>
          <span className="flex items-center gap-1.5">
            <Input
              aria-label="Label to apply to selected issues"
              value={bulkLabel}
              onChange={(e) => setBulkLabel(e.target.value)}
              placeholder="label…"
              className="h-8 w-28 text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={pending || bulkLabel.trim() === ""}
              onClick={() => {
                const label = bulkLabel.trim();
                runBulk((numbers) => bulkApplyLabelAction(repoId, numbers, label));
                setBulkLabel("");
              }}
            >
              <Tag className="h-3.5 w-3.5" /> Apply label
            </Button>
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={pending}
            onClick={clearSelection}
          >
            Clear
          </Button>
        </div>
      )}

      <Zone
        zone="queue"
        icon={Inbox}
        title="Queue"
        count={queue.length}
        hint="top = next to run"
        empty="Nothing queued. Drag an issue up from the backlog, or use the + button."
        emptyDrop="Drop here"
        onDrop={dropToQueue}
        isEmpty={queue.length === 0}
      >
        {queue.map((issue) => (
          <Row key={issue.number} issue={issue} reorderable />
        ))}
      </Zone>

      <Zone
        zone="backlog"
        icon={Wand2}
        title="Backlog · triage"
        count={backlog.length}
        hint="drag up to schedule"
        empty="Backlog is empty."
        emptyDrop="Drop here"
        onDrop={dropToBacklog}
        isEmpty={backlog.length === 0}
      >
        {backlog.map((issue) => (
          <Row key={issue.number} issue={issue} reorderable={false} />
        ))}
      </Zone>

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
