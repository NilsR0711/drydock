"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Input } from "@/components/ui/input";
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
    <div className="flex flex-wrap items-center gap-2">
      <Input
        className="h-9 w-52"
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

      <Select
        value={searchParams.get("repo") ?? ""}
        onChange={(e) => update("repo", e.target.value)}
      >
        <option value="">All repos</option>
        {repos.map((r) => (
          <option key={r.id} value={String(r.id)}>
            {r.name}
          </option>
        ))}
      </Select>

      <Select
        value={searchParams.get("status") ?? ""}
        onChange={(e) => update("status", e.target.value)}
      >
        <option value="">All statuses</option>
        {JOB_STATES.map((s) => (
          <option key={s} value={s}>
            {s.replace(/_/g, " ")}
          </option>
        ))}
      </Select>

      <Select
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
  );
}
