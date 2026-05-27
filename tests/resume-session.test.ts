import { type DB, createDb } from "@/lib/db/client";
import type { StreamCallbacks, StreamHandle, StreamRunner } from "@/lib/exec/stream-runner";
import { resumeClaudeSession } from "@/lib/orchestrator/claude-session";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";
import { LogBroker } from "@/lib/stream/broker";
import { beforeEach, describe, expect, it } from "vitest";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/tmp/r", name: "r", defaultModel: "claude-opus-4-7" }, db).id;
});

describe("resumeClaudeSession", () => {
  it("invokes claude with resume args and the recorded session id", async () => {
    const captured: string[][] = [];
    const runner: StreamRunner = (_cmd, args, _cwd, _cb: StreamCallbacks): StreamHandle => {
      captured.push(args);
      return { done: Promise.resolve(0), abort: () => {} };
    };
    const job = createJob({ repoId, issueNumber: 1 }, db);
    await resumeClaudeSession(job, "sess-abc", "CI log here", "/work", {
      runner,
      db,
      broker: new LogBroker(db),
    });
    expect(captured[0]).toContain("--resume");
    expect(captured[0]).toContain("sess-abc");
    expect(captured[0]).toContain("claude-haiku-4-5");
    expect(getJob(job.id, db)).toBeDefined();
  });
});
