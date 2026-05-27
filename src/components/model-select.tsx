"use client";

import { Select } from "@/components/ui/select";
import type { AgentId } from "@/lib/agents/types";
import { MODELS, modelsForAgent } from "@/lib/models";

export function ModelSelect({
  value,
  onChange,
  agent,
  id,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Restrict the options to a single agent's models. */
  agent?: AgentId;
  id?: string;
  className?: string;
}) {
  const options = agent ? modelsForAgent(agent) : MODELS;
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      {options.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </Select>
  );
}
