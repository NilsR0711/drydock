import { Suspense } from "react";
import { AnalyticsFilters } from "@/components/analytics-filters";
import { AnalyticsPanel } from "@/components/analytics-panel";
import { analyticsSummary } from "@/lib/db/analytics-queries";
import { listRepos } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

const DEFAULT_RANGE_DAYS = 30;

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const repoId = sp.repo ? Number(sp.repo) : undefined;
  const range = sp.range ?? String(DEFAULT_RANGE_DAYS);
  const since =
    range === "all"
      ? undefined
      : Math.floor(Date.now() / 1000) - (Number(range) || DEFAULT_RANGE_DAYS) * 86_400;

  const repos = listRepos().map((r) => ({ id: r.id, name: r.name }));
  const summary = analyticsSummary({ repoId, since });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">
          Outcome, throughput, and cost-efficiency of your autonomous runs.
        </p>
      </div>

      <Suspense>
        <AnalyticsFilters repos={repos} />
      </Suspense>

      <AnalyticsPanel summary={summary} />
    </div>
  );
}
