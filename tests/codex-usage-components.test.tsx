// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { CodexUsageCard, CodexUsagePill } from "@/components/codex-usage";
import { buildCodexUsageView } from "@/lib/agents/codex-usage";
import { type Rendered, render } from "./fixtures/react";

let mounted: Rendered | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

const now = () => Math.floor(Date.now() / 1000);
const HOUR = 3600;

describe("CodexUsagePill (issue #189)", () => {
  it("names Codex even with no reading yet", () => {
    mounted = render(<CodexUsagePill view={buildCodexUsageView({ now: now() })} />);
    expect(mounted.container.textContent ?? "").toContain("Codex");
  });

  it("shows the headline percent once a reading exists", () => {
    const view = buildCodexUsageView({
      snapshot: { capturedAt: now(), primary: { usedPercent: 42, resetsAt: now() + HOUR } },
      now: now(),
    });
    mounted = render(<CodexUsagePill view={view} />);
    expect(mounted.container.textContent ?? "").toContain("42%");
  });

  it("shows the limited state when a latch is active", () => {
    const view = buildCodexUsageView({ latchedUntil: now() + 1800, now: now() });
    mounted = render(<CodexUsagePill view={view} />);
    expect(mounted.container.textContent ?? "").toMatch(/limited/i);
  });
});

describe("CodexUsageCard (issue #189)", () => {
  it("degrades gracefully to 'usage unknown' when nothing is recorded", () => {
    mounted = render(<CodexUsageCard view={buildCodexUsageView({ now: now() })} />);
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Codex usage");
    expect(text).toContain("Usage unknown");
    expect(text).toMatch(/no quota reading/i);
  });

  it("renders per-window percentages and the high-usage tier", () => {
    const view = buildCodexUsageView({
      snapshot: {
        capturedAt: now(),
        primary: { usedPercent: 80, resetsAt: now() + 2 * HOUR, windowMinutes: 300 },
        secondary: { usedPercent: 12, resetsAt: now() + 5 * 24 * HOUR, windowMinutes: 10080 },
      },
      now: now(),
    });
    mounted = render(<CodexUsageCard view={view} />);
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("High usage");
    expect(text).toContain("80%");
    expect(text).toContain("12%");
    expect(text).toContain("weekly window");
  });

  it("surfaces the parked state when Codex is limit-blocked", () => {
    const view = buildCodexUsageView({ latchedUntil: now() + 1800, now: now() });
    mounted = render(<CodexUsageCard view={view} />);
    const text = mounted.container.textContent ?? "";
    expect(text).toMatch(/limit reached/i);
    expect(text).toMatch(/parked/i);
  });
});
