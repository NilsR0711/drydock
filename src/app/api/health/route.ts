import { getHealth } from "@/lib/orchestrator/health";

export const dynamic = "force-dynamic";

/**
 * Liveness/metrics probe for Uptime-Kuma, Prometheus scrapers, and scripts
 * (issue #183). Read-only and secret-free; 200 while the driver loop ticks,
 * 503 when it is stalled, not running, or the DB is unreachable.
 */
export async function GET(): Promise<Response> {
  const { httpStatus, body } = getHealth();
  return Response.json(body, {
    status: httpStatus,
    headers: { "cache-control": "no-store" },
  });
}
