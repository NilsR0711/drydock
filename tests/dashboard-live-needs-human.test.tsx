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
import { deriveGithubBudgetView } from "@/lib/github/budget-view";

/** EventSource stand-in — jsdom ships none; lets a test push snapshots. */
class MockEventSource {
  static instances: MockEventSource[] = [];
  private listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }
  close(): void {}
  emit(type: string, data: unknown): void {
    const ev = { data: JSON.stringify(data) } as MessageEvent;
    act(() => {
      for (const fn of this.listeners.get(type) ?? []) fn(ev);
    });
  }
}

const now = Math.floor(Date.now() / 1000);

function snapshot(needsHumanJobs: DashboardSnapshot["needsHumanJobs"]): DashboardSnapshot {
  return {
    summary: {
      repos: 1,
      queued: 0,
      running: 0,
      merged: 0,
      needsHuman: needsHumanJobs.length,
      spendToday: 0,
    },
    repos: [],
    needsHumanJobs,
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
  chime.playChime.mockClear();
  chime.installAudioUnlock.mockClear();
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  (globalThis as { EventSource: unknown }).EventSource = originalEventSource;
  document.body.innerHTML = "";
});

function mount(soundEnabled: boolean, initial = snapshot([])) {
  mounted = render(
    <ToastProvider>
      <DashboardLive initial={initial} soundEnabled={soundEnabled} />
    </ToastProvider>,
  );
  return MockEventSource.instances.at(-1) as MockEventSource;
}

const text = () => mounted?.container.textContent ?? "";

describe("DashboardLive needs-human alert (issue #258)", () => {
  it("toasts + chimes when a job crosses into needs_human", () => {
    const es = mount(true);
    es.emit("snapshot", snapshot([{ id: 9, issueNumber: 42, repoName: "acme" }]));

    const link = mounted?.container.querySelector<HTMLAnchorElement>("a[href='/jobs/9']");
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("acme");
    expect(link?.textContent).toContain("42");
    expect(chime.playChime).toHaveBeenCalledTimes(1);
  });

  it("still toasts but stays silent when the sound is disabled", () => {
    const es = mount(false);
    es.emit("snapshot", snapshot([{ id: 9, issueNumber: 42, repoName: "acme" }]));

    expect(mounted?.container.querySelector("a[href='/jobs/9']")).not.toBeNull();
    expect(chime.playChime).not.toHaveBeenCalled();
  });

  it("does not re-alert for jobs already parked when the tab connected", () => {
    // Initial snapshot already has job 9 parked: it must not alert. A second
    // job crossing the edge later should alert only for the new one.
    const es = mount(true, snapshot([{ id: 9, issueNumber: 42, repoName: "acme" }]));
    es.emit("snapshot", snapshot([{ id: 9, issueNumber: 42, repoName: "acme" }]));
    expect(chime.playChime).not.toHaveBeenCalled();
    expect(mounted?.container.querySelector("a[href='/jobs/9']")).toBeNull();

    es.emit(
      "snapshot",
      snapshot([
        { id: 9, issueNumber: 42, repoName: "acme" },
        { id: 10, issueNumber: 43, repoName: "acme" },
      ]),
    );

    expect(chime.playChime).toHaveBeenCalledTimes(1);
    expect(mounted?.container.querySelector("a[href='/jobs/10']")).not.toBeNull();
    expect(text()).toContain("43");
  });

  it("re-alerts when a job leaves needs_human and later re-enters it (issue #406)", () => {
    // A requeue reuses the same job id: it parks, gets requeued (leaves the
    // needs_human set), and parks again — the common loop for a blocked issue.
    // Each fresh parking must cross the edge and re-alert, not just the first.
    const es = mount(true);

    // First parking: alert #1.
    es.emit("snapshot", snapshot([{ id: 9, issueNumber: 42, repoName: "acme" }]));
    expect(chime.playChime).toHaveBeenCalledTimes(1);

    // Requeued: the job leaves needs_human, so the list clears back to "All clear"
    // and the tab must forget its id.
    es.emit("snapshot", snapshot([]));
    expect(text()).toContain("All clear");

    // Re-parked under the same id: alert #2, not silence.
    es.emit("snapshot", snapshot([{ id: 9, issueNumber: 42, repoName: "acme" }]));
    expect(chime.playChime).toHaveBeenCalledTimes(2);
  });

  it("alerts only once while a job stays parked across snapshots (issue #406)", () => {
    // Reconciling the seen-set on every snapshot must not make a job that simply
    // stays parked re-alert: only the edge into needs_human fires the chime.
    const es = mount(true);
    const parked = [{ id: 9, issueNumber: 42, repoName: "acme" }];

    es.emit("snapshot", snapshot(parked));
    es.emit("snapshot", snapshot(parked));
    es.emit("snapshot", snapshot(parked));

    expect(chime.playChime).toHaveBeenCalledTimes(1);
  });

  it("arms the autoplay unlock on mount", () => {
    mount(true);
    expect(chime.installAudioUnlock).toHaveBeenCalled();
  });
});
