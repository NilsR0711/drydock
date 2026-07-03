import type { LucideIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";
import type { Tone } from "./badge";
import { HelpTip } from "./tooltip";

type StatToneStyle = { chip: string; val: string; bg: string };

const STAT_TONE: Record<Tone, StatToneStyle> = {
  neutral: { chip: "bg-secondary text-muted-foreground", val: "text-foreground", bg: "" },
  primary: { chip: "bg-primary/15 text-primary", val: "text-primary", bg: "bg-primary/[0.04]" },
  success: { chip: "bg-success-muted text-success", val: "text-success", bg: "bg-success/[0.05]" },
  warning: { chip: "bg-warning-muted text-warning", val: "text-warning", bg: "bg-warning/[0.05]" },
  destructive: {
    chip: "bg-destructive/15 text-destructive",
    val: "text-destructive",
    bg: "bg-destructive/[0.05]",
  },
};

export interface StatCardProps {
  icon?: LucideIcon;
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: Tone;
  active?: boolean;
  onClick?: () => void;
  hint?: React.ReactNode;
}

/**
 * Compact stat tile: a tinted lucide icon chip plus a tabular value. When
 * `active` and a non-neutral `tone` is set, the value, chip, and background
 * light up in that tone. Renders as a <button> only when `onClick` is passed
 * (so it stays a server-renderable <div> otherwise).
 */
export function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = "neutral",
  active,
  onClick,
  hint,
}: StatCardProps) {
  const lit = Boolean(active) && tone !== "neutral";
  const t = STAT_TONE[tone];
  const inner = (
    <>
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
            lit ? t.chip : "bg-secondary text-muted-foreground",
          )}
        >
          {Icon && <Icon className="h-4 w-4" />}
        </span>
        {/* On a clickable card the hint is rendered as a sibling overlay
            below, so it never becomes a nested (invalid) button. */}
        {hint && !onClick && <HelpTip content={hint} />}
      </div>
      <div>
        <div
          className={cn(
            "text-2xl font-semibold tnum tracking-tight",
            lit ? t.val : "text-foreground",
          )}
        >
          {value}
        </div>
        <div className="mt-0.5 text-[13px] font-medium text-muted-foreground">{label}</div>
        {sub && <div className="mt-0.5 text-xs text-muted-foreground/80">{sub}</div>}
      </div>
    </>
  );

  const className = cn(
    "group relative flex flex-col gap-3 rounded-xl border border-card-border bg-card p-4 text-left shadow-sm transition-colors",
    lit && t.bg,
    onClick && "hover-elevate focus-ring",
  );

  if (onClick) {
    // A nested <button> is invalid HTML and would hijack the card click, so
    // the Help trigger lives outside the card button. It overlays the same
    // top-right slot the inline hint would occupy; the overlay wrapper is
    // click-through (pointer-events-none) except for the trigger itself.
    return (
      <div className="relative flex">
        <button type="button" onClick={onClick} className={cn(className, "w-full")}>
          {inner}
        </button>
        {hint && (
          <div className="pointer-events-none absolute inset-x-4 top-4 flex h-8 items-center justify-end">
            <span className="pointer-events-auto">
              <HelpTip content={hint} />
            </span>
          </div>
        )}
      </div>
    );
  }
  return <div className={className}>{inner}</div>;
}
