import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  buildCostExport,
  type CostExportFormat,
  type CostReport,
  toCsv,
  toJson,
} from "@/lib/db/cost-export";

export const dynamic = "force-dynamic";

// Read-only export download (issue #63). Server Actions cover mutations
// (ADR 001); a GET Route Handler is used here because only a real HTTP response
// can carry the Content-Disposition that triggers a browser file download.
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z.object({
  format: z.enum(["csv", "json"]).default("csv"),
  report: z.enum(["line-items", "by-repo", "by-model"]).default("line-items"),
  from: z.string().regex(DAY, "expected YYYY-MM-DD").optional(),
  to: z.string().regex(DAY, "expected YYYY-MM-DD").optional(),
  repoId: z.coerce.number().int().positive().optional(),
});

// URLSearchParams yields "" for present-but-empty fields (e.g. an unset date
// input); drop those so the schema applies its defaults instead of failing.
function nonEmptyParams(searchParams: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of searchParams) {
    if (value !== "") out[key] = value;
  }
  return out;
}

const MIME: Record<CostExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
};

function filename(
  report: CostReport,
  format: CostExportFormat,
  from?: string,
  to?: string,
): string {
  const range = `${from ?? "all"}_${to ?? "all"}`;
  return `drydock-cost-${report}-${range}.${format}`;
}

export async function GET(req: NextRequest): Promise<Response> {
  const parsed = querySchema.safeParse(nonEmptyParams(new URL(req.url).searchParams));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { format, report, from, to, repoId } = parsed.data;
  const table = buildCostExport(report, { from, to, repoId });
  const body = format === "csv" ? toCsv(table) : toJson(table);

  return new Response(body, {
    headers: {
      "Content-Type": MIME[format],
      "Content-Disposition": `attachment; filename="${filename(report, format, from, to)}"`,
      "Cache-Control": "no-store",
    },
  });
}
