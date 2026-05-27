import { CostChart } from "@/components/cost-chart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { costByModel, dailyCosts, topJobs } from "@/lib/db/cost-queries";

export const dynamic = "force-dynamic";

export default function CostsPage() {
  const daily = dailyCosts();
  const byModel = costByModel();
  const top = topJobs(10);
  const total = daily.reduce((s, d) => s + d.costUsd, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-baseline gap-3">
        <h1 className="text-2xl font-bold">Costs</h1>
        <span className="text-sm text-muted-foreground">Total: ${total.toFixed(4)}</span>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Daily cost</CardTitle>
        </CardHeader>
        <CardContent>
          {daily.length === 0 ? (
            <p className="text-sm text-muted-foreground">No cost data yet.</p>
          ) : (
            <CostChart data={daily} />
          )}
        </CardContent>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By model</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {byModel.map((m) => (
              <div key={m.model} className="flex justify-between">
                <span>{m.model}</span>
                <span>${m.costUsd.toFixed(4)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Top 10 jobs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {top.map((j) => (
              <div key={j.id} className="flex justify-between">
                <span>
                  #{j.issueNumber} (job {j.id})
                </span>
                <span>${j.costUsd.toFixed(4)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
