// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fire, type Rendered, render } from "./fixtures/react";

const actions = vi.hoisted(() => ({ startReleaseAction: vi.fn() }));
vi.mock("@/lib/release/actions", () => actions);

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => toast }));

import { ReleaseButton } from "@/components/release-button";

async function flush(): Promise<void> {
  await act(async () => {});
}

function click(el: Element | null): void {
  if (!el) throw new Error("element not found");
  fire(el, new MouseEvent("click", { bubbles: true }));
}

/** Find a clickable element whose text matches. */
function byText(container: HTMLElement, re: RegExp): HTMLElement | null {
  return (
    [...container.querySelectorAll("button")].find((b) => re.test(b.textContent ?? "")) ?? null
  );
}

let mounted: Rendered | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.clearAllMocks();
});

describe("ReleaseButton (issue #352)", () => {
  it("renders a prominent Create release control", () => {
    mounted = render(<ReleaseButton repoId={7} />);
    expect(byText(mounted.container, /create release/i)).not.toBeNull();
  });

  it("requires confirmation before starting — no immediate action call", () => {
    mounted = render(<ReleaseButton repoId={7} />);
    click(byText(mounted.container, /create release/i));
    expect(actions.startReleaseAction).not.toHaveBeenCalled();
    // The confirm dialog is now open.
    expect(document.body.textContent).toMatch(/Create a release\?/i);
  });

  it("starts the release on confirm and navigates to the job log", async () => {
    actions.startReleaseAction.mockResolvedValue({ jobId: 42, runs: [] });
    mounted = render(<ReleaseButton repoId={7} />);
    click(byText(mounted.container, /create release/i));
    // Confirm button inside the dialog (its label is "Create release" too — pick the
    // one rendered in the dialog footer, which is the last matching button).
    const confirms = [...document.querySelectorAll("button")].filter((b) =>
      /create release/i.test(b.textContent ?? ""),
    );
    click(confirms.at(-1) ?? null);
    await flush();

    expect(actions.startReleaseAction).toHaveBeenCalledWith(7);
    expect(router.push).toHaveBeenCalledWith("/jobs/42");
  });

  it("surfaces a start failure via a toast and does not navigate", async () => {
    actions.startReleaseAction.mockRejectedValue(new Error("release already in progress"));
    mounted = render(<ReleaseButton repoId={7} />);
    click(byText(mounted.container, /create release/i));
    const confirms = [...document.querySelectorAll("button")].filter((b) =>
      /create release/i.test(b.textContent ?? ""),
    );
    click(confirms.at(-1) ?? null);
    await flush();

    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/release/i),
      "release already in progress",
    );
    expect(router.push).not.toHaveBeenCalled();
  });
});
