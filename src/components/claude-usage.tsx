"use client";

import { Gauge } from "lucide-react";
import { useEffect, useReducer } from "react";
import {
  type ClaudeUsageView,
  formatResetCountdown,
  type UsageTone,
} from "@/lib/agents/claude-usage";
import { useHydrated } from "@/lib/ui/use-hydrated";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";

/** Static icon-chip classes per tone (Tailwind needs literal class names). */
const CHIP: Record<UsageTone, string> = {
  neutral: "bg-secondary text-muted-foreground",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

/**
 * Proactive Claude OAuth usage indicators (issue #188): a compact navbar pill
 * and a dashboard card, both fed by the same derived `ClaudeUsageView` so the
 * live reading and the reactive parked state read as one coherent widget.
 */

/** A short, human label for the subscription window the reading describes. */
function windowLabel(windowType: string | null): string | null {
  if (!windowType || windowType === "unknown") return null;
  if (windowType === "five_hour") return "5h window";
  if (windowType === "weekly") return "weekly window";
  return windowType.replace(/_/g, " ");
}

/** Re-render once a second so the reset countdown ticks down live. */
function useTick(active: boolean): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(force, 1000);
    return () => clearInterval(id);
  }, [active]);
}

function countdown(view: ClaudeUsageView): string | null {
  return formatResetCountdown(view.resetsAt, Math.floor(Date.now() / 1000));
}

/** Compact navbar pill — always visible, escalating tone as the quota nears. */
export function ClaudeUsagePill({ view }: { view: ClaudeUsageView }) {
  const hydrated = useHydrated();
  useTick(hydrated && view.resetsAt !== null);
  const left = hydrated ? countdown(view) : null;

  let text: string;
  if (view.state === "blocked") text = left ? `Claude limited · ${left}` : "Claude limited";
  else if (view.state === "warning") text = left ? `Claude · ${left}` : "Claude limit near";
  else if (view.state === "ok") text = "Claude OK";
  else text = "Claude usage —";

  const title =
    view.state === "unknown"
      ? "Claude subscription usage: no recent reading yet"
      : `Claude ${windowLabel(view.windowType) ?? "subscription"} — ${view.label}${
          left ? ` · resets in ${left}` : ""
        }`;

  return (
    <Badge tone={view.tone} title={title} className="shrink-0">
      <Gauge className="h-3 w-3" aria-hidden />
      {text}
    </Badge>
  );
}

/** Dashboard right-rail card with the window state and a reset countdown. */
export function ClaudeUsageCard({ view }: { view: ClaudeUsageView }) {
  const hydrated = useHydrated();
  useTick(hydrated && view.resetsAt !== null);
  const left = hydrated ? countdown(view) : null;
  const win = windowLabel(view.windowType);

  let detail: string;
  if (view.state === "unknown") detail = "No recent reading yet.";
  else if (view.blocked)
    detail = left ? `Parked — resets in ${left}` : "Parked until the window resets";
  else if (left) detail = `Resets in ${left}`;
  else detail = win ? `${win} active` : "Within limits";

  return (
    <Card pad="lg">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`flex h-8 w-8 items-center justify-center rounded-lg ${CHIP[view.tone]}`}
          >
            <Gauge className="h-4 w-4" aria-hidden />
          </span>
          <span className="text-sm font-medium text-foreground">Claude usage</span>
        </div>
        <Badge tone={view.tone}>{view.label}</Badge>
      </div>
      <div className="mt-3 flex items-baseline justify-between">
        <span className="text-sm text-muted-foreground">{detail}</span>
        {win && view.state !== "unknown" && (
          <span className="text-xs text-muted-foreground/70">{win}</span>
        )}
      </div>
    </Card>
  );
}
