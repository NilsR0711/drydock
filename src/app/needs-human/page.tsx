import { NeedsHumanList } from "@/components/needs-human-list";
import { needsHumanJobs } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export default function NeedsHumanPage() {
  const jobs = needsHumanJobs().map((j) => ({
    id: j.id,
    repoId: j.repoId,
    repoName: j.repoName,
    issueNumber: j.issueNumber,
    errorMessage: j.errorMessage,
    attempts: j.attempts,
    parkedAt: j.finishedAt ?? j.startedAt ?? j.createdAt,
  }));

  return <NeedsHumanList jobs={jobs} />;
}
