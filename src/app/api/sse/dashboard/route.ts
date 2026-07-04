import type { NextRequest } from "next/server";
import { subscribeDashboardSnapshots } from "@/lib/stream/dashboard-snapshots";

export const dynamic = "force-dynamic";

// Route Handlers are reserved for SSE (SPEC §9); mutations go through Server
// Actions. Streams a fresh dashboard snapshot on connect, then shares in the
// single per-change / per-heartbeat broadcast that is computed once for all
// connected clients (issue #415) — no more per-client recomputation of the
// whole (forever-growing) jobs table on every tick.
export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const send = (serialized: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: snapshot\ndata: ${serialized}\n\n`));
        } catch {
          // Controller already closed between the guard and enqueue — ignore.
        }
      };

      const unsubscribe = subscribeDashboardSnapshots(send);

      req.signal.addEventListener("abort", () => {
        closed = true;
        unsubscribe();
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
