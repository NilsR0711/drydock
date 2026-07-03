// @vitest-environment jsdom
import type { ReactElement } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Virtuoso measures the DOM (ResizeObserver + layout) which jsdom cannot
// provide, so stub it with a passthrough that renders the header and each row.
// The point of issue #403 is precisely that this virtualized subtree must NOT
// be a live region, so the tests below assert the ARIA wiring around it.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
    components,
  }: {
    data: LogLine[];
    itemContent: (i: number, item: LogLine) => ReactElement;
    components?: { Header?: () => ReactElement | null };
  }) => {
    const Header = components?.Header;
    return (
      <div data-testid="virtuoso">
        {Header ? <Header /> : null}
        {(data ?? []).map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: virtualization stub renders a stable, non-reordering list — position IS the identity here.
          <div key={i}>{itemContent(i, item)}</div>
        ))}
      </div>
    );
  },
}));

import { ANNOUNCE_INTERVAL_MS, type LogLine, LogViewer } from "@/components/log-viewer";
import { ToastProvider } from "@/components/ui/toast";
import { type Rendered, render } from "./fixtures/react";

/** A controllable EventSource stand-in — jsdom has none. */
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  closed = false;
  private listeners = new Map<string, Set<(ev: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: Event) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: (ev: Event) => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  close(): void {
    this.closed = true;
  }

  /** Deliver a named SSE frame to the component's listeners. */
  emit(type: string, payload: unknown, lastEventId: number): void {
    const ev = new MessageEvent(type, {
      data: JSON.stringify(payload),
      lastEventId: String(lastEventId),
    });
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
}

function renderViewer(ui: ReactElement): Rendered {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

/** The LogViewer subtree (excludes the ToastProvider's own live regions). */
function viewer(r: Rendered): HTMLElement {
  const el = r.container.querySelector<HTMLElement>('[data-testid="log-viewer-root"]');
  if (!el) throw new Error("LogViewer root not found");
  return el;
}

/** The EventSource the viewer opened for the active job. */
function openedEventSource(): MockEventSource {
  const es = MockEventSource.instances[0];
  if (!es) throw new Error("EventSource was not opened");
  return es;
}

let originalEventSource: unknown;

beforeEach(() => {
  MockEventSource.instances = [];
  originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;
  (globalThis as { EventSource?: unknown }).EventSource = MockEventSource;
});

afterEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  vi.useRealTimers();
});

describe("LogViewer live-region wiring (issue #403)", () => {
  const initial: LogLine[] = [
    { id: 1, type: "status", payload: { to: "working" } },
    { id: 2, type: "text", payload: { text: "hello" } },
  ];

  it("keeps role=log and the aria-label but disables live behavior on the virtualized container", () => {
    const r = renderViewer(
      <div data-testid="log-viewer-root">
        <LogViewer jobId={1} initial={initial} active={false} />
      </div>,
    );
    const log = viewer(r).querySelector('[role="log"]');
    expect(log).not.toBeNull();
    expect(log?.getAttribute("aria-label")).toBe("Job log stream");
    // The whole point: the virtualized subtree must not announce its churn.
    expect(log?.getAttribute("aria-live")).toBe("off");
    // The virtualized list lives inside the (now silent) log container.
    expect(log?.querySelector('[data-testid="virtuoso"]')).not.toBeNull();
    r.unmount();
  });

  it("exposes a separate visually-hidden polite announcer outside the virtualized list", () => {
    const r = renderViewer(
      <div data-testid="log-viewer-root">
        <LogViewer jobId={1} initial={initial} active={false} />
      </div>,
    );
    const scope = viewer(r);
    const log = scope.querySelector('[role="log"]');
    const announcer = scope.querySelector('[role="status"]');
    expect(announcer).not.toBeNull();
    expect(announcer?.className).toContain("sr-only");
    expect(announcer?.getAttribute("aria-live")).toBe("polite");
    expect(announcer?.getAttribute("aria-atomic")).toBe("true");
    // Decoupled: the announcer is NOT part of the virtualized subtree.
    expect(log?.contains(announcer as Node)).toBe(false);
    r.unmount();
  });

  it("does not announce replayed history — a completed job starts silent", () => {
    const r = renderViewer(
      <div data-testid="log-viewer-root">
        <LogViewer jobId={1} initial={initial} active={false} />
      </div>,
    );
    // Rendering (and scrolling) a finished log must not enqueue announcements.
    expect(viewer(r).querySelector('[role="status"]')?.textContent).toBe("");
    r.unmount();
  });

  it("collapses a burst of live chunk events into a single throttled digest", () => {
    vi.useFakeTimers();
    const r = renderViewer(
      <div data-testid="log-viewer-root">
        <LogViewer jobId={7} initial={[]} active={true} />
      </div>,
    );
    const es = openedEventSource();

    // Three assistant messages stream in within one throttle window.
    act(() => {
      es.emit("assistant", { chunks: [{ kind: "text", text: "a" }] }, 101);
      es.emit("assistant", { chunks: [{ kind: "text", text: "b" }] }, 102);
      es.emit("assistant", { chunks: [{ kind: "text", text: "c" }] }, 103);
    });

    const announcer = () => viewer(r).querySelector('[role="status"]');
    // Nothing announced yet — the summary is throttled, not per-chunk.
    expect(announcer()?.textContent).toBe("");

    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_INTERVAL_MS);
    });
    // One human-scale digest for the whole burst, not three announcements.
    expect(announcer()?.textContent).toBe("3 new log events");
    r.unmount();
  });

  it("announces a status transition instead of a chunk digest", () => {
    vi.useFakeTimers();
    const r = renderViewer(
      <div data-testid="log-viewer-root">
        <LogViewer jobId={8} initial={[]} active={true} />
      </div>,
    );
    const es = openedEventSource();
    act(() => {
      es.emit("status", { from: "queued", to: "working" }, 201);
    });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_INTERVAL_MS);
    });
    expect(viewer(r).querySelector('[role="status"]')?.textContent).toBe("Status: working.");
    r.unmount();
  });
});
