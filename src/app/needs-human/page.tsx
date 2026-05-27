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
  }));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Needs human</h1>
      <p className="text-sm text-muted-foreground">
        Jobs paused for review. Requeue to retry, or abort to close them out.
      </p>
      <NeedsHumanList jobs={jobs} />
    </div>
  );
}
