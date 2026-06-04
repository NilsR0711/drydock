"use client";

import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
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
  const [, startTransition] = useTransition();

  function update(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    params.delete("page");
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <SegmentedControl
        value={searchParams.get("status") ?? ""}
        onChange={(v) => update("status", v)}
        options={STATUS_FILTERS}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-9 w-56 pl-8"
            placeholder="Search issue title or #"
            defaultValue={searchParams.get("q") ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              // Debounce: only push after user stops typing for 300ms
              clearTimeout((window as { _jhDebounce?: ReturnType<typeof setTimeout> })._jhDebounce);
              (window as { _jhDebounce?: ReturnType<typeof setTimeout> })._jhDebounce = setTimeout(
                () => update("q", v),
                300,
              );
            }}
          />
        </div>

        <div className="w-44">
          <Select
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
