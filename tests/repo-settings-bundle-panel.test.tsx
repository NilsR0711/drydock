// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import type { Repo } from "@/lib/db/schema";
import { fire, type Rendered, render } from "./fixtures/react";

const actions = vi.hoisted(() => ({
  exportRepoSettingsAction: vi.fn(),
  previewImportAction: vi.fn(),
  importRepoSettingsAction: vi.fn(),
}));
vi.mock("@/lib/repos/settings-bundle-actions", () => actions);

import { RepoSettingsBundlePanel } from "@/components/repo-settings-bundle-panel";

/** Set a controlled textarea's value via the native setter and fire `input`. */
function setTextareaValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, value);
  fire(el, new Event("input", { bubbles: true }));
}

function clickButton(container: HTMLElement, label: RegExp): void {
  const btn = Array.from(container.querySelectorAll("button")).find((b) =>
    label.test(b.textContent ?? ""),
  );
  if (!btn) throw new Error(`button matching ${label} not found`);
  fire(btn, new MouseEvent("click", { bubbles: true }));
}

async function flush(): Promise<void> {
  await act(async () => {});
}

const repo = { id: 1, name: "acme" } as Repo;

let mounted: Rendered | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function mount() {
  return render(
    <ToastProvider>
      <RepoSettingsBundlePanel repo={repo} />
    </ToastProvider>,
  );
}

describe("RepoSettingsBundlePanel", () => {
  it("renders export controls and the safety note", () => {
    mounted = mount();
    const text = mounted.container.textContent ?? "";
    expect(text).toMatch(/Export file/i);
    expect(text).toMatch(/Copy/i);
    expect(text).toMatch(/never exported and never overwritten/i);
  });

  it("previews changes from the pasted bundle", async () => {
    actions.previewImportAction.mockResolvedValue({
      repoChanges: [{ field: "planFirst", from: false, to: true }],
      templateChanges: [{ name: "default", action: "update" }],
      warnings: ['Ignored identity/secret field "apiToken" (never imported)'],
    });
    mounted = mount();
    const textarea = mounted.container.querySelector("textarea") as HTMLTextAreaElement;
    setTextareaValue(textarea, '{"drydockSettingsVersion":1,"repo":{"planFirst":true}}');
    clickButton(mounted.container, /Preview changes/i);
    await flush();

    expect(actions.previewImportAction).toHaveBeenCalledWith(
      1,
      '{"drydockSettingsVersion":1,"repo":{"planFirst":true}}',
    );
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("planFirst");
    expect(text).toMatch(/apiToken/);
  });

  it("applies the bundle after previewing", async () => {
    actions.previewImportAction.mockResolvedValue({
      repoChanges: [{ field: "planFirst", from: false, to: true }],
      templateChanges: [],
      warnings: [],
    });
    actions.importRepoSettingsAction.mockResolvedValue({
      repo,
      appliedRepoFields: ["planFirst"],
      appliedTemplates: [],
      warnings: [],
    });
    mounted = mount();
    const textarea = mounted.container.querySelector("textarea") as HTMLTextAreaElement;
    setTextareaValue(textarea, '{"drydockSettingsVersion":1,"repo":{"planFirst":true}}');
    clickButton(mounted.container, /Preview changes/i);
    await flush();
    clickButton(mounted.container, /Apply import/i);
    await flush();

    expect(actions.importRepoSettingsAction).toHaveBeenCalledWith(
      1,
      '{"drydockSettingsVersion":1,"repo":{"planFirst":true}}',
    );
  });

  it("copies the exported bundle to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    actions.exportRepoSettingsAction.mockResolvedValue({
      drydockSettingsVersion: 1,
      repo: { planFirst: true },
      promptTemplates: {},
    });
    mounted = mount();
    clickButton(mounted.container, /Copy/i);
    await flush();

    expect(actions.exportRepoSettingsAction).toHaveBeenCalledWith(1);
    expect(writeText).toHaveBeenCalledOnce();
    expect(String(writeText.mock.calls[0]?.[0])).toContain("planFirst");
  });
});
