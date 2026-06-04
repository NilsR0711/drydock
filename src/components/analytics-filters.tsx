"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Select } from "@/components/ui/select";

interface RepoOption {
  id: number;
  name: string;
}

/** Date-range presets, in days; "all" means no lower bound. */
export const ANALYTICS_RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
] as const;

export function AnalyticsFilters({ repos }: { repos: RepoOption[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function update(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-56">
        <Select
          value={searchParams.get("repo") ?? ""}
          onChange={(e) => update("repo", e.target.value)}
          aria-label="Repository"
        >
          <option value="">All repositories</option>
          {repos.map((r) => (
            <option key={r.id} value={String(r.id)}>
              {r.name}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
