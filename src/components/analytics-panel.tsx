import {
  ChartNoAxesColumn,
  DollarSign,
  Gauge,
  GitMerge,
  ListChecks,
  RefreshCw,
  Timer,
} from "lucide-react";
import { BarList, type BarListItem } from "@/components/ui/bar-list";
import { Card } from "@/components/ui/card";
import { toneVar } from "@/components/ui/chart-utils";
import { ColumnChart } from "@/components/ui/column-chart";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import type { AnalyticsSummary } from "@/lib/db/analytics-queries";
import type { ModelCost } from "@/lib/db/cost-queries";
import { formatDurationSec } from "@/lib/format/duration";

/** Chart tones cycled across spend-by-model bars, in order. */
const MODEL_TONES = ["chart-1", "chart-5", "chart-2", "chart-4", "chart-3"] as const;

/** Outcome / throughput / cost-efficiency dashboard for the dock (issue #111). */
export function AnalyticsPanel({
  summary,
  costByModel,
}: {
  summary: AnalyticsSummary;
  costByModel: ModelCost[];
}) {
  const {
    totalJobs,
    completedJobs,
    mergedJobs,
    mergeRate,
    timeToMergeP50Sec,
    timeToMergeP90Sec,
    avgCiRetries,
    totalCostUsd,
    costPerMergedUsd,
    mergedPerDay,
    daily,
  } = summary;

  if (totalJobs === 0) {
    return (
      <Card pad="none" className="overflow-hidden">
        <EmptyState
          icon={ChartNoAxesColumn}
          title="No jobs in this window yet"
          description="Once Drydock runs jobs in the selected range, outcome and cost analytics appear here."
        />
      </Card>
    );
  }

  // ColumnChart renders oldest → newest left-to-right; `daily` is newest-first.
  // Spread into a plain indexable record so it satisfies the chart's prop type.
  const chronological = [...daily]
    .reverse()
    .map((d) => ({ day: d.day, completed: d.completed, merged: d.merged }));

  const modelBars: BarListItem[] = [...costByModel]
    .sort((a, b) => b.costUsd - a.costUsd)
    .map((m, i) => ({
      label: m.model,
      value: m.costUsd,
      tone: MODEL_TONES[i % MODEL_TONES.length],
    }));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          icon={GitMerge}
          label="Merge rate"
          value={`${Math.round(mergeRate * 100)}%`}
          sub={`${mergedJobs} of ${completedJobs}`}
          tone="success"
          active
        />
        <StatCard
          icon={Timer}
          label="Time to merge"
          value={formatDurationSec(timeToMergeP50Sec)}
          sub={`p90 ${formatDurationSec(timeToMergeP90Sec)}`}
        />
        <StatCard
          icon={RefreshCw}
          label="Avg CI retries"
          value={avgCiRetries.toFixed(1)}
          sub="per completed job"
        />
        <StatCard
          icon={Gauge}
          label="Throughput"
          value={mergedPerDay === null ? "—" : `${mergedPerDay.toFixed(1)}/d`}
          sub="merges per active day"
          tone="primary"
          active
        />
        <StatCard
          icon={DollarSign}
          label="Cost per merge"
          value={costPerMergedUsd === null ? "—" : `$${costPerMergedUsd.toFixed(2)}`}
          sub={`$${totalCostUsd.toFixed(0)} total`}
          tone="primary"
          active
        />
        <StatCard
          icon={ListChecks}
          label="Jobs"
          value={totalJobs}
          sub={`${completedJobs} completed`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" pad="lg">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-base font-semibold">Daily throughput</h3>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-secondary" /> Completed
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 rounded-sm"
                  style={{ background: toneVar("chart-2") }}
                />{" "}
                Merged
              </span>
            </div>
          </div>
          {chronological.length === 0 ? (
            <EmptyState
              compact
              icon={ChartNoAxesColumn}
              title="No completed jobs"
              description="Daily throughput appears once jobs finish in this window."
            />
          ) : (
            <ColumnChart data={chronological} height={150} />
          )}
        </Card>

        <Card pad="lg">
          <h3 className="mb-4 text-base font-semibold">Spend by model</h3>
          {modelBars.length === 0 ? (
            <EmptyState
              compact
              icon={DollarSign}
              title="No spend yet"
              description="Model costs appear once jobs run in this window."
            />
          ) : (
            <BarList items={modelBars} money />
          )}
        </Card>
      </div>
    </div>
  );
}
