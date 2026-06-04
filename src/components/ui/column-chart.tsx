import type * as React from "react";
import { toneVar } from "./chart-utils";

export interface ColumnChartProps {
  data: Array<Record<string, React.ReactNode>>;
  height?: number;
  valueKey?: string;
  compareKey?: string;
  labelKey?: string;
}

/**
 * Daily-throughput columns: a muted "compare" bar (e.g. completed) with the
 * tonal "value" bar (e.g. merged) overlaid in chart-2.
 */
export function ColumnChart({
  data,
  height = 120,
  valueKey = "merged",
  compareKey = "completed",
  labelKey = "day",
}: ColumnChartProps) {
  const num = (v: React.ReactNode) => (typeof v === "number" ? v : 0);
  const max = Math.max(...data.map((d) => num(d[compareKey]) || num(d[valueKey])), 1);
  return (
    <div className="flex items-end gap-2" style={{ height: height + 24 }}>
      {data.map((d, i) => {
        const compare = num(d[compareKey]);
        const value = num(d[valueKey]);
        const hC = (compare / max) * height;
        const hV = (value / max) * height;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: bars track positional data
          <div key={i} className="group flex flex-1 flex-col items-center gap-1.5">
            <div className="relative flex w-full justify-center" style={{ height }}>
              <div
                className="absolute bottom-0 w-full max-w-[26px] rounded-md bg-secondary"
                style={{ height: hC }}
                title={`${compare} completed`}
              />
              <div
                className="absolute bottom-0 w-full max-w-[26px] origin-bottom rounded-md"
                style={{ height: hV, backgroundColor: toneVar("chart-2") }}
                title={`${value} merged`}
              />
            </div>
            <span className="text-[10px] text-muted-foreground tnum">{d[labelKey]}</span>
          </div>
        );
      })}
    </div>
  );
}
