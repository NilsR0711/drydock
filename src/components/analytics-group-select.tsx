"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Select } from "@/components/ui/select";

/**
 * Grouping presets for the analytics breakdown. The empty value turns the
 * breakdown off; the others map to an {@link AnalyticsDimension} in the page.
 */
export const ANALYTICS_GROUPINGS = [
  { value: "", label: "No breakdown" },
  { value: "model", label: "By model" },
  { value: "agent", label: "By agent" },
  { value: "prompt", label: "By prompt version" },
] as const;

/**
 * "Group by" Select for the Analytics page. Writes the `group` URL param (same
 * mechanism as {@link AnalyticsFilters}) so the server renders the matching
 * outcome breakdown alongside the summary.
 */
export function AnalyticsGroupSelect() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function setGroup(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("group", value);
    else params.delete("group");
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  return (
    <div className="w-52">
      <Select
        value={searchParams.get("group") ?? ""}
        onChange={(e) => setGroup(e.target.value)}
        aria-label="Group analytics by"
      >
        {ANALYTICS_GROUPINGS.map((g) => (
          <option key={g.value} value={g.value}>
            {g.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
