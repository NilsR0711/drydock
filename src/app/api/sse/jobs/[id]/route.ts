import type { NextRequest } from "next/server";
import { getBroker, type Subscriber } from "@/lib/stream/broker";

export const dynamic = "force-dynamic";

// Route Handlers are reserved for SSE (SPEC §9); mutations go through Server Actions.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const jobId = Number(id);
  const broker = getBroker();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const write = (event: { id?: number; type: string; payload: unknown }) => {
        const data = JSON.stringify(event.payload);
        const idLine = event.id !== undefined ? `id: ${event.id}\n` : "";
        controller.enqueue(encoder.encode(`${idLine}event: ${event.type}\ndata: ${data}\n\n`));
      };

      // Replay the last 200 persisted events, then go live.
      for (const row of broker.replay(jobId)) {
        write({ id: row.id, type: row.type, payload: JSON.parse(row.payload) });
      }

      const sub: Subscriber = { send: write };
      broker.subscribe(jobId, sub);
      req.signal.addEventListener("abort", () => {
        broker.unsubscribe(jobId, sub);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
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
