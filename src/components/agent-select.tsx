"use client";

import { Select } from "@/components/ui/select";
import { listAgents } from "@/lib/agents/registry";
import type { AgentId } from "@/lib/agents/types";

const ALL_AGENTS = listAgents();

/**
 * Default offering: the static-catalog CLI agents (claude, codex). Other
 * agents such as opencode — which reaches OpenRouter via `openrouter/<model>`
 * (ADR 039) — only appear where the caller passes an explicit `agents` list.
 */
const DEFAULT_AGENT_IDS: readonly AgentId[] = ["claude", "codex"];

export function AgentSelect({
  value,
  onChange,
  id,
  className,
  agents = DEFAULT_AGENT_IDS,
}: {
  value: AgentId;
  onChange: (value: AgentId) => void;
  id?: string;
  className?: string;
  /** Which agents to offer; defaults to the CLI agents. */
  agents?: readonly AgentId[];
}) {
  const options = ALL_AGENTS.filter((a) => agents.includes(a.id));
  return (
    <Select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value as AgentId)}
      className={className}
    >
      {options.map((a) => (
        <option key={a.id} value={a.id}>
          {a.label}
        </option>
      ))}
    </Select>
  );
}
