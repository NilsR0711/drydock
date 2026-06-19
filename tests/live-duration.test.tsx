// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveDuration } from "@/components/live-duration";
import { type Rendered, render } from "./fixtures/react";

let mounted: Rendered | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-18T12:00:00Z"));
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const text = () => mounted?.container.textContent ?? "";

describe("LiveDuration (issue #282)", () => {
  it("ticks once per second while the job is active and unfinished", () => {
    const now = Math.floor(Date.now() / 1000);
    mounted = render(<LiveDuration startedAt={now - 40} finishedAt={null} active nowSec={now} />);
    expect(text()).toContain("40s");

    act(() => vi.advanceTimersByTime(3000));
    expect(text()).toContain("43s");
  });

  it("seeds from the server nowSec so the first render matches SSR", () => {
    const now = Math.floor(Date.now() / 1000);
    mounted = render(<LiveDuration startedAt={now - 90} finishedAt={null} active nowSec={now} />);
    // 90s elapsed → "1m 30s", computed from nowSec, not a fresh Date.now().
    expect(text()).toContain("1m 30s");
  });

  it("keeps a finished job's duration frozen and opens no interval", () => {
    const now = Math.floor(Date.now() / 1000);
    mounted = render(
      <LiveDuration startedAt={now - 120} finishedAt={now - 80} active={false} nowSec={now} />,
    );
    expect(text()).toContain("40s");

    act(() => vi.advanceTimersByTime(5000));
    expect(text()).toContain("40s");
  });

  it("does not tick a job that already finished even if still flagged active", () => {
    const now = Math.floor(Date.now() / 1000);
    mounted = render(
      <LiveDuration startedAt={now - 200} finishedAt={now - 100} active nowSec={now} />,
    );
    expect(text()).toContain("1m 40s");

    act(() => vi.advanceTimersByTime(5000));
    expect(text()).toContain("1m 40s");
  });

  it("renders an em dash when the job never started", () => {
    const now = Math.floor(Date.now() / 1000);
    mounted = render(<LiveDuration startedAt={null} finishedAt={null} active nowSec={now} />);
    expect(text()).toContain("—");
  });

  it("renders an em dash for an inactive job that never started", () => {
    const now = Math.floor(Date.now() / 1000);
    mounted = render(
      <LiveDuration startedAt={null} finishedAt={null} active={false} nowSec={now} />,
    );
    expect(text()).toContain("—");
  });

  it("applies the passed className to the rendered span", () => {
    const now = Math.floor(Date.now() / 1000);
    mounted = render(
      <LiveDuration startedAt={now - 5} finishedAt={null} active nowSec={now} className="tnum" />,
    );
    expect(mounted.container.querySelector("span.tnum")).not.toBeNull();
  });
});
