import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { JobMetrics } from "@/components/job-metrics";
import { LogViewer } from "@/components/log-viewer";
import { PrQuestionPanel } from "@/components/pr-question-panel";
import { Badge } from "@/components/ui/badge";
import { getDb } from "@/lib/db/client";
import { jobEvents } from "@/lib/db/schema";
import { getJob } from "@/lib/orchestrator/jobs";
import { listPrQuestions } from "@/lib/orchestrator/pr-questions";

export const dynamic = "force-dynamic";

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = Number(id);
  const job = getJob(jobId);
  if (!job) notFound();
  const events = getDb().select().from(jobEvents).where(eq(jobEvents.jobId, jobId)).all();
  const questions = job.prNumber != null ? listPrQuestions(job.id) : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Job #{job.id}</h1>
        <Badge status={job.status}>{job.status}</Badge>
      </div>
      <JobMetrics
        jobId={job.id}
        issueNumber={job.issueNumber}
        model={job.model}
        initialCostUsd={job.costUsd}
        inputTokens={job.totalInputTokens}
        outputTokens={job.totalOutputTokens}
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
      <section>
        <h2 className="mb-2 font-semibold">Live log</h2>
        <LogViewer
          jobId={job.id}
          initial={events.map((e) => ({ id: e.id, type: e.type, payload: JSON.parse(e.payload) }))}
        />
      </section>
    </div>
  );
}
