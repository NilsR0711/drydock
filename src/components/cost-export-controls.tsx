"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import type { CostExportFormat, CostReport } from "@/lib/db/cost-export";

const REPORTS: { value: CostReport; label: string }[] = [
  { value: "line-items", label: "Per-job line items" },
  { value: "by-repo", label: "Aggregate by repo" },
  { value: "by-model", label: "Aggregate by model" },
];

function buildHref(params: {
  report: CostReport;
  format: CostExportFormat;
  from: string;
  to: string;
  repoId: string;
}): string {
  const search = new URLSearchParams({ report: params.report, format: params.format });
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  if (params.repoId) search.set("repoId", params.repoId);
  return `/api/cost/export?${search.toString()}`;
}

/**
 * Cost-report export controls (issue #63). Lets an operator pick a report shape,
 * an optional date range and repo, then download the matching CSV/JSON. The
 * download is a GET to /api/cost/export, triggered via a transient anchor so the
 * browser honours the response's Content-Disposition.
 */
export function CostExportControls({ repos }: { repos: { id: number; name: string }[] }) {
  const [report, setReport] = useState<CostReport>("line-items");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [repoId, setRepoId] = useState("");
  const { error } = useToast();

  const download = (format: CostExportFormat) => {
    // YYYY-MM-DD strings compare lexically — reject an inverted range up front so
    // the operator isn't handed a silently-empty report.
    if (from && to && from > to) {
      error("Invalid date range", "The “From” date must be on or before the “To” date.");
      return;
    }
    const href = buildHref({ report, format, from, to, repoId });
    const a = document.createElement("a");
    a.href = href;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <label htmlFor="cost-export-report">Report</label>
        <Select
          id="cost-export-report"
          value={report}
          onChange={(e) => setReport(e.target.value as CostReport)}
        >
          {REPORTS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <label htmlFor="cost-export-repo">Repo</label>
        <Select id="cost-export-repo" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
          <option value="">All repos</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <label htmlFor="cost-export-from">From</label>
        <Input
          id="cost-export-from"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-[9.5rem]"
        />
      </div>
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <label htmlFor="cost-export-to">To</label>
        <Input
          id="cost-export-to"
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-[9.5rem]"
        />
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => download("csv")}>
          <Download className="mr-1.5" />
          CSV
        </Button>
        <Button variant="outline" size="sm" onClick={() => download("json")}>
          <Download className="mr-1.5" />
          JSON
        </Button>
      </div>
    </div>
  );
}
