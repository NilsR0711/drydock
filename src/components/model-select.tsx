"use client";

import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { AgentId } from "@/lib/agents/types";
import { MODELS, modelsForAgent } from "@/lib/models";

/** A synced OpenRouter catalog entry, serialized for the picker (issue #169). */
export interface OpenRouterModelOption {
  id: string;
  label: string;
  isFree: boolean;
}

export function ModelSelect({
  value,
  onChange,
  agent,
  openrouterModels = [],
  id,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Restrict the options to a single agent's models. */
  agent?: AgentId;
  /** Synced catalog options, used when `agent` is "openrouter" (issue #169). */
  openrouterModels?: OpenRouterModelOption[];
  id?: string;
  className?: string;
}) {
  if (agent === "opencode") {
    // opencode (issue #349) routes through models.dev across 75+ providers — far
    // too many to enumerate, and there is no synced catalog (Step 1). A free-text
    // `provider/model` entry is the picker; the repo service validates the shape.
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
  if (agent === "openrouter") {
    // Catalog-backed picker: free models are marked inline; an empty catalog
    // renders an explanatory disabled option instead of a silent empty select.
    return (
      <Select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={className}
      >
        {openrouterModels.length === 0 && (
          <option value="" disabled>
            No synced models — refresh the catalog in Settings
          </option>
        )}
        {openrouterModels.length > 0 &&
          value !== "" &&
          !openrouterModels.some((m) => m.id === value) && (
            <option value={value} disabled>
              {value} (no longer in catalog)
            </option>
          )}
        {openrouterModels.map((m) => (
          <option key={m.id} value={m.id}>
            {m.isFree ? `${m.label} (free)` : m.label}
          </option>
        ))}
      </Select>
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
