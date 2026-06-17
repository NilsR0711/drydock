import { Layers } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import type { AnalyticsDimension, AnalyticsSlice } from "@/lib/db/analytics-queries";
import { formatDurationSec } from "@/lib/format/duration";

/** Column header for the grouping dimension. */
const DIMENSION_LABELS: Record<AnalyticsDimension, string> = {
  model: "Model",
  agent: "Agent",
  promptVersion: "Prompt version",
};

/**
 * Per-slice outcome KPIs (issue #178): the same merge rate, time-to-merge, CI
 * retries, and cost-per-merge as the summary, grouped by model, agent, or
 * prompt version. Read-only; slices arrive busiest-first.
 */
export function AnalyticsBreakdown({
  dimension,
  slices,
}: {
  dimension: AnalyticsDimension;
  slices: AnalyticsSlice[];
}) {
  const label = DIMENSION_LABELS[dimension];

  return (
    <Card pad="lg">
      <h3 className="mb-4 text-base font-semibold">Outcomes by {label.toLowerCase()}</h3>
      {slices.length === 0 ? (
        <EmptyState
          compact
          icon={Layers}
          title="No jobs to break down"
          description="Outcome slices appear once jobs run in this window."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">
                  {label}
                </th>
                <th scope="col" className="py-2 px-3 text-right font-medium">
                  Jobs
                </th>
                <th scope="col" className="py-2 px-3 text-right font-medium">
                  Merged
                </th>
                <th scope="col" className="py-2 px-3 text-right font-medium">
                  Merge rate
                </th>
                <th scope="col" className="py-2 px-3 text-right font-medium">
                  Time to merge
                </th>
                <th scope="col" className="py-2 px-3 text-right font-medium">
                  CI retries
                </th>
                <th scope="col" className="py-2 pl-3 text-right font-medium">
                  Cost / merge
                </th>
              </tr>
            </thead>
            <tbody>
              {slices.map((s) => (
                <tr key={s.key} className="border-b border-border/60 last:border-0">
                  <td className="py-2 pr-3 font-medium text-foreground">{s.key}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{s.totalJobs}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{s.mergedJobs}</td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {s.completedJobs === 0 ? "—" : `${Math.round(s.mergeRate * 100)}%`}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {formatDurationSec(s.timeToMergeP50Sec)}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {s.completedJobs === 0 ? "—" : s.avgCiRetries.toFixed(1)}
                  </td>
                  <td className="py-2 pl-3 text-right tabular-nums">
                    {s.costPerMergedUsd === null ? "—" : `$${s.costPerMergedUsd.toFixed(2)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
