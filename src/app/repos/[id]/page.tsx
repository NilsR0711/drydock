import { getRepo } from "@/lib/db/queries";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function RepoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repo = getRepo(Number(id));
  if (!repo) notFound();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{repo.name}</h1>
      <p className="text-sm text-neutral-500">{repo.path}</p>
      <dl className="grid gap-1 text-sm">
        <div>Default branch: {repo.defaultBranch}</div>
        <div>Queue label: {repo.queueLabel}</div>
        <div>Default model: {repo.defaultModel}</div>
      </dl>
    </div>
  );
}
