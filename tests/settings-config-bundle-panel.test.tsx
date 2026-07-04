// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import { fire, type Rendered, render } from "./fixtures/react";

const actions = vi.hoisted(() => ({
  exportConfigAction: vi.fn(),
  previewConfigImportAction: vi.fn(),
  importConfigAction: vi.fn(),
}));
vi.mock("@/lib/settings/config-bundle-actions", () => actions);

import { SettingsConfigBundlePanel } from "@/components/settings-config-bundle-panel";

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
      <SettingsConfigBundlePanel />
    </ToastProvider>,
  );
}

describe("SettingsConfigBundlePanel", () => {
  it("renders export controls and the safety note", () => {
    mounted = mount();
    const text = mounted.container.textContent ?? "";
    expect(text).toMatch(/Export file/i);
    expect(text).toMatch(/Copy/i);
    expect(text).toMatch(/secrets are never/i);
  });

  it("previews global-settings and per-repo changes from the pasted bundle", async () => {
    actions.previewConfigImportAction.mockResolvedValue({
      settingsChanges: [{ field: "maxParallelJobs", from: 3, to: 8 }],
      repos: [
        {
          name: "owner/a",
          matched: true,
          repoChanges: [{ field: "planFirst", from: false, to: true }],
          templateChanges: [{ name: "default", action: "update" }],
        },
        { name: "owner/missing", matched: false, repoChanges: [], templateChanges: [] },
      ],
      warnings: ['Ignored credential setting "smtpPass" (secrets are never imported)'],
    });
    mounted = mount();
    const textarea = mounted.container.querySelector("textarea") as HTMLTextAreaElement;
    setTextareaValue(textarea, '{"drydockConfigVersion":1,"settings":{"maxParallelJobs":8}}');
    clickButton(mounted.container, /Preview changes/i);
    await flush();

    expect(actions.previewConfigImportAction).toHaveBeenCalledWith(
      '{"drydockConfigVersion":1,"settings":{"maxParallelJobs":8}}',
    );
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("maxParallelJobs");
    expect(text).toContain("planFirst");
    expect(text).toContain("owner/a");
    expect(text).toContain("owner/missing");
    expect(text).toMatch(/smtpPass/);
  });

  it("applies the bundle after previewing", async () => {
    actions.previewConfigImportAction.mockResolvedValue({
      settingsChanges: [{ field: "maxParallelJobs", from: 3, to: 8 }],
      repos: [],
      warnings: [],
    });
    actions.importConfigAction.mockResolvedValue({
      appliedSettings: ["maxParallelJobs"],
      appliedRepos: [],
      skippedRepos: [],
      warnings: [],
    });
    mounted = mount();
    const textarea = mounted.container.querySelector("textarea") as HTMLTextAreaElement;
    setTextareaValue(textarea, '{"drydockConfigVersion":1,"settings":{"maxParallelJobs":8}}');
    clickButton(mounted.container, /Preview changes/i);
    await flush();
    clickButton(mounted.container, /Apply import/i);
    await flush();

    expect(actions.importConfigAction).toHaveBeenCalledWith(
      '{"drydockConfigVersion":1,"settings":{"maxParallelJobs":8}}',
    );
  });

  it("copies the exported bundle to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    actions.exportConfigAction.mockResolvedValue({
      drydockConfigVersion: 1,
      settings: { maxParallelJobs: 3 },
      repos: [],
    });
    mounted = mount();
    clickButton(mounted.container, /Copy/i);
    await flush();

    expect(actions.exportConfigAction).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledOnce();
    expect(String(writeText.mock.calls[0]?.[0])).toContain("maxParallelJobs");
  });
});
