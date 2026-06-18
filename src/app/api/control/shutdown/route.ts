import { authorizeShutdown } from "@/lib/orchestrator/control";
import { gracefulShutdown } from "@/lib/orchestrator/singleton";

export const dynamic = "force-dynamic";

/**
 * Portable graceful-shutdown control endpoint (issue #216). `drydock stop` posts
 * here so the server can drain in-flight jobs and exit cleanly on every OS —
 * Windows has no usable POSIX signals, so a hard `taskkill` would skip the
 * orchestrator's drain and leave job/DB state inconsistent. The endpoint is
 * inert unless DRYDOCK_CONTROL_TOKEN is set (only the daemon launcher sets it),
 * so a normal foreground `drydock`/dev run never exposes a way to be killed.
 */
export async function POST(request: Request): Promise<Response> {
  const decision = authorizeShutdown(
    request.headers.get("x-drydock-control-token"),
    process.env.DRYDOCK_CONTROL_TOKEN,
  );

  if (!decision.authorized) {
    return new Response(decision.status === 404 ? "not found" : "forbidden", {
      status: decision.status,
      headers: { "cache-control": "no-store" },
    });
  }

  // Respond first, then drain and exit on the next tick so the client sees the
  // 202 before the socket closes. waitForIdle inside gracefulShutdown lets
  // in-flight jobs finish their worktree cleanup before the hard exit.
  scheduleShutdown();
  return Response.json(
    { ok: true, message: "draining and shutting down" },
    { status: decision.status, headers: { "cache-control": "no-store" } },
  );
}

/** Drain in-flight work, then exit. Deferred so the HTTP response flushes first. */
function scheduleShutdown(): void {
  const timer = setTimeout(() => {
    gracefulShutdown()
      .catch(() => {
        // gracefulShutdown logs its own failures; never block the exit on them.
      })
      .finally(() => process.exit(0));
  }, 50);
  timer.unref?.();
}
