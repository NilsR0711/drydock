// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrackedPr } from "@/lib/db/schema";
import { fire, type Rendered, render, setInputValue } from "./fixtures/react";

const actions = vi.hoisted(() => ({
  addTrackedPrAction: vi.fn(),
  untrackPrAction: vi.fn(),
}));
vi.mock("@/lib/tracked-prs/actions", () => actions);

import { TrackedPrsPanel } from "@/components/tracked-prs-panel";

function tp(over: Partial<TrackedPr> = {}): TrackedPr {
  return {
    id: 1,
    repoId: 1,
    prNumber: 42,
    url: "https://github.com/acme/r/pull/42",
    platform: "github",
    branch: "drydock/x",
    headSlug: "acme/r",
    baseSlug: "acme/r",
    isFork: false,
    owned: true,
    autoMerge: false,
    status: "tracking",
    title: "External PR",
    author: "dev",
    headSha: "abc",
    ciRetryCount: 0,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

async function flush(): Promise<void> {
  await act(async () => {});
}

let mounted: Rendered | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.clearAllMocks();
});

describe("TrackedPrsPanel", () => {
  it("shows an empty state when nothing is tracked", () => {
    mounted = render(<TrackedPrsPanel repoId={1} initialPrs={[]} />);
    expect(mounted.container.textContent).toMatch(/No tracked PRs/i);
  });

  it("renders tracked PRs with their status and fork/auto-merge badges", () => {
    mounted = render(
      <TrackedPrsPanel
        repoId={1}
        initialPrs={[tp({ status: "needs_human", isFork: true, autoMerge: true })]}
      />,
    );
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("#42");
    expect(text).toMatch(/needs human/i);
    expect(text).toMatch(/fork/i);
    expect(text).toMatch(/auto-merge/i);
  });

  it("tracks a PR via the action and prepends it to the list", async () => {
    actions.addTrackedPrAction.mockResolvedValue(tp({ id: 7, prNumber: 99, title: "New one" }));
    mounted = render(<TrackedPrsPanel repoId={1} initialPrs={[]} />);
    const input = mounted.container.querySelector("#track-pr-url") as HTMLInputElement;
    setInputValue(input, "https://github.com/acme/r/pull/99");
    const form = mounted.container.querySelector("form") as HTMLFormElement;
    fire(form, new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(actions.addTrackedPrAction).toHaveBeenCalledWith(
      1,
      "https://github.com/acme/r/pull/99",
      false,
    );
    expect(mounted.container.textContent).toContain("#99");
  });

  it("surfaces an action error without crashing", async () => {
    actions.addTrackedPrAction.mockRejectedValue(new Error("PR belongs to other/repo"));
    mounted = render(<TrackedPrsPanel repoId={1} initialPrs={[]} />);
    const input = mounted.container.querySelector("#track-pr-url") as HTMLInputElement;
    setInputValue(input, "https://github.com/acme/r/pull/1");
    const form = mounted.container.querySelector("form") as HTMLFormElement;
    fire(form, new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(mounted.container.textContent).toMatch(/belongs to other\/repo/);
  });
});
