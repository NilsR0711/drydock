"use client";

import { Select } from "@/components/ui/select";
import { listAgents } from "@/lib/agents/registry";
import type { AgentId } from "@/lib/agents/types";

const AGENTS = listAgents();

export function AgentSelect({
  value,
  onChange,
  id,
  className,
}: {
  value: AgentId;
  onChange: (value: AgentId) => void;
  id?: string;
  className?: string;
}) {
  return (
    <Select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value as AgentId)}
      className={className}
    >
      {AGENTS.map((a) => (
        <option key={a.id} value={a.id}>
          {a.label}
        </option>
      ))}
    </Select>
  );
}
