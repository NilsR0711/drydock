import { ListChecks } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { JobsHistoryFilters } from "@/components/jobs-history-filters";
import { JobsHistoryPagination } from "@/components/jobs-history-pagination";
import { JobsLiveRefresh } from "@/components/jobs-live-refresh";
import { LiveDuration } from "@/components/live-duration";
import { LogMatchSnippet } from "@/components/log-match-snippet";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { listJobsPage, listRepos } from "@/lib/db/queries";
import { MODELS, modelLabel } from "@/lib/models";
import { formatUsd, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

export default async function JobsIndexPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? "1") || 1);
  const repoId = sp.repo ? Number(sp.repo) : undefined;
  const status = sp.status || undefined;
  const model = sp.model || undefined;
  const search = sp.q || undefined;
  const searchScope = sp.scope === "logs" ? "logs" : undefined;

  const repos = listRepos();
  const result = listJobsPage({
    page,
    pageSize: PAGE_SIZE,
    repoId,
    status,
    model,
    search,
    searchScope,
  });

  // Single render-time clock seeds every in-flight row's live duration ticker so
  // SSR and the first client render agree (issue #282).
  const nowSec = Math.floor(Date.now() / 1000);

  return (
    <div className="dd-fade-up">
      <JobsLiveRefresh />
      <PageHeader
        title="Job history"
        subtitle={`Every run Drydock has executed, newest first — ${result.total} job${
          result.total !== 1 ? "s" : ""
        } across all repos.`}
        icon={ListChecks}
      />

      <div className="mb-4">
        <Suspense>
          <JobsHistoryFilters
            repos={repos.map((r) => ({ id: r.id, name: r.name }))}
            models={MODELS.map((m) => ({ id: m.id, label: m.label }))}
          />
        </Suspense>
      </div>

      {result.rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={ListChecks}
            title="No jobs match"
            description="Try a different status, model, or repository filter."
          />
        </Card>
      ) : (
        <Card pad="none" className="overflow-hidden">
          <div className="hidden grid-cols-[1fr_auto_auto_auto_auto] gap-4 border-b border-card-border px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:grid">
            <span>Issue</span>
            <span className="text-right">Model</span>
            <span className="text-right">Cost</span>
            <span className="text-right">Duration</span>
            <span className="text-right">Created</span>
          </div>
          <ul>
            {result.rows.map((row) => {
              // In-flight rows keep elapsing; LiveDuration ticks them client-side
              // so the column stays current between server refreshes (issue #282).
              const isActive = ["working", "ci_running", "retrying"].includes(row.status);
              return (
                <li key={row.id}>
                  <Link
                    href={`/jobs/${row.id}`}
                    className="grid w-full grid-cols-1 gap-1 border-b border-card-border/60 px-4 py-3 text-left last:border-0 hover-elevate focus-ring sm:grid-cols-[1fr_auto_auto_auto_auto] sm:items-center sm:gap-4"
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-2.5">
                        <Badge status={row.status} className="shrink-0" />
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          {row.repoName}{" "}
                          {row.kind === "release" ? "Release" : `#${row.issueNumber}`}
                        </span>
                        {row.issueTitle && (
                          <span className="truncate text-sm">{row.issueTitle}</span>
                        )}
                      </span>
                      {row.logSnippet && (
                        <LogMatchSnippet
                          snippet={row.logSnippet}
                          className="truncate pl-0.5 font-mono text-xs text-muted-foreground"
                        />
                      )}
                    </span>
                    <span className="hidden text-right font-mono text-xs text-muted-foreground sm:block">
                      {modelLabel(row.model)}
                    </span>
                    <span className="hidden text-right text-sm tnum sm:block">
                      {formatUsd(row.costUsd)}
                    </span>
                    <LiveDuration
                      startedAt={row.startedAt}
                      finishedAt={row.finishedAt}
                      active={isActive}
                      nowSec={nowSec}
                      className="hidden text-right text-sm text-muted-foreground tnum sm:block"
                    />
                    <span className="hidden text-right text-xs text-muted-foreground sm:block">
                      {relativeTime(row.createdAt)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <div className="mt-4">
        <Suspense>
          <JobsHistoryPagination page={result.page} totalPages={result.totalPages} />
        </Suspense>
      </div>
    </div>
  );
}
