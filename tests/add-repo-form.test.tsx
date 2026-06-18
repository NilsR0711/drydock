// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fire, type Rendered, render, setInputValue } from "./fixtures/react";

const actions = vi.hoisted(() => ({
  addRepoAction: vi.fn(),
  detectDefaultBranchAction: vi.fn(),
}));
vi.mock("@/lib/repos/actions", () => actions);

import { AddRepoForm } from "@/components/add-repo-form";

async function flush(): Promise<void> {
  await act(async () => {});
}

function input(c: HTMLElement, id: string): HTMLInputElement {
  const el = c.querySelector<HTMLInputElement>(`#${id}`);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

describe("AddRepoForm default branch (issue #210)", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    actions.detectDefaultBranchAction.mockResolvedValue("master");
    actions.addRepoAction.mockResolvedValue({});
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("pre-fills the default branch field from detection when a path is entered", async () => {
    mounted = render(<AddRepoForm onDone={() => {}} />);
    const path = input(mounted.container, "repo-path");
    setInputValue(path, "/repos/orgl-app");
    fire(path, new Event("focusout", { bubbles: true }));
    await flush();
    expect(actions.detectDefaultBranchAction).toHaveBeenCalledWith("/repos/orgl-app");
    expect(input(mounted.container, "repo-default-branch").value).toBe("master");
  });

  it("does not overwrite a branch the user has edited", async () => {
    mounted = render(<AddRepoForm onDone={() => {}} />);
    const branch = input(mounted.container, "repo-default-branch");
    setInputValue(branch, "trunk");
    const path = input(mounted.container, "repo-path");
    setInputValue(path, "/repos/orgl-app");
    fire(path, new Event("focusout", { bubbles: true }));
    await flush();
    expect(branch.value).toBe("trunk");
  });

  it("does not clobber a branch the user edits while detection is in flight", async () => {
    // Detection that resolves only when we say so, simulating a slow git call.
    let resolveDetect: (v: string) => void = () => {};
    actions.detectDefaultBranchAction.mockImplementation(
      () =>
        new Promise<string>((r) => {
          resolveDetect = r;
        }),
    );
    mounted = render(<AddRepoForm onDone={() => {}} />);
    const path = input(mounted.container, "repo-path");
    setInputValue(path, "/repos/orgl-app");
    fire(path, new Event("focusout", { bubbles: true }));
    await flush();
    // User picks a branch by hand before detection comes back.
    const branch = input(mounted.container, "repo-default-branch");
    setInputValue(branch, "trunk");
    // Now the in-flight detection resolves — it must not overwrite the edit.
    resolveDetect("master");
    await flush();
    expect(branch.value).toBe("trunk");
  });

  it("uses the result of the latest detection when paths change quickly", async () => {
    const resolvers: Array<(v: string) => void> = [];
    actions.detectDefaultBranchAction.mockImplementation(
      () =>
        new Promise<string>((r) => {
          resolvers.push(r);
        }),
    );
    mounted = render(<AddRepoForm onDone={() => {}} />);
    const path = input(mounted.container, "repo-path");
    setInputValue(path, "/repos/first");
    fire(path, new Event("focusout", { bubbles: true }));
    await flush();
    setInputValue(path, "/repos/second");
    fire(path, new Event("focusout", { bubbles: true }));
    await flush();
    // Resolve out of order: the latest request wins regardless.
    resolvers[1]?.("second-branch");
    resolvers[0]?.("first-branch");
    await flush();
    expect(input(mounted.container, "repo-default-branch").value).toBe("second-branch");
  });

  it("does not detect for an empty path", async () => {
    mounted = render(<AddRepoForm onDone={() => {}} />);
    const path = input(mounted.container, "repo-path");
    fire(path, new Event("focusout", { bubbles: true }));
    await flush();
    expect(actions.detectDefaultBranchAction).not.toHaveBeenCalled();
  });
});
