// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Rendered, render } from "./fixtures/react";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { JobsLiveRefresh } from "@/components/jobs-live-refresh";

/** EventSource stand-in — jsdom ships none; lets a test push snapshot frames. */
class MockEventSource {
  static instances: MockEventSource[] = [];
  closed = false;
  private listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string): void {
    const ev = { data: "{}" } as MessageEvent;
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
  refresh.mockClear();
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  (globalThis as { EventSource: unknown }).EventSource = originalEventSource;
  document.body.innerHTML = "";
});

function mount(): MockEventSource {
  mounted = render(<JobsLiveRefresh />);
  return MockEventSource.instances.at(-1) as MockEventSource;
}

describe("JobsLiveRefresh (issue #282)", () => {
  it("subscribes to the shared dashboard SSE stream", () => {
    const es = mount();
    expect(es.url).toBe("/api/sse/dashboard");
  });

  it("does not refresh on the initial connect frame (it mirrors SSR)", () => {
    const es = mount();
    es.emit("snapshot");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes the route on every subsequent snapshot", () => {
    const es = mount();
    es.emit("snapshot"); // primes (initial connect frame)
    es.emit("snapshot");
    es.emit("snapshot");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("renders nothing", () => {
    mount();
    expect(mounted?.container.textContent).toBe("");
  });

  it("closes the stream on unmount", () => {
    const es = mount();
    mounted?.unmount();
    mounted = undefined;
    expect(es.closed).toBe(true);
  });
});
