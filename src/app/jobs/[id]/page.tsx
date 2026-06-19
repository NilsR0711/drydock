import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { JobMetrics } from "@/components/job-metrics";
import { JobStopButton } from "@/components/job-stop-button";
import { LogViewer } from "@/components/log-viewer";
import { PageHeader } from "@/components/page-header";
import { PrAuditButton } from "@/components/pr-audit-button";
import { PrQuestionPanel } from "@/components/pr-question-panel";
import { ResumeWithInstructions } from "@/components/resume-with-instructions";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { getDb } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import { jobEvents } from "@/lib/db/schema";
import { getIssueTitle } from "@/lib/issues/service";
import { jobHeading } from "@/lib/orchestrator/job-display";
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
  // A release job (issue #256) carries the sentinel issueNumber 0, so label it
  // by kind rather than as "#0".
  const subjectLabel = job.kind === "release" ? "Release" : `#${job.issueNumber}`;
  // Lead with the issue title when the cache has it (issue #278); the heading
  // helper degrades to "Job #id" for release jobs and missing titles.
  const issueTitle = job.kind === "release" ? null : getIssueTitle(job.repoId, job.issueNumber);
  const heading = jobHeading(job, issueTitle);
  // The Duration card ticks client-side from startedAt; nowSec seeds it so the
  // SSR markup and the first client render agree (issue #242).
  const nowSec = Math.floor(Date.now() / 1000);

  return (
    <div className="dd-fade-up space-y-5">
      <PageHeader
        breadcrumb={[
          { label: "Dashboard", href: "/" },
          { label: repoName, href: `/repos/${job.repoId}` },
          { label: subjectLabel },
        ]}
        title={heading}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <Badge status={job.status} />
            <span className="font-mono text-foreground/80">{repoName}</span>
            <Badge tone="neutral" className="font-mono">
              {subjectLabel}
            </Badge>
            <Badge tone="neutral" className="font-mono">
              job #{job.id}
            </Badge>
          </span>
        }
        actions={
          job.prNumber != null || inFlight ? (
            <span className="flex items-center gap-2">
              {job.prNumber != null && <PrAuditButton jobId={job.id} />}
              {inFlight && <JobStopButton jobId={job.id} />}
            </span>
          ) : undefined
        }
      />

      {isError && (
        <>
          <Alert tone="destructive" title="Paused for a human">
            {job.errorMessage ?? "A guardrail stopped the run before anything risky was written."}
          </Alert>
          {/* Guided resume (issue #257): read the log below, then tell the agent
              how to proceed — it resumes on its existing branch with the guidance. */}
          <Card>
            <h2 className="font-medium text-sm">Resume with instructions</h2>
            <p className="mt-1 mb-3 text-muted-foreground text-sm text-pretty">
              Read the log below, then tell the agent how to get unblocked. It resumes on its
              existing branch taking your guidance into account.
            </p>
            <ResumeWithInstructions
              jobId={job.id}
              label={`${repoName} #${job.issueNumber}`}
              defaultOpen
            />
          </Card>
        </>
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
        subject={job.kind === "release" ? "Release" : undefined}
        active={inFlight}
        model={job.model}
        initialCostUsd={job.costUsd}
        inputTokens={job.totalInputTokens}
        outputTokens={job.totalOutputTokens}
        startedAt={job.startedAt}
        finishedAt={job.finishedAt}
        nowSec={nowSec}
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
