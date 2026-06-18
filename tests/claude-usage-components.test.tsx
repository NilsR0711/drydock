// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeUsageCard, ClaudeUsagePill } from "@/components/claude-usage";
import { deriveClaudeUsageView } from "@/lib/agents/claude-usage";
import { type Rendered, render } from "./fixtures/react";

let mounted: Rendered | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

const now = () => Math.floor(Date.now() / 1000);

describe("ClaudeUsagePill (issue #188)", () => {
  it("renders an unknown state when no reading exists", () => {
    mounted = render(<ClaudeUsagePill view={deriveClaudeUsageView({ now: now() })} />);
    expect(mounted.container.textContent ?? "").toContain("Claude");
  });

  it("shows the limited state when a latch is active", () => {
    const view = deriveClaudeUsageView({ latchedUntil: now() + 7200, now: now() });
    mounted = render(<ClaudeUsagePill view={view} />);
    expect(mounted.container.textContent ?? "").toMatch(/limited/i);
  });
});

describe("ClaudeUsageCard (issue #188)", () => {
  it("degrades gracefully to 'no recent reading' when usage is unknown", () => {
    mounted = render(<ClaudeUsageCard view={deriveClaudeUsageView({ now: now() })} />);
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Claude usage");
    expect(text).toContain("Usage unknown");
    expect(text).toMatch(/no recent reading/i);
  });

  it("renders the window label and limit-near state for a warning reading", () => {
    const view = deriveClaudeUsageView({
      reading: {
        status: "warning",
        windowType: "five_hour",
        resetsAt: now() + 3600,
        capturedAt: now(),
      },
      now: now(),
    });
    mounted = render(<ClaudeUsageCard view={view} />);
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Limit near");
    expect(text).toContain("5h window");
  });
});
