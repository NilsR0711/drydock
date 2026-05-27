import { Badge } from "@/components/ui/badge";
import { getDb } from "@/lib/db/client";
import { jobEvents } from "@/lib/db/schema";
import { getJob } from "@/lib/orchestrator/jobs";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = Number(id);
  const job = getJob(jobId);
  if (!job) notFound();
  const events = getDb().select().from(jobEvents).where(eq(jobEvents.jobId, jobId)).all();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Job #{job.id}</h1>
        <Badge status={job.status}>{job.status}</Badge>
      </div>
      <dl className="grid gap-1 text-sm">
        <div>Issue: #{job.issueNumber}</div>
        <div>Model: {job.model ?? "—"}</div>
        <div>Cost: ${job.costUsd.toFixed(4)}</div>
        <div>
          Tokens: {job.totalInputTokens} in / {job.totalOutputTokens} out
        </div>
      </dl>
      <section>
        <h2 className="mb-2 font-semibold">Timeline</h2>
        <ul className="space-y-1 text-xs font-mono">
          {events.map((e) => (
            <li key={e.id}>
              <span className="text-neutral-500">{e.type}</span> {e.payload}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
