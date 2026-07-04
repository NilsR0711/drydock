"use client";

import {
  Ban,
  CircleCheck,
  LayoutDashboard,
  RotateCcw,
  ScrollText,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { PageHeader } from "@/components/page-header";
import { ResumeWithInstructions } from "@/components/resume-with-instructions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { RelativeTime } from "@/components/ui/relative-time";
import { useToast } from "@/components/ui/toast";
import {
  abortJobAction,
  type BulkJobActionResult,
  bulkAbortJobsAction,
  bulkRequeueJobsAction,
  requeueJobAction,
} from "@/lib/orchestrator/job-actions";

export interface NeedsHumanRow {
  id: number;
  repoId: number;
  repoName: string;
  issueNumber: number;
  errorMessage: string | null;
  attempts: number;
  parkedAt: number | null;
}

/** "1 job" / "3 jobs" — count with the correctly pluralized noun. */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function NeedsHumanList({ jobs }: { jobs: NeedsHumanRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // Disable only the acted-on row, not every row, while its action is in flight.
  const [busyId, setBusyId] = useState<number | null>(null);
  const [confirmAbort, setConfirmAbort] = useState<NeedsHumanRow | null>(null);
  // Multi-select for bulk recovery from a systemic outage (issue #410).
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirmBulkAbort, setConfirmBulkAbort] = useState(false);
  const { success, error } = useToast();

  const allSelected = jobs.length > 0 && selected.size === jobs.length;

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    // Build from the job list so the selection follows on-screen (input) order.
    setSelected(allSelected ? new Set() : new Set(jobs.map((j) => j.id)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  /** Human-readable "repo #issue" for a job id; falls back to the raw id. */
  function refFor(id: number): string {
    const job = jobs.find((j) => j.id === id);
    return job ? `${job.repoName} #${job.issueNumber}` : `job ${id}`;
  }

  /**
   * One summary toast for a bulk action. A clean batch is a single success; any
   * failure surfaces which jobs failed and why (issue #410 acceptance) instead
   * of swallowing it — partial batches report the split, total failures error.
   */
  function reportBulk(verbPast: string, verb: string, res: BulkJobActionResult) {
    const total = res.succeeded.length + res.failed.length;
    if (res.failed.length === 0) {
      success(`${verbPast} ${plural(res.succeeded.length, "job")}`);
      return;
    }
    const details = res.failed.map((f) => `${refFor(f.id)}: ${f.error}`).join("; ");
    if (res.succeeded.length === 0) {
      error(`Failed to ${verb} ${plural(total, "job")}`, details);
    } else {
      error(`${verbPast} ${res.succeeded.length} of ${total} jobs`, details);
    }
  }

  /** Run a bulk action over the current selection, then report and refresh. */
  function runBulk(
    action: (ids: number[]) => Promise<BulkJobActionResult>,
    verbPast: string,
    verb: string,
  ) {
    const ids = [...selected];
    if (ids.length === 0) return;
    start(async () => {
      try {
        const res = await action(ids);
        reportBulk(verbPast, verb, res);
        // Succeeded jobs leave the needs-human set — re-query so the list reflects
        // it; any failed jobs remain and can be re-selected.
        clearSelection();
        router.refresh();
      } catch (e) {
        error(`Failed to ${verb} jobs`, e instanceof Error ? e.message : String(e));
      }
    });
  }

  function requeue(job: NeedsHumanRow) {
    setBusyId(job.id);
    start(async () => {
      try {
        await requeueJobAction(job.id);
        success("Job requeued", `${job.repoName} #${job.issueNumber}`);
        // The job leaves the needs-human set — re-query so the list reflects it.
        router.refresh();
      } catch (e) {
        error("Failed to requeue job", e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    });
  }

  function abort(job: NeedsHumanRow) {
    setBusyId(job.id);
    start(async () => {
      try {
        await abortJobAction(job.id);
        success("Job aborted", `${job.repoName} #${job.issueNumber}`);
        router.refresh();
      } catch (e) {
        error("Failed to abort job", e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <div className="dd-fade-up">
      <PageHeader
        title="Needs human"
        subtitle="Jobs a guardrail paused for review. Nothing risky was written."
        icon={TriangleAlert}
      />

      {jobs.length === 0 ? (
        <Card>
          <EmptyState
            icon={CircleCheck}
            tone="success"
            title="All clear"
            description="No jobs are waiting on a human. Drydock will surface anything that hits a guardrail here."
            action={
              <Button variant="outline" onClick={() => router.push("/")}>
                <LayoutDashboard className="h-[15px] w-[15px]" /> Back to dashboard
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3 px-1">
            <Checkbox checked={allSelected} onChange={toggleAll} aria-label="Select all jobs" />
            <span className="text-xs text-muted-foreground">
              {selected.size > 0 ? `${selected.size} selected` : "Select all"}
            </span>
            {selected.size > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    runBulk((ids) => bulkRequeueJobsAction(ids), "Requeued", "requeue")
                  }
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Requeue selected
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={pending}
                  onClick={() => setConfirmBulkAbort(true)}
                >
                  <Ban className="h-3.5 w-3.5" /> Abort selected
                </Button>
                <Button variant="ghost" size="sm" disabled={pending} onClick={clearSelection}>
                  Clear
                </Button>
              </div>
            )}
          </div>

          <div className="dd-stagger flex flex-col gap-3">
            {jobs.map((job, i) => (
              <Card
                key={job.id}
                pad="none"
                className="border-destructive/30"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <div className="flex flex-wrap items-start gap-3 p-4">
                  <Checkbox
                    checked={selected.has(job.id)}
                    onChange={() => toggleSelect(job.id)}
                    aria-label={`Select ${job.repoName} #${job.issueNumber}`}
                    className="mt-1"
                  />
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
                    <TriangleAlert className="h-[17px] w-[17px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/jobs/${job.id}`}
                      className="flex flex-wrap items-center gap-2 text-left focus-ring rounded"
                    >
                      <span className="font-mono text-xs text-muted-foreground">
                        {job.repoName} #{job.issueNumber}
                      </span>
                      <Badge tone="destructive">needs human</Badge>
                      <span className="text-xs text-muted-foreground">
                        · {job.attempts} attempts · <RelativeTime ts={job.parkedAt} />
                      </span>
                    </Link>
                    <p className="mt-1 text-sm text-muted-foreground text-pretty">
                      {job.errorMessage ?? "No error message recorded."}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => router.push(`/jobs/${job.id}`)}
                    >
                      <ScrollText className="h-3.5 w-3.5" /> Log
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === job.id}
                      onClick={() => requeue(job)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Requeue
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busyId === job.id}
                      onClick={() => setConfirmAbort(job)}
                    >
                      <Ban className="h-3.5 w-3.5" /> Abort
                    </Button>
                  </div>
                </div>
                {/* Guided resume (issue #257): a full-width row so the textarea has
                  room. Continues the job on its branch with the typed guidance. */}
                <div className="border-border/60 border-t px-4 py-3">
                  <ResumeWithInstructions
                    jobId={job.id}
                    label={`${job.repoName} #${job.issueNumber}`}
                  />
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmAbort !== null}
        onOpenChange={(o) => !o && setConfirmAbort(null)}
        onConfirm={() => confirmAbort && abort(confirmAbort)}
        title="Abort job?"
        description={
          confirmAbort
            ? `This permanently aborts ${confirmAbort.repoName} #${confirmAbort.issueNumber}.`
            : undefined
        }
        confirmLabel="Abort"
        variant="destructive"
        icon={Ban}
        pending={busyId !== null}
      />

      <ConfirmDialog
        open={confirmBulkAbort}
        onOpenChange={(o) => !o && setConfirmBulkAbort(false)}
        onConfirm={() => runBulk((ids) => bulkAbortJobsAction(ids), "Aborted", "abort")}
        title={`Abort ${plural(selected.size, "job")}?`}
        description={`This permanently aborts ${plural(selected.size, "job")}. This cannot be undone.`}
        confirmLabel="Abort"
        variant="destructive"
        icon={Ban}
        pending={pending}
      />
    </div>
  );
}
