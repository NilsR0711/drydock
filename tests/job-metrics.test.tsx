// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobMetrics } from "@/components/job-metrics";
import { type Rendered, render } from "./fixtures/react";

/**
 * Minimal EventSource stand-in — jsdom ships none. Tracks live instances so a
 * test can push named events into whatever listeners the component registered.
 */
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
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-18T12:00:00Z"));
  MockEventSource.instances = [];
  (globalThis as { EventSource: unknown }).EventSource = MockEventSource;
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
  (globalThis as { EventSource: unknown }).EventSource = originalEventSource;
  document.body.innerHTML = "";
});

function text(): string {
  return mounted?.container.textContent ?? "";
}

const baseProps = {
  jobId: 5,
  issueNumber: 12,
  model: "claude-opus-4-8",
  initialCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  attempts: 1,
};

describe("JobMetrics duration ticker (issue #242)", () => {
  it("advances the Duration card once per second while the job is active", () => {
    const now = Math.floor(Date.now() / 1000);
    mounted = render(
      <JobMetrics {...baseProps} active startedAt={now - 40} finishedAt={null} nowSec={now} />,
    );
    expect(text()).toContain("40s");

    act(() => vi.advanceTimersByTime(3000));
    expect(text()).toContain("43s");
  });

  it("keeps the Duration frozen for a finished job and opens no stream", () => {
    const now = Math.floor(Date.now() / 1000);
    mounted = render(
      <JobMetrics
        {...baseProps}
        active={false}
        startedAt={now - 120}
        finishedAt={now - 80}
        nowSec={now}
      />,
    );
    // 120s − 80s = 40s, pinned to the persisted end time.
    expect(text()).toContain("40s");

    act(() => vi.advanceTimersByTime(5000));
    expect(text()).toContain("40s");
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("does not tick a still-active job that already finished (finishedAt set)", () => {
    const now = Math.floor(Date.now() / 1000);
    mounted = render(
      <JobMetrics
        {...baseProps}
        active
        startedAt={now - 200}
        finishedAt={now - 100}
        nowSec={now}
      />,
    );
    expect(text()).toContain("1m 40s");
    act(() => vi.advanceTimersByTime(5000));
    expect(text()).toContain("1m 40s");
  });

  it("shows an em dash when the job never started", () => {
    const now = Math.floor(Date.now() / 1000);
    mounted = render(
      <JobMetrics {...baseProps} active startedAt={null} finishedAt={null} nowSec={now} />,
    );
    expect(text()).toContain("—");
  });
});

describe("JobMetrics duration freeze on terminal status (issue #337)", () => {
  it("freezes the Duration at the finish time when a terminal status arrives", () => {
    const now = Math.floor(Date.now() / 1000);
    mounted = render(
      <JobMetrics {...baseProps} active startedAt={now - 100} finishedAt={null} nowSec={now} />,
    );
    expect(text()).toContain("1m 40s");
    const es = MockEventSource.instances.at(-1);

    // The job merges live; the timer must stop at the transition time rather
    // than run away until a reload (the bug in #337).
    es?.emit("status", { from: "ci_running", to: "merged" }, 5);
    act(() => vi.advanceTimersByTime(5000));
    expect(text()).toContain("1m 40s");
    // The stream is closed once the job is terminal — no further metrics arrive.
    expect(es?.closed).toBe(true);
  });

  it("keeps ticking through a non-terminal transition (working → ci_running)", () => {
    const now = Math.floor(Date.now() / 1000);
    mounted = render(
      <JobMetrics {...baseProps} active startedAt={now - 30} finishedAt={null} nowSec={now} />,
    );
    const es = MockEventSource.instances.at(-1);
    es?.emit("status", { from: "working", to: "ci_running" }, 1);
    act(() => vi.advanceTimersByTime(4000));
    // CI is still running; the duration keeps advancing.
    expect(text()).toContain("34s");
  });

  it("does not freeze on the agent result event (CI may still be running)", () => {
    const now = Math.floor(Date.now() / 1000);
    mounted = render(
      <JobMetrics {...baseProps} active startedAt={now - 50} finishedAt={null} nowSec={now} />,
    );
    const es = MockEventSource.instances.at(-1);
    // The agent finishing (`result`) precedes ci_running → merged for issue
    // jobs; the duration must keep running until the job itself is terminal.
    es?.emit("result", { chunks: [], costUsd: 1, durationSec: 50 }, 1);
    act(() => vi.advanceTimersByTime(3000));
    expect(text()).toContain("53s");
  });

  it("freezes on a parked terminal status (needs_human)", () => {
    const now = Math.floor(Date.now() / 1000);
    mounted = render(
      <JobMetrics {...baseProps} active startedAt={now - 200} finishedAt={null} nowSec={now} />,
    );
    const es = MockEventSource.instances.at(-1);
    es?.emit("status", { from: "working", to: "needs_human" }, 1);
    act(() => vi.advanceTimersByTime(5000));
    expect(text()).toContain("3m 20s");
    expect(es?.closed).toBe(true);
  });
});

describe("JobMetrics live cost and token totals (issue #242)", () => {
  it("refreshes cost and token totals from streamed assistant events", () => {
    const now = Math.floor(Date.now() / 1000);
    mounted = render(
      <JobMetrics {...baseProps} active startedAt={now} finishedAt={null} nowSec={now} />,
    );
    const es = MockEventSource.instances.at(-1);
    expect(es).toBeDefined();

    es?.emit(
      "assistant",
      { chunks: [], costUsd: 1.5, inputTokens: 120_000, outputTokens: 3_400 },
      1,
    );

    expect(text()).toContain("$1.50");
    expect(text()).toContain("120k in");
    expect(text()).toContain("3.4k out");
  });

  it("also updates from the terminal result event", () => {
    const now = Math.floor(Date.now() / 1000);
    mounted = render(
      <JobMetrics
        {...baseProps}
        active
        initialCostUsd={2}
        startedAt={now}
        finishedAt={null}
        nowSec={now}
      />,
    );
    const es = MockEventSource.instances.at(-1);
    es?.emit("result", { chunks: [], costUsd: 4.82, inputTokens: 200_000, outputTokens: 9_100 }, 2);

    expect(text()).toContain("$4.82");
    expect(text()).toContain("200k in");
    expect(text()).toContain("9.1k out");
  });

  it("ignores malformed payloads without crashing", () => {
    const now = Math.floor(Date.now() / 1000);
    mounted = render(
      <JobMetrics
        {...baseProps}
        active
        initialCostUsd={3.21}
        startedAt={now}
        finishedAt={null}
        nowSec={now}
      />,
    );
    const es = MockEventSource.instances.at(-1);
    // emit() JSON-stringifies its argument; a raw string round-trips to a value
    // that lacks the expected numeric fields, so the card keeps its prior cost.
    es?.emit("assistant", "not a metrics object", 1);
    expect(text()).toContain("$3.21");
  });
});
