"use client";

import { Input } from "@/components/ui/input";
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
  if (agent === "opencode") {
    // opencode (issue #349) routes through models.dev across 75+ providers — far
    // too many to enumerate, and there is no synced catalog. A free-text
    // `provider/model` entry is the picker (incl. OpenRouter as
    // `openrouter/<id>`, ADR 039); the repo service validates the shape.
    return (
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={className}
        placeholder="provider/model"
        spellCheck={false}
      />
    );
  }
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
