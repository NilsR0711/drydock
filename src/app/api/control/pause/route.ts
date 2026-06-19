import { z } from "zod";
import { authorizeControlRequest } from "@/lib/orchestrator/control";
import { setPaused } from "@/lib/settings/control";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" } as const;
const pauseSchema = z.object({ paused: z.boolean() });

/**
 * Global pause/resume control for the desktop tray (issue #292). Mirrors the
 * dashboard's one-click navbar toggle (issue #111) over HTTP so the menu-bar
 * shell can pause or resume automation without a browser tab. Gated by
 * {@link authorizeControlRequest}: a CSRF-guard header is required, plus a
 * matching token when DRYDOCK_CONTROL_TOKEN is configured.
 */
export async function POST(request: Request): Promise<Response> {
  const decision = authorizeControlRequest(request);
  if (!decision.authorized) {
    return new Response("forbidden", { status: decision.status, headers: noStore });
  }

  const parsed = pauseSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return new Response("expected { paused: boolean }", { status: 400, headers: noStore });
  }

  await setPaused(parsed.data.paused);
  return Response.json({ ok: true, paused: parsed.data.paused }, { headers: noStore });
}
