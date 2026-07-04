"use client";

import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { JOB_STATES } from "@/lib/orchestrator/state-machine";

interface RepoOption {
  id: number;
  name: string;
}

interface ModelOption {
  id: string;
  label: string;
}

const STATUS_FILTERS = [
  { value: "", label: "All" },
  ...JOB_STATES.map((s) => ({ value: s, label: s.replace(/_/g, " ") })),
];

const SCOPE_FILTERS = [
  { value: "", label: "Title / #" },
  { value: "logs", label: "Logs" },
];

/**
 * Build the next query string for a filter change. Pure so the debounce can
 * apply it against the LIVE location at fire time — using the render-time
 * searchParams snapshot would clobber a filter changed inside the debounce
 * window.
 */
export function buildJobsFilterQuery(currentSearch: string, key: string, value: string): string {
  const params = new URLSearchParams(currentSearch);
  if (value) {
    params.set(key, value);
  } else {
    params.delete(key);
  }
  params.delete("page");
  return params.toString();
}

export function JobsHistoryFilters({
  repos,
  models,
}: {
  repos: RepoOption[];
  models: ModelOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const scope = searchParams.get("scope") === "logs" ? "logs" : "";
  const [, startTransition] = useTransition();
  // Debounce timer for the search input. Kept in a ref (not a window global)
  // and cleared on unmount so a pending push can never navigate the user away
  // from a job they just opened.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  function update(key: string, value: string) {
    const query = buildJobsFilterQuery(window.location.search, key, value);
    startTransition(() => {
      router.push(`${pathname}?${query}`);
    });
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <SegmentedControl
        label="Filter jobs by status"
        value={searchParams.get("status") ?? ""}
        onChange={(v) => update("status", v)}
        options={STATUS_FILTERS}
      />

      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          label="Search scope"
          value={scope}
          onChange={(v) => update("scope", v)}
          options={SCOPE_FILTERS}
        />

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search jobs"
            className="h-9 w-56 pl-8"
            placeholder={scope === "logs" ? "Search in job logs" : "Search issue title or #"}
            defaultValue={searchParams.get("q") ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              // Debounce: only push after user stops typing for 300ms
              clearTimeout(debounceRef.current);
              debounceRef.current = setTimeout(() => update("q", v), 300);
            }}
          />
        </div>

        <div className="w-44">
          <Select
            aria-label="Filter by repository"
            className="h-9 text-sm"
            value={searchParams.get("repo") ?? ""}
            onChange={(e) => update("repo", e.target.value)}
          >
            <option value="">All repositories</option>
            {repos.map((r) => (
              <option key={r.id} value={String(r.id)}>
                {r.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="w-44">
          <Select
            aria-label="Filter by model"
            className="h-9 text-sm"
            value={searchParams.get("model") ?? ""}
            onChange={(e) => update("model", e.target.value)}
          >
            <option value="">All models</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
    </div>
  );
}
