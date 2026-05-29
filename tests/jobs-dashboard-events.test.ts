import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { createJob, transitionJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";
import { onDashboardChange } from "@/lib/stream/dashboard-bus";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/r", name: "r" }, db).id;
});

describe("job lifecycle dashboard events", () => {
  it("emits a dashboard change when a job is created", () => {
    const fn = vi.fn();
    const off = onDashboardChange(fn);
    createJob({ repoId, issueNumber: 1 }, db);
    off();
    expect(fn).toHaveBeenCalled();
  });

  it("emits a dashboard change when a job transitions", () => {
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const fn = vi.fn();
    const off = onDashboardChange(fn);
    transitionJob(job.id, "working", {}, db);
    off();
    expect(fn).toHaveBeenCalled();
  });
});
