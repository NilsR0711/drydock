"use client";

import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { AddRepoForm } from "@/components/add-repo-form";
import { DashboardStats } from "@/components/dashboard-stats";
import { RepoStatusCard } from "@/components/repo-status-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { DashboardSnapshot } from "@/lib/db/queries";

/**
 * Live multi-repo dashboard (issue #60). Renders the server-computed snapshot
 * immediately, then subscribes to /api/sse/dashboard and swaps in fresh
 * snapshots as jobs move and spend accrues — no manual refresh.
 */
export function DashboardLive({ initial }: { initial: DashboardSnapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    const es = new EventSource("/api/sse/dashboard");
    es.addEventListener("snapshot", (ev: MessageEvent) => {
      try {
        setSnapshot(JSON.parse(ev.data) as DashboardSnapshot);
      } catch {
        // Ignore a malformed frame; the next snapshot will recover.
      }
    });
    return () => es.close();
  }, []);

  const { repos, summary } = snapshot;

  return (
    <div className="space-y-6">
      <DashboardStats summary={summary} />
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            Repositories <span className="text-muted-foreground">({repos.length})</span>
          </h2>
          <Button size="sm" onClick={() => setShowAdd((v) => !v)}>
            {showAdd ? (
              "Cancel"
            ) : (
              <>
                <Plus /> Add repo
              </>
            )}
          </Button>
        </div>
        {showAdd && <AddRepoForm onDone={() => setShowAdd(false)} />}
        {repos.length === 0 && !showAdd && (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No repositories yet. Add one to start automating issues.
            </CardContent>
          </Card>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {repos.map((repo) => (
            <RepoStatusCard key={repo.id} repo={repo} />
          ))}
        </div>
      </div>
    </div>
  );
}
