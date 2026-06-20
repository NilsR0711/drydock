// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fire, type Rendered, render } from "./fixtures/react";

const actions = vi.hoisted(() => ({
  runOnboardingDiagnosticsAction: vi.fn(),
  completeOnboardingAction: vi.fn(),
}));
vi.mock("@/lib/onboarding/actions", () => actions);

import { OnboardingProvider } from "@/components/onboarding/onboarding-provider";
import { ToastProvider } from "@/components/ui/toast";

function report(overrides: Record<string, unknown> = {}) {
  return {
    checkedAt: 1,
    complete: false,
    items: [
      {
        id: "agent:claude",
        category: "agent",
        name: "Claude Code",
        blurb: "Drydock's default agent.",
        status: "missing",
        optional: false,
        action: { label: "Install", url: "https://docs.anthropic.com/claude-code/setup" },
        facets: [
          { label: "Installed", status: "missing", detail: "CLI not found." },
          { label: "Signed in", status: "unknown", detail: "Install first." },
        ],
      },
      {
        id: "forge:github",
        category: "forge",
        name: "GitHub",
        blurb: "Reads issues and opens PRs.",
        status: "ready",
        optional: false,
        facets: [
          { label: "Installed", status: "ready" },
          { label: "Authenticated", status: "ready" },
        ],
      },
      {
        id: "env:git",
        category: "environment",
        name: "Git",
        blurb: "Required for worktrees.",
        status: "ready",
        optional: false,
        facets: [{ label: "Installed", status: "ready" }],
      },
    ],
    ...overrides,
  };
}

function tree() {
  return (
    <ToastProvider>
      <OnboardingProvider autoOpen>
        <div>app</div>
      </OnboardingProvider>
    </ToastProvider>
  );
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`no button matching "${text}"`);
  return btn as HTMLButtonElement;
}

const click = (el: Element) => fire(el, new MouseEvent("click", { bubbles: true }));
const flush = () => act(async () => {});

describe("OnboardingModal", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    actions.runOnboardingDiagnosticsAction.mockResolvedValue(report());
    actions.completeOnboardingAction.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("probes on open and renders a grouped checklist with status and links", async () => {
    mounted = render(tree());
    await flush();
    const text = mounted.container.textContent ?? "";
    expect(actions.runOnboardingDiagnosticsAction).toHaveBeenCalledTimes(1);
    expect(text).toContain("Welcome to Drydock");
    expect(text).toContain("Claude Code");
    expect(text).toContain("GitHub");
    expect(text).toContain("Git");
    // The missing item exposes a working external install link in a new tab.
    const link = mounted.container.querySelector<HTMLAnchorElement>(
      'a[href="https://docs.anthropic.com/claude-code/setup"]',
    );
    expect(link).not.toBeNull();
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toContain("noopener");
    // Progress summary reflects the two ready checks of three.
    expect(text).toContain("2/3 ready");
  });

  it("re-runs the probes when Re-check is clicked", async () => {
    mounted = render(tree());
    await flush();
    click(button(mounted.container, "Re-check"));
    await flush();
    expect(actions.runOnboardingDiagnosticsAction).toHaveBeenCalledTimes(2);
  });

  it("persists completion when dismissed", async () => {
    mounted = render(tree());
    await flush();
    click(button(mounted.container, "Skip for now"));
    await flush();
    expect(actions.completeOnboardingAction).toHaveBeenCalledTimes(1);
  });

  it("labels the primary action 'Get started' once everything is ready", async () => {
    actions.runOnboardingDiagnosticsAction.mockResolvedValue(
      report({
        complete: true,
        items: [
          {
            id: "env:git",
            category: "environment",
            name: "Git",
            blurb: "Required for worktrees.",
            status: "ready",
            optional: false,
            facets: [{ label: "Installed", status: "ready" }],
          },
        ],
      }),
    );
    mounted = render(tree());
    await flush();
    expect(mounted.container.textContent).toContain("Get started");
    expect(mounted.container.textContent).toContain("You're all set");
  });
});
