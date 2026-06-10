import { Activity, History, Moon } from "lucide-react";
import Link from "next/link";
import { type LogLine, LogViewer } from "@/components/log-viewer";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import type { Job } from "@/lib/db/schema";
import { modelLabel } from "@/lib/models";
import { formatUsd } from "@/lib/utils";

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
    <div className="space-y-5">
      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-3.5 w-3.5 text-muted-foreground" /> Live activity
        </h3>

        {activeJob ? (
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2">
              <Badge status={activeJob.status} />
              <Link
                href={`/jobs/${activeJob.id}`}
                className="font-mono text-xs text-muted-foreground hover:text-foreground"
              >
                #{activeJob.issueNumber}
              </Link>
              <Link
                href={`/jobs/${activeJob.id}`}
                className="ml-auto text-xs text-primary hover:underline"
              >
                Open live log →
              </Link>
            </div>
            <dl className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
              <div>Model: {modelLabel(activeJob.model)}</div>
              <div className="tnum">Cost: {formatUsd(activeJob.costUsd, 4)}</div>
              <div className="tnum">
                Tokens: {activeJob.totalInputTokens} in / {activeJob.totalOutputTokens} out
              </div>
            </dl>
            <LogViewer
              jobId={activeJob.id}
              initial={initialLog}
              active={["working", "ci_running", "retrying"].includes(activeJob.status)}
            />
          </div>
        ) : (
          <EmptyState
            compact
            icon={Moon}
            title="Idle"
            description="No job is running in this repo right now. Start an issue from the queue."
          />
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <History className="h-3.5 w-3.5 text-muted-foreground" /> Recent jobs
          </h3>
          {repoId !== undefined && (
            <Link
              href={`/jobs?repo=${repoId}`}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              View all runs →
            </Link>
          )}
        </div>
        {recentJobs.length === 0 ? (
          <EmptyState
            compact
            icon={History}
            title="No jobs yet"
            description="Finished runs will appear here once Drydock processes an issue."
          />
        ) : (
          <ul className="flex flex-col gap-0.5">
            {recentJobs.map((j) => (
              <li key={j.id}>
                <Link
                  href={`/jobs/${j.id}`}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover-elevate"
                >
                  <Badge status={j.status} className="shrink-0" />
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    #{j.issueNumber}
                  </span>
                  <span className="ml-auto tnum shrink-0 text-xs text-muted-foreground">
                    {formatUsd(j.costUsd)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
