import { RepoList } from "@/components/repo-list";
import { listReposWithStats } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const repos = listReposWithStats();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <RepoList repos={repos} />
    </div>
  );
}
