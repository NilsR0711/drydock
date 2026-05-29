"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import type { RepoDashboardRow } from "@/lib/db/queries";
import { removeRepoAction } from "@/lib/repos/actions";
import { cn } from "@/lib/utils";

/** Compact "3m ago" style relative time; absolute date past a week. */
function relativeTime(epochSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - epochSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(epochSeconds * 1000).toLocaleDateString();
}

export function RepoStatusCard({ repo }: { repo: RepoDashboardRow }) {
  const [pending, start] = useTransition();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { success, error } = useToast();

  function remove() {
    start(async () => {
      try {
        await removeRepoAction(repo.id);
        success("Repository removed", repo.name);
      } catch (e) {
        error("Failed to remove repository", e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <Card
      className={cn(
        "hover-elevate transition-shadow hover:shadow-md",
        // Repos that want a human are bordered so they stand out in the grid.
        repo.attention && "border-destructive/50 bg-destructive/5",
      )}
    >
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link
              href={`/repos/${repo.id}`}
              className="font-mono text-sm font-semibold hover:underline"
            >
              {repo.name}
            </Link>
            <p className="truncate text-xs text-muted-foreground">{repo.path}</p>
          </div>
          {repo.attention && (
            <Badge tone="destructive" className="shrink-0">
              <AlertTriangle className="h-3 w-3" /> Needs human
            </Badge>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {repo.platform === "gitlab" && <Badge tone="primary">GitLab</Badge>}
          <Badge tone="neutral">{repo.queued} queued</Badge>
          {repo.working > 0 ? (
            <Badge status="working">{repo.working} working</Badge>
          ) : (
            <Badge tone="neutral">0 working</Badge>
          )}
          {repo.ciRunning > 0 ? (
            <Badge status="ci_running">{repo.ciRunning} CI</Badge>
          ) : (
            <Badge tone="neutral">0 CI</Badge>
          )}
          {repo.needsHuman > 0 && <Badge tone="destructive">{repo.needsHuman} needs human</Badge>}
        </div>

        {repo.inFlight.length > 0 && (
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {repo.inFlight.map((job) => (
              <li key={job.id} className="flex items-center gap-1.5">
                <Badge status={job.status} className="px-1.5 py-0" />
                <Link href={`/jobs/${job.id}`} className="font-mono hover:underline">
                  #{job.issueNumber}
                </Link>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Today:{" "}
            <span className="tabular-nums text-foreground">${repo.todaySpend.toFixed(2)}</span>
          </span>
          <span>{repo.lastActivityAt ? relativeTime(repo.lastActivityAt) : "no activity"}</span>
        </div>

        <div className="flex gap-2">
          <Link href={`/repos/${repo.id}`}>
            <Button size="sm">Open</Button>
          </Link>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setConfirmRemove(true)}
          >
            Remove
          </Button>
        </div>
      </CardContent>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        onConfirm={remove}
        title="Remove repository?"
        description={`This stops watching ${repo.name}. Existing jobs are unaffected.`}
        confirmLabel="Remove"
        variant="destructive"
        pending={pending}
      />
    </Card>
  );
}
