import Link from "next/link";
import { Badge, type Tone } from "@/components/ui/badge";
import type { DeploymentHealingSessionSummary } from "@/lib/orchestrator/deployment-healing";

const STATUS_TONE: Record<string, Tone> = {
  monitoring: "neutral",
  healthy: "success",
  failed: "destructive",
  repairing: "warning",
  repaired: "primary",
  escalated: "destructive",
};

/**
 * Read-only view of recent post-merge deployment-healing sessions for a repo
 * (issue #20). Each row links to the job and shows the deployment platform, the
 * monitored PR/commit, the lifecycle status, and the follow-up fix PR when one
 * was opened.
 */
export function RepoDeploymentHealingPanel({
  sessions,
}: {
  sessions: DeploymentHealingSessionSummary[];
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Deployments
      </h2>
      <ul className="space-y-1">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center gap-2 text-sm">
            <Link href={`/jobs/${s.jobId}`} className="hover:underline">
              #{s.issueNumber}
            </Link>
            <span className="text-xs text-muted-foreground">
              {s.platform} · PR #{s.prNumber} · {s.commitSha.slice(0, 7)}
            </span>
            <Badge tone={STATUS_TONE[s.status] ?? "neutral"}>{s.status}</Badge>
            {s.followupPrNumber != null && (
              <span className="ml-auto text-xs text-muted-foreground">
                fix PR #{s.followupPrNumber}
              </span>
            )}
          </li>
        ))}
        {sessions.length === 0 && (
          <li className="text-sm text-muted-foreground">No deployment sessions yet.</li>
        )}
      </ul>
    </div>
  );
}
