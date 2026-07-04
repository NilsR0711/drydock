import { exportConfigBundle } from "@/lib/settings/config-bundle";

export const dynamic = "force-dynamic";

// Read-only configuration download (issue #412). Server Actions cover mutations
// (ADR 001); a GET Route Handler is used here — as with /api/cost/export —
// because only a real HTTP response can carry the Content-Disposition that
// triggers a browser file download. The bundle has every secret redacted.
export async function GET(_req: Request): Promise<Response> {
  const bundle = exportConfigBundle();
  return new Response(JSON.stringify(bundle, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="drydock-config.json"',
      "Cache-Control": "no-store",
    },
  });
}
