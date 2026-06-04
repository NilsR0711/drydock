"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { ANALYTICS_RANGES } from "@/components/analytics-filters";
import { Select } from "@/components/ui/select";

/**
 * Date-range preset Select for the Analytics header. Writes the `range` URL
 * param (same mechanism as {@link AnalyticsFilters}) so the server re-runs
 * `analyticsSummary` with the new `since` bound.
 */
export function AnalyticsRangeSelect() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function setRange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("range", value);
    else params.delete("range");
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  return (
    <div className="w-40">
      <Select
        className="h-8 text-xs"
        value={searchParams.get("range") ?? "30"}
        onChange={(e) => setRange(e.target.value)}
        aria-label="Date range"
      >
        {ANALYTICS_RANGES.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
