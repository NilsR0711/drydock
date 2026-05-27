import { type LogLine, LogViewer } from "@/components/log-viewer";
import { Badge } from "@/components/ui/badge";
import type { Job } from "@/lib/db/schema";
import { modelLabel } from "@/lib/models";
import Link from "next/link";

export function RepoActivity({
  activeJob,
  recentJobs,
  initialLog = [],
}: {
  activeJob: Job | undefined;
  recentJobs: Job[];
  initialLog?: LogLine[];
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Aktivität</h2>

      {activeJob ? (
        <div className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
          <div className="flex items-center gap-2">
            <Link href={`/jobs/${activeJob.id}`} className="font-medium hover:underline">
              Job #{activeJob.id} · Issue #{activeJob.issueNumber}
            </Link>
            <Badge status={activeJob.status}>{activeJob.status}</Badge>
          </div>
          <dl className="grid grid-cols-2 gap-1 text-xs text-neutral-500">
            <div>Modell: {modelLabel(activeJob.model)}</div>
            <div>Kosten: ${activeJob.costUsd.toFixed(4)}</div>
            <div>
              Tokens: {activeJob.totalInputTokens} in / {activeJob.totalOutputTokens} out
            </div>
          </dl>
          <LogViewer jobId={activeJob.id} initial={initialLog} />
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          Kein Job läuft gerade. Starte ein Issue aus der Queue.
        </p>
      )}

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Verlauf
        </h3>
        <ul className="space-y-1">
          {recentJobs.map((j) => (
            <li key={j.id} className="flex items-center gap-2 text-sm">
              <Link href={`/jobs/${j.id}`} className="hover:underline">
                #{j.issueNumber}
              </Link>
              <Badge status={j.status}>{j.status}</Badge>
              <span className="ml-auto text-xs text-neutral-400">${j.costUsd.toFixed(2)}</span>
            </li>
          ))}
          {recentJobs.length === 0 && (
            <li className="text-sm text-neutral-500">Noch keine Jobs.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
