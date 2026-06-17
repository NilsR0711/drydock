import { ChartNoAxesColumn } from "lucide-react";
import { Suspense } from "react";
import { AnalyticsBreakdown } from "@/components/analytics-breakdown";
import { AnalyticsFilters } from "@/components/analytics-filters";
import { AnalyticsGroupSelect } from "@/components/analytics-group-select";
import { AnalyticsPanel } from "@/components/analytics-panel";
import { AnalyticsRangeSelect } from "@/components/analytics-range-select";
import { PageHeader } from "@/components/page-header";
import {
  type AnalyticsDimension,
  analyticsByDimension,
  analyticsSummary,
} from "@/lib/db/analytics-queries";
import { costByModel } from "@/lib/db/cost-queries";
import { listRepos } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

const DEFAULT_RANGE_DAYS = 30;

/** Maps the `group` URL param to an analytics dimension; undefined = no breakdown. */
const GROUP_TO_DIMENSION: Record<string, AnalyticsDimension> = {
  model: "model",
  agent: "agent",
  prompt: "promptVersion",
};

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
  const byModel = costByModel(undefined, repoId, since);

  const dimension = sp.group ? GROUP_TO_DIMENSION[sp.group] : undefined;
  const slices = dimension ? analyticsByDimension(dimension, { repoId, since }) : null;

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

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Suspense>
          <AnalyticsFilters repos={repos} />
        </Suspense>
        <Suspense>
          <AnalyticsGroupSelect />
        </Suspense>
      </div>

      <div className="space-y-6">
        <AnalyticsPanel summary={summary} costByModel={byModel} />
        {dimension && slices && <AnalyticsBreakdown dimension={dimension} slices={slices} />}
      </div>
    </div>
  );
}
