import Link from "next/link";
import { Suspense } from "react";
import { JobsHistoryFilters } from "@/components/jobs-history-filters";
import { JobsHistoryPagination } from "@/components/jobs-history-pagination";
import { Badge } from "@/components/ui/badge";
import { listJobsPage, listRepos } from "@/lib/db/queries";
import { MODELS, modelLabel } from "@/lib/models";

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

  const repos = listRepos();
  const result = listJobsPage({ page, pageSize: PAGE_SIZE, repoId, status, model, search });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Job history</h1>
          <p className="text-sm text-muted-foreground">
            {result.total} job{result.total !== 1 ? "s" : ""} across all repos
          </p>
        </div>
      </div>

      <Suspense>
        <JobsHistoryFilters
          repos={repos.map((r) => ({ id: r.id, name: r.name }))}
          models={MODELS.map((m) => ({ id: m.id, label: m.label }))}
        />
      </Suspense>

      {result.rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No jobs match the current filters.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5">Job</th>
                <th className="px-4 py-2.5">Repo</th>
                <th className="px-4 py-2.5">Issue</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Model</th>
                <th className="px-4 py-2.5">Cost</th>
                <th className="px-4 py-2.5">Created</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={row.id} className={i % 2 === 0 ? "bg-background" : "bg-secondary/20"}>
                  <td className="px-4 py-2.5 font-mono">
                    <Link href={`/jobs/${row.id}`} className="hover:underline">
                      #{row.id}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    <Link href={`/repos/${row.repoId}`} className="hover:underline">
                      {row.repoName}
                    </Link>
                  </td>
                  <td className="max-w-xs px-4 py-2.5">
                    <span className="font-mono text-muted-foreground">#{row.issueNumber}</span>
                    {row.issueTitle && (
                      <span className="ml-1.5 truncate text-foreground">{row.issueTitle}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge status={row.status} />
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{modelLabel(row.model)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    ${row.costUsd.toFixed(4)}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {new Date(row.createdAt * 1000).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Suspense>
        <JobsHistoryPagination page={result.page} totalPages={result.totalPages} />
      </Suspense>
    </div>
  );
}
