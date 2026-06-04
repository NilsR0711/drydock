import type * as React from "react";
import { cn } from "@/lib/utils";
import { toneVar } from "./chart-utils";

export interface BarListItem {
  label: React.ReactNode;
  value: number;
  tone?: string;
}

export interface BarListProps {
  items: BarListItem[];
  unit?: string;
  money?: boolean;
  max?: number;
  className?: string;
}

/** Horizontal proportional bars with a tabular value column. */
export function BarList({ items, unit = "", money, max, className }: BarListProps) {
  const top = max || Math.max(...items.map((i) => i.value), 1);
  const fmt = (v: number) => (money ? `$${v.toFixed(2)}` : `${v}${unit}`);
  return (
    <ul className={cn("flex flex-col gap-2.5", className)}>
      {items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: list order is stable for a render
        <li key={i} className="grid grid-cols-[1fr_auto] items-center gap-3">
          <div className="min-w-0">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="truncate text-[13px] text-foreground">{it.label}</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="dd-bar h-full rounded-full"
                style={{
                  width: `${(it.value / top) * 100}%`,
                  backgroundColor: toneVar(it.tone || "chart-1"),
                  animationDelay: `${i * 70}ms`,
                }}
              />
            </div>
          </div>
          <span className="tnum text-sm font-medium text-foreground tabular-nums">
            {fmt(it.value)}
          </span>
        </li>
      ))}
    </ul>
  );
}
