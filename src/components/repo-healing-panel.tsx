import Link from "next/link";
import { Badge, type Tone } from "@/components/ui/badge";
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
    <div className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        CI auto-heal
      </h2>
      <ul className="space-y-1">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center gap-2 text-sm">
            <Link href={`/jobs/${s.jobId}`} className="hover:underline">
              #{s.issueNumber}
            </Link>
            <span className="text-xs text-muted-foreground">
              PR #{s.prNumber} · {s.headSha.slice(0, 7)}
            </span>
            <Badge tone={STATUS_TONE[s.status] ?? "neutral"}>{s.status}</Badge>
            <span className="ml-auto text-xs text-muted-foreground">
              {s.attempts} attempt{s.attempts === 1 ? "" : "s"}
            </span>
          </li>
        ))}
        {sessions.length === 0 && (
          <li className="text-sm text-muted-foreground">No healing sessions yet.</li>
        )}
      </ul>
    </div>
  );
}
