import type { NextRequest } from "next/server";
import { dashboardSnapshot } from "@/lib/db/queries";
import { onDashboardChange } from "@/lib/stream/dashboard-bus";

export const dynamic = "force-dynamic";

// Refresh cadence that keeps today's spend current even while a long job runs
// without changing state (cost accrues mid-session). Also doubles as a
// keep-alive so proxies don't drop an idle stream.
const HEARTBEAT_MS = 5000;

// Route Handlers are reserved for SSE (SPEC §9); mutations go through Server
// Actions. Streams a fresh dashboard snapshot on connect, on every dashboard
// change (job created/transitioned, repo added/removed), and on a heartbeat.
export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const push = () => {
        if (closed) return;
        try {
          const data = JSON.stringify(dashboardSnapshot());
          controller.enqueue(encoder.encode(`event: snapshot\ndata: ${data}\n\n`));
        } catch {
          // Controller already closed between the guard and enqueue — ignore.
        }
      };

      push();
      const off = onDashboardChange(push);
      const heartbeat = setInterval(push, HEARTBEAT_MS);

      req.signal.addEventListener("abort", () => {
        closed = true;
        off();
        clearInterval(heartbeat);
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
