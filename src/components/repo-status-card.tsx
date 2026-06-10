"use client";

import { Clock, DollarSign, FolderGit2, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RelativeTime } from "@/components/ui/relative-time";
import { useToast } from "@/components/ui/toast";
import type { RepoDashboardRow } from "@/lib/db/queries";
import { removeRepoAction } from "@/lib/repos/actions";
import { cn, formatUsd } from "@/lib/utils";

export function RepoStatusCard({ repo }: { repo: RepoDashboardRow }) {
  const [pending, start] = useTransition();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { success, error } = useToast();

  const active = repo.working + repo.ciRunning > 0;

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
      hover
      // Repos that want a human are bordered so they stand out in the grid.
      className={cn(
        "flex flex-col gap-3 p-4",
        repo.attention && "border-destructive/40 bg-destructive/[0.04]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/repos/${repo.id}`}
          className="group flex min-w-0 items-center gap-2 rounded-md text-left focus-ring"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
            <FolderGit2 className="h-[15px] w-[15px]" />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-mono text-sm font-semibold group-hover:underline">
              {repo.name}
            </span>
            <span className="block truncate text-xs text-muted-foreground">{repo.path}</span>
          </span>
        </Link>
        {repo.attention ? (
          <Badge tone="destructive" className="shrink-0">
            <TriangleAlert className="h-[11px] w-[11px]" /> Needs human
          </Badge>
        ) : active ? (
          <Badge status="working" className="shrink-0">
            Active
          </Badge>
        ) : (
          <Badge tone="neutral" className="shrink-0">
            Idle
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
        <ul className="flex flex-col gap-1 border-t border-card-border pt-2.5 text-xs">
          {repo.inFlight.slice(0, 3).map((job) => (
            <li key={job.id} className="flex items-center gap-2">
              <Badge status={job.status} className="shrink-0 px-1.5 py-0" />
              <Link
                href={`/jobs/${job.id}`}
                className="truncate text-muted-foreground transition-colors hover:text-foreground"
              >
                <span className="font-mono text-foreground/80">#{job.issueNumber}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto flex items-center justify-between border-t border-card-border pt-2.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <DollarSign className="h-3 w-3" />
          <span className="tnum text-foreground/90">{formatUsd(repo.todaySpend)}</span> today
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Clock className="h-3 w-3" />
          <RelativeTime ts={repo.lastActivityAt} />
        </span>
      </div>

      <div className="flex gap-2">
        <Link href={`/repos/${repo.id}`}>
          <Button size="sm">Open workspace</Button>
        </Link>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => setConfirmRemove(true)}
          aria-label="Remove repository"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

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
