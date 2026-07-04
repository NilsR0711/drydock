// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Rendered, render } from "./fixtures/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const chime = vi.hoisted(() => ({
  playChime: vi.fn(),
  installAudioUnlock: vi.fn(),
}));
vi.mock("@/lib/ui/chime", () => chime);

import { DashboardLive } from "@/components/dashboard-live";
import { ToastProvider } from "@/components/ui/toast";
import { deriveClaudeUsageView } from "@/lib/agents/claude-usage";
import { buildCodexUsageView } from "@/lib/agents/codex-usage";
import type { DashboardSnapshot } from "@/lib/db/queries";
import { deriveGithubBudgetView } from "@/lib/github/budget-view";

/** EventSource stand-in — jsdom ships none. */
class MockEventSource {
  static instances: MockEventSource[] = [];
  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(): void {}
  close(): void {}
}

const now = Math.floor(Date.now() / 1000);

function snapshot(): DashboardSnapshot {
  return {
    summary: { repos: 1, queued: 0, running: 0, merged: 0, needsHuman: 0, spendToday: 3 },
    repos: [],
    needsHumanJobs: [],
    claudeUsage: deriveClaudeUsageView({ now }),
    codexUsage: buildCodexUsageView({ now }),
    githubBudget: deriveGithubBudgetView({ core: null, graphql: null }),
  };
}

let mounted: Rendered | undefined;
const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as { EventSource: unknown }).EventSource = MockEventSource;
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  (globalThis as { EventSource: unknown }).EventSource = originalEventSource;
  document.body.innerHTML = "";
});

describe("DashboardLive budget-gauge tooltip is keyboard-reachable (issue #402)", () => {
  it("exposes the daily-budget explanation through a focusable Help trigger", () => {
    mounted = render(
      <ToastProvider>
        <DashboardLive initial={snapshot()} soundEnabled={false} />
      </ToastProvider>,
    );
    const { container } = mounted;

    const tip = Array.from(container.querySelectorAll<HTMLElement>('[role="tooltip"]')).find((t) =>
      /per-repo daily limits/i.test(t.textContent ?? ""),
    );
    expect(tip).toBeDefined();
    // Closed tooltip is really hidden, not merely transparent.
    expect(tip?.className).toMatch(/\binvisible\b/);

    // The trigger that this specific bubble describes must be a focusable
    // Help button (the dashboard renders several Help tooltips).
    const trigger = Array.from(container.querySelectorAll<HTMLElement>("[aria-describedby]")).find(
      (el) =>
        el
          .getAttribute("aria-describedby")
          ?.split(/\s+/)
          .includes(tip?.id ?? ""),
    );
    expect(trigger?.tagName).toBe("BUTTON");
    expect(trigger?.getAttribute("aria-label")).toBe("Help");
    trigger?.focus();
    expect(document.activeElement).toBe(trigger);
  });
});
