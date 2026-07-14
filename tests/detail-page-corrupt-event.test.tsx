// @vitest-environment jsdom
process.env.DRYDOCK_DB = ":memory:";

import type { ReactElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import JobDetailPage from "@/app/jobs/[id]/page";
import RepoWorkspacePage from "@/app/repos/[id]/page";
import { LogViewer } from "@/components/log-viewer";
import { RepoActivity } from "@/components/repo-activity";
import { getDb } from "@/lib/db/client";
import { jobEvents } from "@/lib/db/schema";
import { createJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";

/** Depth-first search of a React element tree for the first node of `type`. */
function findByType(node: unknown, type: unknown): ReactElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByType(child, type);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== "object") return undefined;
  const el = node as ReactElement;
  if (el.type === type) return el;
  return findByType((el.props as { children?: unknown })?.children, type);
}

const FALLBACK = { error: "unparseable event payload" };

describe("detail pages — corrupt persisted event payload (issue #419)", () => {
  let repoId: number;
  let jobId: number;

  beforeEach(() => {
    const db = getDb();
    db.delete(jobEvents).run();
    repoId = addRepo({ path: `/tmp/r-${process.hrtime.bigint()}`, name: "r" }, db).id;
    // createJob defaults to status "queued", so this is the repo's active job —
    // the repo page renders its full log from `job_events`.
    jobId = createJob({ repoId, issueNumber: 1 }, db).id;
    db.insert(jobEvents).values({ jobId, type: "text", payload: '{"text":"ok"}' }).run();
    db.insert(jobEvents).values({ jobId, type: "text", payload: "{not valid json" }).run();
  });

  it("job detail page renders a fallback log entry instead of crashing", async () => {
    const tree = await JobDetailPage({ params: Promise.resolve({ id: String(jobId) }) });

    const viewer = findByType(tree, LogViewer);
    expect(viewer).toBeDefined();
    const initial = ((viewer as ReactElement).props as { initial: { payload: unknown }[] }).initial;
    expect(initial).toHaveLength(2);
    expect(initial.map((e) => e.payload)).toEqual([{ text: "ok" }, FALLBACK]);
  });

  it("repo detail page renders a fallback log entry for the active job instead of crashing", async () => {
    const tree = await RepoWorkspacePage({ params: Promise.resolve({ id: String(repoId) }) });

    const activity = findByType(tree, RepoActivity);
    expect(activity).toBeDefined();
    const initialLog = ((activity as ReactElement).props as { initialLog: { payload: unknown }[] })
      .initialLog;
    expect(initialLog).toHaveLength(2);
    expect(initialLog.map((e) => e.payload)).toEqual([{ text: "ok" }, FALLBACK]);
  });
});
