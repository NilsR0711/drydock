import { z } from "zod";
import { authorizeControlRequest } from "@/lib/orchestrator/control";
import { setDraining } from "@/lib/settings/control";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" } as const;
const drainSchema = z.object({ draining: z.boolean() });

/**
 * Drain-mode control for the desktop tray (issue #292). Drain stops the driver
 * loop from picking up new work while letting in-flight jobs finish (settings
 * schema). Exposed over HTTP so the menu-bar shell can flip it; gated by
 * {@link authorizeControlRequest} like the pause endpoint.
 */
export async function POST(request: Request): Promise<Response> {
  const decision = authorizeControlRequest(request);
  if (!decision.authorized) {
    return new Response("forbidden", { status: decision.status, headers: noStore });
  }

  const parsed = drainSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return new Response("expected { draining: boolean }", { status: 400, headers: noStore });
  }

  await setDraining(parsed.data.draining);
  return Response.json({ ok: true, draining: parsed.data.draining }, { headers: noStore });
}
