import { DollarSign } from "lucide-react";
import { BudgetMeter } from "@/components/ui/budget-gauge";
import { EmptyState } from "@/components/ui/empty-state";
import { Sparkline } from "@/components/ui/sparkline";
import { formatUsd } from "@/lib/utils";

/** The last 7 calendar days (local time), oldest → newest, as YYYY-MM-DD. */
function last7Days(): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    out.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")}`,
    );
  }
  return out;
}

export function RepoCostPanel({
  todayUsd,
  limitUsd,
  daily,
}: {
  todayUsd: number;
  limitUsd: number;
  daily: { day: string; costUsd: number }[];
}) {
  // Zero-fill 7 calendar days so quiet days appear and the window matches the
  // "Last 7 days" label (oldest → newest; the list renders newest first).
  const byDay = new Map(daily.map((d) => [d.day, d.costUsd]));
  const days = last7Days();
  const week = [...days].reverse().map((day) => ({ day, costUsd: byDay.get(day) ?? 0 }));
  const weekTotal = week.reduce((a, d) => a + d.costUsd, 0);
  const series = days.map((day) => byDay.get(day) ?? 0);

  return (
    <div className="flex flex-col gap-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <DollarSign className="h-3.5 w-3.5 text-muted-foreground" /> Cost
      </h3>

      <BudgetMeter value={todayUsd} limit={limitUsd} />

      {daily.length === 0 && todayUsd === 0 ? (
        <EmptyState
          compact
          icon={DollarSign}
          title="No spend yet"
          description="Costs appear here once jobs run in this repo."
        />
      ) : (
        <>
          <div className="rounded-lg border border-border p-3">
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>Last 7 days</span>
              <span className="tnum">{formatUsd(weekTotal)}</span>
            </div>
            {series.length > 1 ? (
              <Sparkline data={series} width={320} height={42} tone="chart-1" average />
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
