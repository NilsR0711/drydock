import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { JobMetrics } from "@/components/job-metrics";
import { JobStopButton } from "@/components/job-stop-button";
import { LogViewer } from "@/components/log-viewer";
import { PageHeader } from "@/components/page-header";
import { PrQuestionPanel } from "@/components/pr-question-panel";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { getDb } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import { jobEvents } from "@/lib/db/schema";
import { getJob } from "@/lib/orchestrator/jobs";
import { listPrQuestions } from "@/lib/orchestrator/pr-questions";

export const dynamic = "force-dynamic";

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = Number(id);
  const job = getJob(jobId);
  if (!job) notFound();
  const repo = getRepo(job.repoId);
  const events = getDb().select().from(jobEvents).where(eq(jobEvents.jobId, jobId)).all();
  const questions = job.prNumber != null ? listPrQuestions(job.id) : [];
  // waiting_limit counts as in flight: the job is operationally live (the
  // driver resumes it on its own) and must stay stoppable from the UI.
  const inFlight = ["working", "ci_running", "retrying", "waiting_limit"].includes(job.status);
  const isError = job.status === "needs_human";
  const isLimitParked = job.status === "waiting_limit";

  const repoName = repo?.name ?? `repo #${job.repoId}`;
  const end = job.finishedAt ?? Math.floor(Date.now() / 1000);
  const durationSec = job.startedAt != null ? Math.max(0, end - job.startedAt) : null;

  return (
    <div className="dd-fade-up space-y-5">
      <PageHeader
        breadcrumb={[
          { label: "Dashboard", href: "/" },
          { label: repoName, href: `/repos/${job.repoId}` },
          { label: `#${job.issueNumber}` },
        ]}
        title={`Job #${job.id}`}
        subtitle={
          <span className="inline-flex items-center gap-2">
            <Badge status={job.status} />
            <span className="font-mono">
              {repoName} #{job.issueNumber}
            </span>
          </span>
        }
        actions={inFlight ? <JobStopButton jobId={job.id} /> : undefined}
      />

      {isError && (
        <Alert tone="destructive" title="Paused for a human">
          {job.errorMessage ?? "A guardrail stopped the run before anything risky was written."}
        </Alert>
      )}

      {isLimitParked && (
        <Alert tone="warning" title="Waiting on provider limit">
          {job.errorMessage ?? "Provider usage limit reached — the job resumes automatically."}
          {job.availableAt != null && (
            <>
              {" "}
              Next attempt around{" "}
              {new Date(job.availableAt * 1000).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
              .
            </>
          )}
        </Alert>
      )}

      <JobMetrics
        jobId={job.id}
        issueNumber={job.issueNumber}
        active={inFlight}
        model={job.model}
        initialCostUsd={job.costUsd}
        inputTokens={job.totalInputTokens}
        outputTokens={job.totalOutputTokens}
        durationSec={durationSec}
        attempts={job.attempts}
      />

      {job.prNumber != null && (
        <PrQuestionPanel
          jobId={job.id}
          initialQuestions={questions.map((q) => ({
            id: q.id,
            question: q.question,
            answer: q.answer,
            status: q.status,
            errorMessage: q.errorMessage,
            createdAt: q.createdAt,
          }))}
        />
      )}

      <LogViewer
        jobId={job.id}
        active={inFlight}
        initial={events.map((e) => ({
          id: e.id,
          type: e.type,
          payload: JSON.parse(e.payload),
          ts: e.ts,
        }))}
      />
    </div>
  );
}
