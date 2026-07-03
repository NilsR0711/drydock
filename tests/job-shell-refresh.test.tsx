// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Rendered, render } from "./fixtures/react";

// The shell refresh drives a soft router.refresh(); isolate it from the real
// App Router the same way jobs-live-refresh's test does.
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { JobLiveStatusProvider, JobShellRefresh } from "@/components/job-live-status";
import type { JobStatus } from "@/lib/orchestrator/state-machine";

/** Minimal EventSource stand-in — jsdom ships none (mirrors job-live-status test). */
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

  /** Push a raw (possibly malformed) frame straight to the "status" listeners. */
  emitRaw(data: string): void {
    const ev = { data, lastEventId: "" } as MessageEvent;
    act(() => {
      for (const fn of this.listeners.get("status") ?? []) fn(ev);
    });
  }
}

let mounted: Rendered | undefined;
const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as { EventSource: unknown }).EventSource = MockEventSource;
  refresh.mockClear();
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  (globalThis as { EventSource: unknown }).EventSource = originalEventSource;
  document.body.innerHTML = "";
});

function lastStream(): MockEventSource | undefined {
  return MockEventSource.instances.at(-1);
}

function mount(status: JobStatus, jobId = 7): MockEventSource | undefined {
  mounted = render(
    <JobLiveStatusProvider jobId={jobId} initialStatus={status}>
      <JobShellRefresh initialStatus={status} />
    </JobLiveStatusProvider>,
  );
  return lastStream();
}

describe("JobShellRefresh (issue #398)", () => {
  it("does not refresh on the initial render (it mirrors the server shell)", () => {
    mount("working");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes so the needs_human alert and resume panel surface live", () => {
    const es = mount("working");
    es?.emit("status", { from: "working", to: "needs_human" }, 1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes on entry to and exit from waiting_limit to show/hide the limit alert", () => {
    const es = mount("working");
    es?.emit("status", { from: "working", to: "waiting_limit" }, 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    // waiting_limit is not a stream-end state, so the same stream stays open and
    // catches the auto-requeue transition back out — the "from" direction.
    expect(es?.closed).toBe(false);
    es?.emit("status", { from: "waiting_limit", to: "queued" }, 2);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("refreshes on a terminal transition so the frozen page shell reconciles", () => {
    const es = mount("working");
    es?.emit("status", { from: "working", to: "merged" }, 1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on reason-only frames, unknown statuses, or malformed data", () => {
    const es = mount("working");
    es?.emit("status", { reason: "ci wait budget exceeded" }, 1);
    es?.emit("status", { from: "working", to: "not_a_status" }, 2);
    es?.emitRaw("{not json");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not refresh when a frame repeats the current status", () => {
    const es = mount("working");
    es?.emit("status", { from: "queued", to: "working" }, 1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("renders nothing", () => {
    mount("working");
    expect(mounted?.container.textContent).toBe("");
  });
});
