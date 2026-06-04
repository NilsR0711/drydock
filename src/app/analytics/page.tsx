import { ChartNoAxesColumn } from "lucide-react";
import { Suspense } from "react";
import { AnalyticsFilters } from "@/components/analytics-filters";
import { AnalyticsPanel } from "@/components/analytics-panel";
import { AnalyticsRangeSelect } from "@/components/analytics-range-select";
import { PageHeader } from "@/components/page-header";
import { analyticsSummary } from "@/lib/db/analytics-queries";
import { costByModel } from "@/lib/db/cost-queries";
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
  const byModel = costByModel(undefined, repoId);

  return (
    <div className="dd-fade-up">
      <PageHeader
        icon={ChartNoAxesColumn}
        title="Analytics"
        subtitle="Outcome, throughput, and cost-efficiency across all repositories."
        actions={
          <Suspense>
            <AnalyticsRangeSelect />
          </Suspense>
        }
      />

      <div className="mb-4">
        <Suspense>
          <AnalyticsFilters repos={repos} />
        </Suspense>
      </div>

      <AnalyticsPanel summary={summary} costByModel={byModel} />
    </div>
  );
}
