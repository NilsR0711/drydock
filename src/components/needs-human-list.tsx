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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { abortJobAction, requeueJobAction } from "@/lib/orchestrator/job-actions";
import { relativeTime } from "@/lib/utils";

export interface NeedsHumanRow {
  id: number;
  repoId: number;
  repoName: string;
  issueNumber: number;
  errorMessage: string | null;
  attempts: number;
  parkedAt: number | null;
}

export function NeedsHumanList({ jobs }: { jobs: NeedsHumanRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirmAbort, setConfirmAbort] = useState<NeedsHumanRow | null>(null);
  const { success, error } = useToast();

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
        <div className="dd-stagger flex flex-col gap-3">
          {jobs.map((job, i) => (
            <Card
              key={job.id}
              pad="none"
              className="border-destructive/30"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <div className="flex flex-wrap items-start gap-3 p-4">
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
                      · {job.attempts} attempts · {relativeTime(job.parkedAt)}
                    </span>
                  </Link>
                  <p className="mt-1 text-sm text-muted-foreground text-pretty">
                    {job.errorMessage ?? "No error message recorded."}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
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
                    disabled={pending}
                    onClick={() => requeue(job)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Requeue
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={pending}
                    onClick={() => setConfirmAbort(job)}
                  >
                    <Ban className="h-3.5 w-3.5" /> Abort
                  </Button>
                </div>
              </div>
            </Card>
          ))}
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
        pending={pending}
      />
    </div>
  );
}
