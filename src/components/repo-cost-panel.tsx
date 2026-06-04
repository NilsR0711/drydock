import { DollarSign } from "lucide-react";
import { BudgetMeter } from "@/components/ui/budget-gauge";
import { Sparkline } from "@/components/ui/sparkline";
import { formatUsd } from "@/lib/utils";

export function RepoCostPanel({
  todayUsd,
  limitUsd,
  daily,
}: {
  todayUsd: number;
  limitUsd: number;
  daily: { day: string; costUsd: number }[];
}) {
  const week = daily.slice(0, 7);
  const weekTotal = week.reduce((a, d) => a + d.costUsd, 0);
  // Oldest → newest so the sparkline trends left-to-right toward today.
  const series = [...week].reverse().map((d) => d.costUsd);

  return (
    <div className="flex flex-col gap-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <DollarSign className="h-3.5 w-3.5 text-muted-foreground" /> Cost
      </h3>

      <BudgetMeter value={todayUsd} limit={limitUsd} />

      {daily.length === 0 ? (
        <p className="text-sm text-muted-foreground">No spend recorded yet.</p>
      ) : (
        <>
          <div className="rounded-lg border border-border p-3">
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>Last 7 days</span>
              <span className="tnum">{formatUsd(weekTotal)}</span>
            </div>
            {series.length > 1 ? (
              <Sparkline data={series} width={320} height={42} tone="chart-1" />
            ) : (
              <p className="text-xs text-muted-foreground">Not enough data yet.</p>
            )}
          </div>
          <ul className="flex flex-col gap-1 text-sm">
            {week.map((d) => (
              <li
                key={d.day}
                className="flex justify-between border-b border-border/50 py-1.5 last:border-0"
              >
                <span className="text-muted-foreground">{d.day}</span>
                <span className="tnum">{formatUsd(d.costUsd)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
