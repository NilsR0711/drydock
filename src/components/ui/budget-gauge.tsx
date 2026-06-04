import { cn } from "@/lib/utils";
import { Badge } from "./badge";
import { toneVar } from "./chart-utils";

export interface BudgetGaugeProps {
  value: number;
  limit: number;
  size?: number;
  label?: string;
}

/** 270° radial spend gauge: primary → warning → destructive as the limit nears. */
export function BudgetGauge({ value, limit, size = 132, label = "Spend today" }: BudgetGaugeProps) {
  const ratio = Math.min(value / limit, 1);
  const over = value >= limit;
  const tone = over || ratio >= 0.95 ? "destructive" : ratio >= 0.8 ? "warning" : "primary";
  const color = toneVar(tone);
  const r = (size - 18) / 2;
  const c = 2 * Math.PI * r;
  const sweep = 0.75; // 270°
  const trackLen = c * sweep;
  const valueLen = trackLen * ratio;
  const cx = size / 2;
  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size * 0.82 }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          style={{ transform: "rotate(135deg)" }}
          role="img"
          aria-label={`${label}: $${value.toFixed(2)} of $${limit.toFixed(0)} limit`}
        >
          <circle
            cx={cx}
            cy={cx}
            r={r}
            fill="none"
            stroke="hsl(var(--secondary))"
            strokeWidth={9}
            strokeDasharray={`${trackLen} ${c}`}
            strokeLinecap="round"
          />
          <circle
            cx={cx}
            cy={cx}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={9}
            strokeDasharray={`${valueLen} ${c}`}
            strokeLinecap="round"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center pb-1">
          <span className="tnum text-[26px] font-semibold leading-none" style={{ color }}>
            ${value.toFixed(2)}
          </span>
          <span className="mt-1 text-xs text-muted-foreground tnum">
            of ${limit.toFixed(0)} limit
          </span>
        </div>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-xs">
        {over ? (
          <Badge tone="destructive">Limit reached</Badge>
        ) : ratio >= 0.8 ? (
          <Badge tone="warning">{Math.round(ratio * 100)}% used</Badge>
        ) : (
          <span className="text-muted-foreground">
            {label} · {Math.round(ratio * 100)}% of budget
          </span>
        )}
      </div>
    </div>
  );
}

export interface BudgetMeterProps {
  value: number;
  limit: number;
}

/** Compact linear budget meter for the per-repo cost panel. */
export function BudgetMeter({ value, limit }: BudgetMeterProps) {
  const ratio = Math.min(value / limit, 1);
  const over = value >= limit;
  const tone = over || ratio >= 0.95 ? "destructive" : ratio >= 0.8 ? "warning" : "primary";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="tnum text-sm font-semibold">
          ${value.toFixed(2)}{" "}
          <span className="font-normal text-muted-foreground">/ ${limit.toFixed(2)}</span>
        </span>
        <span className={cn("text-xs font-medium", `text-${tone}`)}>
          {Math.round(ratio * 100)}%
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className="dd-bar h-full rounded-full"
          style={{ width: `${ratio * 100}%`, backgroundColor: toneVar(tone) }}
        />
      </div>
    </div>
  );
}
