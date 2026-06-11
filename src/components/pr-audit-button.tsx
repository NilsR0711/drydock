"use client";

import { SearchCheck } from "lucide-react";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { runPrAuditAction } from "@/lib/orchestrator/pr-audit-actions";

/**
 * Manual trigger for the read-only AI PR audit (issue #168). Fires the audit
 * in the background; the review lands as a comment on the linked issue and the
 * pass reports progress through the job's event log.
 */
export function PrAuditButton({ jobId }: { jobId: number }) {
  const [pending, start] = useTransition();
  const { success, error } = useToast();

  function audit() {
    start(async () => {
      try {
        const { prNumber } = await runPrAuditAction(jobId);
        success("PR audit started", `Reviewing PR #${prNumber} — the result lands on the issue.`);
      } catch (e) {
        error("Failed to start PR audit", e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={audit}>
      <SearchCheck className="h-3.5 w-3.5" />
      {pending ? "Starting…" : "Run PR audit"}
    </Button>
  );
}
