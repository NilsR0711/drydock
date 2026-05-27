"use client";

import { Select } from "@/components/ui/select";
import { type ForgeId, listForges } from "@/lib/forge/types";

const FORGES = listForges();

export function ForgeSelect({
  value,
  onChange,
  id,
  className,
}: {
  value: ForgeId;
  onChange: (value: ForgeId) => void;
  id?: string;
  className?: string;
}) {
  return (
    <Select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value as ForgeId)}
      className={className}
    >
      {FORGES.map((f) => (
        <option key={f.id} value={f.id}>
          {f.label}
        </option>
      ))}
    </Select>
  );
}
