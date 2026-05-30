import Link from "next/link";
import { type LogLine, LogViewer } from "@/components/log-viewer";
import { Badge } from "@/components/ui/badge";
import type { Job } from "@/lib/db/schema";
import { modelLabel } from "@/lib/models";

export function RepoActivity({
  activeJob,
  recentJobs,
  initialLog = [],
  repoId,
}: {
  activeJob: Job | undefined;
  recentJobs: Job[];
  initialLog?: LogLine[];
  repoId?: number;
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Activity
      </h2>

      {activeJob ? (
        <div className="space-y-3 rounded-xl border border-card-border bg-card p-4">
          <div className="flex items-center gap-2">
            <Link href={`/jobs/${activeJob.id}`} className="font-medium hover:underline">
              Job #{activeJob.id} · Issue #{activeJob.issueNumber}
            </Link>
            <Badge status={activeJob.status}>{activeJob.status}</Badge>
          </div>
          <dl className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
            <div>Model: {modelLabel(activeJob.model)}</div>
            <div>Cost: ${activeJob.costUsd.toFixed(4)}</div>
            <div>
              Tokens: {activeJob.totalInputTokens} in / {activeJob.totalOutputTokens} out
            </div>
          </dl>
          <LogViewer jobId={activeJob.id} initial={initialLog} />
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No job is running. Start an issue from the queue.
        </p>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            History
          </h3>
          {repoId !== undefined && (
            <Link
              href={`/jobs?repo=${repoId}`}
              className="text-xs text-muted-foreground hover:underline"
            >
              View all runs →
            </Link>
          )}
        </div>
        <ul className="space-y-1">
          {recentJobs.map((j) => (
            <li key={j.id} className="flex items-center gap-2 text-sm">
              <Link href={`/jobs/${j.id}`} className="hover:underline">
                #{j.issueNumber}
              </Link>
              <Badge status={j.status}>{j.status}</Badge>
              <span className="ml-auto text-xs text-muted-foreground">${j.costUsd.toFixed(2)}</span>
            </li>
          ))}
          {recentJobs.length === 0 && (
            <li className="text-sm text-muted-foreground">No jobs yet.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
