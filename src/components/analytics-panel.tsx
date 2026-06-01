import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AnalyticsSummary } from "@/lib/db/analytics-queries";
import { formatDurationSec } from "@/lib/format/duration";

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-card-border bg-card px-4 py-3 shadow-sm">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** Outcome / throughput / cost-efficiency dashboard for the dock (issue #111). */
export function AnalyticsPanel({ summary }: { summary: AnalyticsSummary }) {
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
      <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        No jobs in this window yet.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Metric
          label="Merge rate"
          value={`${Math.round(mergeRate * 100)}%`}
          sub={`${mergedJobs} of ${completedJobs} completed`}
        />
        <Metric
          label="Time to merge (p50)"
          value={formatDurationSec(timeToMergeP50Sec)}
          sub={`p90 ${formatDurationSec(timeToMergeP90Sec)}`}
        />
        <Metric label="Avg CI retries" value={avgCiRetries.toFixed(1)} sub="per completed job" />
        <Metric
          label="Throughput"
          value={mergedPerDay === null ? "—" : `${mergedPerDay.toFixed(1)}/day`}
          sub="merges per active day"
        />
        <Metric
          label="Cost per merge"
          value={costPerMergedUsd === null ? "—" : `$${costPerMergedUsd.toFixed(2)}`}
          sub={`$${totalCostUsd.toFixed(2)} total`}
        />
        <Metric label="Jobs" value={String(totalJobs)} sub={`${completedJobs} completed`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Daily throughput</CardTitle>
        </CardHeader>
        <CardContent>
          {daily.length === 0 ? (
            <p className="text-sm text-muted-foreground">No completed jobs in this window.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="py-2">Day</th>
                  <th className="py-2 text-right">Completed</th>
                  <th className="py-2 text-right">Merged</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((d) => (
                  <tr key={d.day} className="border-b border-border/50 last:border-0">
                    <td className="py-2 font-mono text-muted-foreground">{d.day}</td>
                    <td className="py-2 text-right tabular-nums">{d.completed}</td>
                    <td className="py-2 text-right tabular-nums">{d.merged}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
