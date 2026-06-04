import { HeartPulse } from "lucide-react";
import Link from "next/link";
import { Badge, type Tone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import type { HealingSessionSummary } from "@/lib/orchestrator/ci-healing";

const STATUS_TONE: Record<string, Tone> = {
  healed: "success",
  triaging: "neutral",
  awaiting_slot: "neutral",
  repairing: "primary",
  awaiting_ci: "warning",
  verifying: "warning",
  cooldown: "warning",
  blocked: "destructive",
  escalated: "destructive",
  superseded: "neutral",
};

/**
 * Read-only view of recent CI auto-heal sessions for a repo (issue #16). Each
 * row links to the job and shows the bound PR, head SHA, status, and how many
 * heal attempts the session has spent against its budgets.
 */
export function RepoHealingPanel({ sessions }: { sessions: HealingSessionSummary[] }) {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <HeartPulse className="h-3.5 w-3.5 text-muted-foreground" /> CI auto-heal
      </h3>
      {sessions.length === 0 ? (
        <EmptyState
          compact
          icon={HeartPulse}
          title="No healing sessions yet"
          description="When CI fails on a tracked PR, auto-heal attempts surface here."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
              <Link
                href={`/jobs/${s.jobId}`}
                className="font-mono text-xs text-muted-foreground hover:text-foreground"
              >
                #{s.issueNumber}
              </Link>
              <span className="font-mono text-sm">PR #{s.prNumber}</span>
              <span className="text-xs text-muted-foreground">{s.headSha.slice(0, 7)}</span>
              <Badge tone={STATUS_TONE[s.status] ?? "neutral"}>{s.status}</Badge>
              <span className="ml-auto text-xs text-muted-foreground">
                {s.attempts} attempt{s.attempts === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
