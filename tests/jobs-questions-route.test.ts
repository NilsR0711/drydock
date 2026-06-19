process.env.DRYDOCK_DB = ":memory:";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/jobs/[id]/questions/route";
import { getDb } from "@/lib/db/client";
import { jobEvents, jobs, prQuestions, repos } from "@/lib/db/schema";
import { __setForgeFactory } from "@/lib/forge/registry";
import { __setPrAnswerGenerator } from "@/lib/orchestrator/pr-question-service";

function get(id: string): Promise<Response> {
  const req = new Request(`http://127.0.0.1/api/jobs/${id}/questions`);
  return GET(req as never, { params: Promise.resolve({ id }) });
}

function post(id: string, body: unknown): Promise<Response> {
  const req = new Request(`http://127.0.0.1/api/jobs/${id}/questions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST(req as never, { params: Promise.resolve({ id }) });
}

function seedRepo(): number {
  return getDb().insert(repos).values({ path: "/r", name: "r" }).returning().get().id;
}

function seedJob(over: Partial<typeof jobs.$inferInsert> = {}): number {
  return getDb()
    .insert(jobs)
    .values({ repoId: seedRepo(), issueNumber: 1, status: "ci_running", agent: "claude", ...over })
    .returning()
    .get().id;
}

describe("/api/jobs/[id]/questions (issue #296)", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(prQuestions).run();
    db.delete(jobEvents).run();
    db.delete(jobs).run();
    db.delete(repos).run();
    __setForgeFactory(
      () =>
        ({
          prDiff: vi.fn(async () => "diff"),
          prChecks: vi.fn(async () => []),
          viewIssue: vi.fn(async () => ({
            number: 1,
            title: "t",
            body: "b",
            state: "open",
            labels: [],
            comments: [],
          })),
        }) as never,
    );
  });

  afterEach(() => {
    __setForgeFactory(null);
    __setPrAnswerGenerator(null);
  });

  describe("GET", () => {
    it("rejects a non-numeric / non-positive id with 400", async () => {
      expect((await get("abc")).status).toBe(400);
      expect((await get("0")).status).toBe(400);
      expect((await get("-1")).status).toBe(400);
    });

    it("returns 404 for an unknown job", async () => {
      expect((await get("999")).status).toBe(404);
    });

    it("lists a job's questions newest first", async () => {
      const jobId = seedJob({ prNumber: 7 });
      const db = getDb();
      db.insert(prQuestions)
        .values({ jobId, prNumber: 7, question: "first", status: "answered", answer: "a" })
        .run();
      db.insert(prQuestions)
        .values({ jobId, prNumber: 7, question: "second", status: "answering" })
        .run();

      const res = await get(String(jobId));
      expect(res.status).toBe(200);
      const list = (await res.json()) as Array<{ question: string }>;
      expect(list).toHaveLength(2);
      expect(list[0]?.question).toBe("second");
    });
  });

  describe("POST", () => {
    it("rejects a non-numeric id with 400", async () => {
      expect((await post("abc", { question: "why?" })).status).toBe(400);
    });

    it("returns 400 for a non-JSON body", async () => {
      expect((await post("1", "not json")).status).toBe(400);
    });

    it("returns 400 when `question` is missing or not a string", async () => {
      const jobId = seedJob({ prNumber: 7 });
      expect((await post(String(jobId), {})).status).toBe(400);
      expect((await post(String(jobId), { question: 5 })).status).toBe(400);
    });

    it("returns 400 for an empty question", async () => {
      const jobId = seedJob({ prNumber: 7 });
      const res = await post(String(jobId), { question: "   " });
      expect(res.status).toBe(400);
    });

    it("returns 404 for an unknown job", async () => {
      const res = await post("999", { question: "why?" });
      expect(res.status).toBe(404);
    });

    it("returns 400 for a job without a PR", async () => {
      const jobId = seedJob({ prNumber: null });
      const res = await post(String(jobId), { question: "why?" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/no PR/i);
    });

    it("creates a question in `answering` state and returns 202", async () => {
      __setPrAnswerGenerator(async () => "an answer");
      const jobId = seedJob({ prNumber: 7 });
      const res = await post(String(jobId), { question: "why?" });
      expect(res.status).toBe(202);
      const record = (await res.json()) as { id: number; status: string; question: string };
      expect(record.status).toBe("answering");
      expect(record.question).toBe("why?");

      // The background run settles to a terminal state shortly after; poll GET.
      await vi.waitFor(async () => {
        const list = (await (await get(String(jobId))).json()) as Array<{ status: string }>;
        expect(list[0]?.status).toBe("answered");
      });
    });
  });
});
