"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { abortJobAction, requeueJobAction } from "@/lib/orchestrator/job-actions";
import Link from "next/link";
import { useState, useTransition } from "react";

export interface NeedsHumanRow {
  id: number;
  repoId: number;
  repoName: string;
  issueNumber: number;
  errorMessage: string | null;
}

export function NeedsHumanList({ jobs }: { jobs: NeedsHumanRow[] }) {
  const [pending, start] = useTransition();
  const [confirmAbort, setConfirmAbort] = useState<NeedsHumanRow | null>(null);
  const { success, error } = useToast();

  if (jobs.length === 0) {
    return <p className="text-sm text-muted-foreground">No jobs need attention.</p>;
  }

  function requeue(job: NeedsHumanRow) {
    start(async () => {
      try {
        await requeueJobAction(job.id);
        success("Job requeued", `${job.repoName} #${job.issueNumber}`);
      } catch (e) {
        error("Failed to requeue job", e instanceof Error ? e.message : String(e));
      }
    });
  }

  function abort(job: NeedsHumanRow) {
    start(async () => {
      try {
        await abortJobAction(job.id);
        success("Job aborted", `${job.repoName} #${job.issueNumber}`);
      } catch (e) {
        error("Failed to abort job", e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div className="space-y-3">
      {jobs.map((job) => (
        <Card key={job.id}>
          <CardContent className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0">
              <Link href={`/jobs/${job.id}`} className="font-medium hover:underline">
                {job.repoName} #{job.issueNumber}
              </Link>
              <p className="truncate text-xs text-muted-foreground">
                {job.errorMessage ?? "No error message recorded."}
              </p>
            </div>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" disabled={pending} onClick={() => requeue(job)}>
                Requeue
              </Button>
              <Button variant="destructive" disabled={pending} onClick={() => setConfirmAbort(job)}>
                Abort
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
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
        pending={pending}
      />
    </div>
  );
}
