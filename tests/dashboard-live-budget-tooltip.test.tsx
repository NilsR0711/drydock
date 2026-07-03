// @vitest-environment jsdom
import { act } from "react";
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
    summary: { repos: 1, queued: 0, running: 0, merged: 0, needsHuman: 0, spendToday: 0 },
    repos: [],
    needsHumanJobs: [],
    claudeUsage: deriveClaudeUsageView({ now }),
    codexUsage: buildCodexUsageView({ now }),
  };
}

let mounted: Rendered | undefined;
const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as { EventSource: unknown }).EventSource = MockEventSource;
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = undefined;
  (globalThis as { EventSource: unknown }).EventSource = originalEventSource;
  document.body.innerHTML = "";
});

describe("DashboardLive budget-gauge hint (issue #402)", () => {
  it("explains the daily budget through a keyboard-focusable help button", () => {
    mounted = render(
      <ToastProvider>
        <DashboardLive initial={snapshot()} soundEnabled={false} />
      </ToastProvider>,
    );
    const container = mounted.container;
    const budgetTip = Array.from(container.querySelectorAll<HTMLElement>('[role="tooltip"]')).find(
      (t) => t.textContent?.includes("Combined spend today"),
    );
    expect(budgetTip).toBeTruthy();
    const help = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-label="Help"]'),
    ).find((b) => b.getAttribute("aria-describedby") === budgetTip?.id);
    expect(help).toBeTruthy();
    help?.focus();
    expect(document.activeElement).toBe(help);
  });
});
