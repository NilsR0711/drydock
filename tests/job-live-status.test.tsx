// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the live-status wiring from JobStopButton's toast/server-action deps:
// the button's own behavior is covered elsewhere; here we only care whether it
// is mounted for the current live status.
vi.mock("@/components/job-stop-button", () => ({
  JobStopButton: ({ jobId }: { jobId: number }) => <button type="button">Stop #{jobId}</button>,
}));

import {
  JobLiveStatusProvider,
  JobStatusBadge,
  JobStopControl,
} from "@/components/job-live-status";
import type { JobStatus } from "@/lib/orchestrator/state-machine";
import { type Rendered, render } from "./fixtures/react";

/** Minimal EventSource stand-in — jsdom ships none (mirrors job-metrics test). */
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  closed = false;
  private listeners = new Map<string, Set<(ev: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown, id?: number): void {
    const ev = {
      data: JSON.stringify(data),
      lastEventId: id != null ? String(id) : "",
    } as MessageEvent;
    act(() => {
      for (const fn of this.listeners.get(type) ?? []) fn(ev);
    });
  }
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

function text(): string {
  return mounted?.container.textContent ?? "";
}

function lastStream(): MockEventSource | undefined {
  return MockEventSource.instances.at(-1);
}

function Header({ status, jobId = 7 }: { status: JobStatus; jobId?: number }) {
  return (
    <JobLiveStatusProvider jobId={jobId} initialStatus={status}>
      <JobStatusBadge initialStatus={status} />
      <JobStopControl jobId={jobId} initialStatus={status} />
    </JobLiveStatusProvider>
  );
}

describe("JobLiveStatus header (issue #337)", () => {
  it("seeds from the server status with no flash and opens one stream", () => {
    mounted = render(<Header status="working" />);
    expect(text()).toContain("working");
    expect(text()).toContain("Stop #7");
    expect(MockEventSource.instances).toHaveLength(1);
    expect(lastStream()?.url).toBe("/api/sse/jobs/7");
  });

  it("adopts live status transitions in lockstep with the stream", () => {
    mounted = render(<Header status="working" />);
    const es = lastStream();

    es?.emit("status", { from: "working", to: "ci_running" }, 1);
    expect(text()).toContain("ci running");
    // ci_running is still in-flight, so the Stop button stays.
    expect(text()).toContain("Stop #7");

    es?.emit("status", { from: "ci_running", to: "merged" }, 2);
    expect(text()).toContain("merged");
    // Terminal: the Stop button is gone without a reload.
    expect(text()).not.toContain("Stop #7");
  });

  it("keeps the Stop button across in-flight transitions including waiting_limit", () => {
    mounted = render(<Header status="working" />);
    lastStream()?.emit("status", { from: "working", to: "waiting_limit" }, 1);
    expect(text()).toContain("waiting limit");
    expect(text()).toContain("Stop #7");
  });

  it("closes the stream once the job reaches a terminal/parked state", () => {
    mounted = render(<Header status="working" />);
    const es = lastStream();
    es?.emit("status", { from: "working", to: "needs_human" }, 1);
    expect(es?.closed).toBe(true);
    // No reconnection after the terminal transition.
    expect(MockEventSource.instances).toHaveLength(1);
    expect(text()).not.toContain("Stop #7");
    expect(text()).toContain("needs human");
  });

  it("opens no stream for a job already terminal at load", () => {
    mounted = render(<Header status="merged" />);
    expect(MockEventSource.instances).toHaveLength(0);
    expect(text()).toContain("merged");
    expect(text()).not.toContain("Stop #7");
  });

  it("ignores status events that carry no `to` (reason-only) and malformed data", () => {
    mounted = render(<Header status="working" />);
    const es = lastStream();
    es?.emit("status", { reason: "ci wait budget exceeded" }, 1);
    expect(text()).toContain("working");
    // Malformed JSON must not crash the handler.
    act(() => {
      const bad = { data: "{not json", lastEventId: "2" } as MessageEvent;
      for (const fn of (
        es as unknown as { listeners: Map<string, Set<(e: MessageEvent) => void>> }
      ).listeners.get("status") ?? [])
        fn(bad);
    });
    expect(text()).toContain("working");
  });
});
