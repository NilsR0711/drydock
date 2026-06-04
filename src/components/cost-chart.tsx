import { BarList } from "@/components/ui/bar-list";
import type { DailyCost } from "@/lib/db/cost-queries";

/**
 * Daily-cost chart. Replaces the former recharts bar chart with the dark-first
 * BarList primitive: one proportional bar per day, chronological, with a tabular
 * USD value column.
 */
export function CostChart({ data }: { data: DailyCost[] }) {
  const chronological = [...data].reverse();
  return (
    <BarList
      items={chronological.map((d) => ({ label: d.day, value: d.costUsd, tone: "chart-1" }))}
      money
    />
  );
}
