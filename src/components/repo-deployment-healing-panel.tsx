import { Rocket } from "lucide-react";
import Link from "next/link";
import { Badge, type Tone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
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
    <div className="flex flex-col gap-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Rocket className="h-3.5 w-3.5 text-muted-foreground" /> Deployments
      </h3>
      {sessions.length === 0 ? (
        <EmptyState
          compact
          icon={Rocket}
          title="No deployment sessions yet"
          description="Post-merge deployment monitoring and fixes show up here."
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
              <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {s.platform}
              </span>
              <span className="font-mono text-sm">PR #{s.prNumber}</span>
              <span className="text-xs text-muted-foreground">{s.commitSha.slice(0, 7)}</span>
              <Badge tone={STATUS_TONE[s.status] ?? "neutral"}>{s.status}</Badge>
              {s.followupPrNumber != null && (
                <span className="ml-auto text-xs text-muted-foreground">
                  fix PR #{s.followupPrNumber}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
