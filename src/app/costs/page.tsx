import { DollarSign, ListChecks } from "lucide-react";
import { CostExportControls } from "@/components/cost-export-controls";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { BarList } from "@/components/ui/bar-list";
import { BudgetGauge, BudgetMeter } from "@/components/ui/budget-gauge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Sparkline } from "@/components/ui/sparkline";
import {
  costByModel,
  dailyCosts,
  monthCost,
  projectMonthlySpend,
  todayCost,
  topJobs,
} from "@/lib/db/cost-queries";
import { listRepos } from "@/lib/db/queries";
import { getSettings } from "@/lib/settings/service";
import { formatUsd } from "@/lib/utils";

export const dynamic = "force-dynamic";

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

export default function CostsPage() {
  const daily = dailyCosts();
  const byModel = costByModel();
  const top = topJobs(10);
  const repos = listRepos().map((r) => ({ id: r.id, name: r.name }));
  const spendToday = todayCost();
  const spendMonth = monthCost();
  const settings = getSettings();
  const spendLimit = settings.dailyCostLimitUsd;
  const monthlyLimit = settings.monthlyCostLimitUsd;

  // Last 7 calendar days, zero-filled so quiet days still appear (matches the
  // dashboard trend). `days` is oldest → newest; the list renders newest first.
  const byDay = new Map(daily.map((d) => [d.day, d.costUsd]));
  const days = last7Days();
  const last7 = [...days].reverse().map((day) => ({ day, costUsd: byDay.get(day) ?? 0 }));
  const total7 = last7.reduce((sum, d) => sum + d.costUsd, 0);
  const sparkData = days.map((day) => byDay.get(day) ?? 0);

  // Forward-looking spend (issue #413): project end-of-month spend from the
  // trailing-7-day run rate, and surface how far into today's budget we already
  // are so the operator sees the daily gate coming before it trips. Server-
  // rendered `now` is local time, matching the DB's `localtime` cost windows.
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projection = projectMonthlySpend({
    monthToDate: spendMonth,
    trailing7Total: total7,
    dayOfMonth: now.getDate(),
    daysInMonth,
  });
  const overBudget = monthlyLimit > 0 && projection.projected > monthlyLimit;
  const dailyPacePct = spendLimit > 0 ? Math.round((spendToday / spendLimit) * 100) : null;
  const nowHhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(
    2,
    "0",
  )}`;

  const modelItems = byModel
    .filter((m) => m.costUsd > 0)
    .map((m) => ({ label: m.model.replace("claude-", ""), value: m.costUsd, tone: "chart-2" }));

  const topItems = top
    .filter((j) => j.costUsd > 0)
    .map((j) => ({
      label: `#${j.issueNumber} · job ${j.id}`,
      value: j.costUsd,
      tone: "chart-1",
    }));

  return (
    <div className="dd-fade-up">
      <PageHeader
        title="Costs"
        subtitle="Agent spend across every repository, against your daily and monthly budgets — with a month-end projection."
        icon={DollarSign}
        actions={<CostExportControls repos={repos} />}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card pad="lg" className="flex flex-col gap-4">
          <div>
            <h3 className="mb-4 text-base font-semibold">Today&apos;s budget</h3>
            <div className="flex items-center justify-center">
              <BudgetGauge value={spendToday} limit={spendLimit} size={150} />
            </div>
            {dailyPacePct !== null && (
              <p className="mt-3 text-center text-xs text-muted-foreground tnum">
                {dailyPacePct}% of today&apos;s budget consumed by {nowHhmm}
              </p>
            )}
          </div>

          <div className="border-t border-card-border pt-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold">This month</h3>
              {overBudget && <Badge tone="destructive">Over budget</Badge>}
            </div>
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">Spent so far</span>
              <span className="tnum font-semibold">{formatUsd(spendMonth)}</span>
            </div>
            <div className="mt-1.5 flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">Projected</span>
              <span
                className="tnum font-semibold"
                style={overBudget ? { color: "hsl(var(--destructive))" } : undefined}
              >
                ~{formatUsd(projection.projected)}
              </span>
            </div>
            {monthlyLimit > 0 ? (
              <div className="mt-3">
                <BudgetMeter value={spendMonth} limit={monthlyLimit} />
                <p
                  className="mt-1.5 text-xs"
                  style={{
                    color: overBudget ? "hsl(var(--destructive))" : "hsl(var(--muted-foreground))",
                  }}
                >
                  {overBudget
                    ? `Trailing run rate projects over your ${formatUsd(monthlyLimit)} monthly budget`
                    : `On track against your ${formatUsd(monthlyLimit)} monthly budget`}
                </p>
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                Projected from the trailing 7-day average. Set a monthly budget in Settings to gate
                spend.
              </p>
            )}
          </div>
        </Card>

        <Card pad="lg">
          <h3 className="mb-4 text-base font-semibold">By model</h3>
          {modelItems.length === 0 ? (
            <EmptyState
              compact
              icon={DollarSign}
              title="No spend yet"
              description="Costs appear here once jobs start running."
            />
          ) : (
            <BarList items={modelItems} money />
          )}
          <div className="mt-4 border-t border-card-border pt-3">
            <h4 className="mb-2 text-sm font-semibold text-muted-foreground">Top jobs</h4>
            {topItems.length === 0 ? (
              <EmptyState
                compact
                icon={ListChecks}
                title="No job costs yet"
                description="Jobs with recorded cost will rank here."
              />
            ) : (
              <BarList items={topItems} money />
            )}
          </div>
        </Card>

        <Card pad="lg">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-base font-semibold">Last 7 days</h3>
            <span className="tnum text-sm font-semibold">{formatUsd(total7)}</span>
          </div>
          {daily.length === 0 && spendToday === 0 ? (
            <EmptyState
              compact
              icon={DollarSign}
              title="No cost data yet"
              description="Daily spend will be charted here."
            />
          ) : (
            <>
              <Sparkline data={sparkData} width={300} height={56} tone="chart-1" average />
              <ul className="mt-3 flex flex-col gap-1 text-sm">
                {last7.map((d) => (
                  <li
                    key={d.day}
                    className="flex items-center justify-between border-b border-border/50 py-1.5 last:border-0"
                  >
                    <span className="text-muted-foreground">{d.day}</span>
                    <span className="tnum">{formatUsd(d.costUsd)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
