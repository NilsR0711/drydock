import type { NextRequest } from "next/server";
import { z } from "zod";
import { getJob } from "@/lib/orchestrator/jobs";
import { startPrQuestion } from "@/lib/orchestrator/pr-question-service";
import { listPrQuestions } from "@/lib/orchestrator/pr-questions";

export const dynamic = "force-dynamic";

/**
 * REST surface for "Ask about this PR" (issue #296), mirroring the dashboard
 * path so an MCP host or any HTTP client can drive PR Q&A without the UI.
 * Server Actions cover the dashboard's mutations (ADR 001), but they are only
 * callable from Drydock's own client bundle — an external client needs a real
 * HTTP endpoint, which this provides.
 *
 * - `GET`  lists a job's questions, newest first (poll this for terminal state).
 * - `POST` creates a question in the `answering` state and kicks off the
 *   read-only QA run in the background, returning the new record immediately —
 *   exactly the async-then-poll lifecycle the dashboard uses.
 */

/** Parse and validate the `[id]` path segment as a positive job id. */
function parseJobId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const jobId = parseJobId(id);
  if (jobId === null) return Response.json({ error: "Invalid job id" }, { status: 400 });

  const job = getJob(jobId);
  if (!job) return Response.json({ error: `job ${jobId} not found` }, { status: 404 });

  return Response.json(listPrQuestions(jobId), { headers: { "cache-control": "no-store" } });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const jobId = parseJobId(id);
  if (jobId === null) return Response.json({ error: "Invalid job id" }, { status: 400 });

  let question: unknown;
  try {
    question = (await req.json())?.question;
  } catch {
    return Response.json({ error: "Body must be JSON with a `question` field" }, { status: 400 });
  }
  if (typeof question !== "string") {
    return Response.json({ error: "`question` must be a string" }, { status: 400 });
  }

  try {
    // Fire-and-forget like the dashboard: the run persists its own terminal
    // state and clients poll GET for the answer.
    const { record } = startPrQuestion(jobId, question);
    return Response.json(record, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (err) {
    // A bad question surfaces as a ZodError; flatten it to its first message.
    if (err instanceof z.ZodError) {
      return Response.json(
        { error: err.issues[0]?.message ?? "Invalid question" },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    // An unknown job is a 404; a job without a PR is a 400.
    const status = /not found/.test(message) ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}
