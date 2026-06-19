import type { NextRequest } from "next/server";
import { getServerLogger } from "@/lib/log/server-log";
import { isLogLevel, type LogFilter, type LogRecord, matchesLogFilter } from "@/lib/log/types";

export const dynamic = "force-dynamic";

const REPLAY_LIMIT = 500;

/**
 * Resume point for a reconnect: EventSource sends the last seen record seq as
 * the `Last-Event-ID` header; a `?after=` query param is the manual fallback.
 */
function parseAfterId(req: NextRequest, url: URL): number | undefined {
  const raw = req.headers.get("last-event-id") ?? url.searchParams.get("after");
  if (raw === null) return undefined;
  const id = Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : undefined;
}

function parseFilter(url: URL): LogFilter {
  const levelRaw = url.searchParams.get("level")?.toLowerCase();
  const query = url.searchParams.get("q")?.trim();
  return {
    ...(isLogLevel(levelRaw) ? { level: levelRaw } : {}),
    ...(query ? { query } : {}),
  };
}

// Route Handlers are reserved for SSE (SPEC §9); mutations go through Server
// Actions. Streams the global structured server log (issue #294): a filtered
// replay of recent records on connect, then a live tail of new records. The
// same filter predicate runs on replay and live fan-out so a record is shown
// identically however it arrives.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const filter = parseFilter(url);
  const afterId = parseAfterId(req, url);
  const logger = getServerLogger();
  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | undefined;
  const cleanup = () => {
    unsubscribe?.();
    unsubscribe = undefined;
  };

  const stream = new ReadableStream({
    start(controller) {
      const write = (record: LogRecord) => {
        try {
          const data = JSON.stringify(record);
          controller.enqueue(encoder.encode(`id: ${record.seq}\nevent: log\ndata: ${data}\n\n`));
        } catch {
          // Controller already closed (client disconnected) or the record is not
          // serializable — drop it rather than throw back into the fan-out.
        }
      };

      // Subscribe BEFORE replaying so a record published during the replay lands
      // in neither gap: live records are buffered, then flushed and deduplicated
      // against the replay by seq (mirrors the per-job broker route).
      let cursor = afterId ?? 0;
      let replaying = true;
      const buffered: LogRecord[] = [];
      const deliver = (record: LogRecord) => {
        if (record.seq <= cursor) return; // already sent via replay
        if (!matchesLogFilter(record, filter)) return;
        cursor = record.seq;
        write(record);
      };
      unsubscribe = logger.subscribe((record) => {
        if (replaying) buffered.push(record);
        else deliver(record);
      });

      for (const record of logger.recent({ ...filter, limit: REPLAY_LIMIT })) {
        if (afterId !== undefined && record.seq <= afterId) continue;
        cursor = Math.max(cursor, record.seq);
        write(record);
      }
      replaying = false;
      for (const record of buffered) deliver(record);
      buffered.length = 0;

      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      cleanup();
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
