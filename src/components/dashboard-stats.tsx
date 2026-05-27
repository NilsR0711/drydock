import type { DashboardSummary } from "@/lib/db/queries";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "primary" | "success" | "destructive";

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-foreground",
  primary: "text-primary",
  success: "text-success",
  destructive: "text-destructive",
};

function StatCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: Tone;
}) {
  // Zero values stay muted; a non-zero count lights up in its tone.
  const active = value > 0 && tone !== "neutral";
  return (
    <div className="rounded-xl border border-card-border bg-card px-4 py-3 shadow-sm">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums",
          active ? TONE_TEXT[tone] : "text-foreground",
        )}
      >
        {value}
      </div>
    </div>
  );
}

export function DashboardStats({ summary }: { summary: DashboardSummary }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <StatCard label="Repos" value={summary.repos} />
      <StatCard label="Queued" value={summary.queued} />
      <StatCard label="Running" value={summary.running} tone="primary" />
      <StatCard label="Merged" value={summary.merged} tone="success" />
      <StatCard label="Needs human" value={summary.needsHuman} tone="destructive" />
    </div>
  );
}
