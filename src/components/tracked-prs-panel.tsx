"use client";

import { ExternalLink, GitPullRequest, Plus, X } from "lucide-react";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { RelativeTime } from "@/components/ui/relative-time";
import type { TrackedPr } from "@/lib/db/schema";
import { addTrackedPrAction, untrackPrAction } from "@/lib/tracked-prs/actions";

const STATUS_TONE: Record<string, "primary" | "success" | "destructive" | "neutral" | "warning"> = {
  tracking: "primary",
  merged: "success",
  needs_human: "destructive",
  closed: "neutral",
  stopped: "neutral",
};

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

export function TrackedPrsPanel({
  repoId,
  initialPrs,
}: {
  repoId: number;
  initialPrs: TrackedPr[];
}) {
  const [prs, setPrs] = useState(initialPrs);
  const [url, setUrl] = useState("");
  const [autoMerge, setAutoMerge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function add() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    start(async () => {
      try {
        const tracked = await addTrackedPrAction(repoId, trimmed, autoMerge);
        setPrs((prev) => [tracked, ...prev.filter((p) => p.id !== tracked.id)]);
        setUrl("");
        setAutoMerge(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "could not track that PR");
      }
    });
  }

  function untrack(id: number) {
    setError(null);
    start(async () => {
      try {
        const updated = await untrackPrAction(repoId, id);
        setPrs((prev) => prev.map((p) => (p.id === id ? updated : p)));
      } catch (err) {
        setError(err instanceof Error ? err.message : "could not stop tracking that PR");
      }
    });
  }

  const active = prs.filter((p) => p.status !== "stopped");

  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-col gap-3 sm:flex-row sm:items-end" action={() => add()}>
        <div className="flex flex-1 flex-col gap-1.5">
          <label htmlFor="track-pr-url" className="text-sm font-medium">
            Add a PR by URL
          </label>
          <Input
            id="track-pr-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repo/pull/123"
            disabled={pending}
          />
        </div>
        <span className="flex items-center gap-2 pb-2 text-sm">
          <Checkbox
            checked={autoMerge}
            onChange={setAutoMerge}
            aria-label="Auto-merge when green"
          />
          Auto-merge
        </span>
        <Button type="submit" disabled={pending || !url.trim()}>
          <Plus className="h-4 w-4" /> Track
        </Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}

      {active.length === 0 ? (
        <EmptyState
          icon={GitPullRequest}
          title="No tracked PRs"
          description="Paste a pull request URL above to have Drydock watch its CI and reviews."
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {active.map((pr) => (
            <li key={pr.id} className="flex items-center gap-3 px-3 py-2.5">
              <GitPullRequest className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-sm font-medium hover:underline"
                  >
                    #{pr.prNumber} {pr.title ?? ""}
                  </a>
                  <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {pr.author && <span>by {pr.author}</span>}
                  {pr.isFork && <Badge tone="neutral">fork</Badge>}
                  {pr.autoMerge && <Badge tone="warning">auto-merge</Badge>}
                  <span>
                    updated <RelativeTime ts={pr.updatedAt} />
                  </span>
                  {pr.lastError && (
                    <span className="truncate text-destructive">{pr.lastError}</span>
                  )}
                </div>
              </div>
              <Badge tone={STATUS_TONE[pr.status] ?? "neutral"} className="capitalize">
                {statusLabel(pr.status)}
              </Badge>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Stop tracking"
                disabled={pending}
                onClick={() => untrack(pr.id)}
              >
                <X className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
