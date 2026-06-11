import type { NextRequest } from "next/server";
import { getBroker, type Subscriber } from "@/lib/stream/broker";

export const dynamic = "force-dynamic";

/**
 * Resume point for a reconnect: EventSource sends the last seen event id as
 * the `Last-Event-ID` header; a `?after=` query param works as a manual
 * fallback. Returns undefined when no usable id is presented.
 */
function parseAfterId(req: NextRequest): number | undefined {
  const raw = req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after");
  if (raw === null) return undefined;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

// Route Handlers are reserved for SSE (SPEC §9); mutations go through Server Actions.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return new Response("Invalid job id", { status: 400 });
  }
  const afterId = parseAfterId(req);
  const broker = getBroker();
  const encoder = new TextEncoder();

  let sub: Subscriber | undefined;
  const unsubscribe = () => {
    if (!sub) return;
    broker.unsubscribe(jobId, sub);
    sub = undefined;
  };

  const stream = new ReadableStream({
    start(controller) {
      const write = (event: { id?: number; type: string; payload: unknown }) => {
        const data = JSON.stringify(event.payload);
        const idLine = event.id !== undefined ? `id: ${event.id}\n` : "";
        try {
          controller.enqueue(encoder.encode(`${idLine}event: ${event.type}\ndata: ${data}\n\n`));
        } catch {
          // Controller already closed between disconnect and cleanup — drop
          // the event rather than throw back into the broker's fan-out.
        }
      };

      // Subscribe BEFORE replaying: replay-then-subscribe leaves a window in
      // which a concurrently published event lands in neither the replay
      // result nor the live fan-out, permanently dropping it for this client.
      // Live events arriving during the replay are buffered and flushed after
      // it, deduplicated against the replay by event id, so ordering holds.
      let cursor = afterId ?? 0;
      let replaying = true;
      const buffered: { id?: number; type: string; payload: unknown }[] = [];
      const deliver = (event: { id?: number; type: string; payload: unknown }) => {
        if (typeof event.id === "number") {
          if (event.id <= cursor) return; // already sent via replay
          cursor = event.id;
        }
        write(event);
      };
      sub = {
        send: (event) => {
          if (replaying) buffered.push(event);
          else deliver(event);
        },
      };
      broker.subscribe(jobId, sub);

      // Replay persisted events — everything after the client's Last-Event-ID
      // on a resume, the last 200 on a fresh connect — then go live. A corrupt
      // persisted payload must not kill the whole stream, so parse each row
      // defensively.
      for (const row of broker.replay(jobId, undefined, afterId)) {
        let payload: unknown;
        try {
          payload = JSON.parse(row.payload);
        } catch {
          payload = { error: "unparseable event payload" };
        }
        cursor = Math.max(cursor, row.id);
        write({ id: row.id, type: row.type, payload });
      }
      replaying = false;
      for (const event of buffered) deliver(event);
      buffered.length = 0;
      req.signal.addEventListener("abort", () => {
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    // The runtime cancels the stream on client disconnect, possibly without
    // the abort listener firing — unsubscribe here too so a dead subscriber
    // never lingers in the broker.
    cancel() {
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
