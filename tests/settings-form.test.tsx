// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsSchema } from "@/lib/settings/service";
import { fire, type Rendered, render, setInputValue } from "./fixtures/react";

const actions = vi.hoisted(() => ({
  saveSettingsAction: vi.fn(),
  sendTestNotificationAction: vi.fn(),
  togglePauseAction: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("@/lib/settings/actions", () => actions);
vi.mock("@/components/ui/toast", () => ({ useToast: () => toast }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { SettingsForm } from "@/components/settings-form";
import type { Settings } from "@/lib/settings/service";

async function flush(): Promise<void> {
  await act(async () => {});
}

function click(el: Element): void {
  fire(el, new MouseEvent("click", { bubbles: true }));
}

function buttonByText(c: HTMLElement, text: string): HTMLButtonElement {
  const el = [...c.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!el) throw new Error(`button "${text}" not found`);
  return el as HTMLButtonElement;
}

/** A full, valid Settings value straight from the schema defaults. */
const baseSettings = (): Settings => settingsSchema.parse({});

describe("SettingsForm (issue #388)", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    actions.saveSettingsAction.mockResolvedValue(undefined);
    actions.togglePauseAction.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("renders the settings surface with its main sections", () => {
    mounted = render(<SettingsForm initial={baseSettings()} />);
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Automation");
    expect(text).toContain("Notification channels");
    expect(
      mounted.container.querySelector('button[aria-label="Global kill-switch"]'),
    ).not.toBeNull();
  });

  it("persists the on-screen settings when Save changes is clicked", async () => {
    const initial = baseSettings();
    mounted = render(<SettingsForm initial={initial} />);

    click(buttonByText(mounted.container, "Save changes"));
    await flush();

    expect(actions.saveSettingsAction).toHaveBeenCalledWith(initial);
    expect(toast.success).toHaveBeenCalledWith("Settings saved");
  });

  it("edits and persists the generic webhook URL and secret (issue #414)", async () => {
    mounted = render(<SettingsForm initial={baseSettings()} />);

    const url = mounted.container.querySelector<HTMLInputElement>(
      'input[placeholder="https://ntfy.example.com/drydock"]',
    );
    const secret = mounted.container.querySelector<HTMLInputElement>(
      'input[placeholder="X-Drydock-Secret header (optional)"]',
    );
    if (!url || !secret) throw new Error("webhook fields not found");

    setInputValue(url, "https://relay.example.com/hook");
    setInputValue(secret, "shared-secret");
    click(buttonByText(mounted.container, "Save changes"));
    await flush();

    expect(actions.saveSettingsAction).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookUrl: "https://relay.example.com/hook",
        webhookSecret: "shared-secret",
      }),
    );
  });

  it("flips the kill-switch immediately through the dedicated action", async () => {
    mounted = render(<SettingsForm initial={baseSettings()} />);
    const killSwitch = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Global kill-switch"]',
    );
    if (!killSwitch) throw new Error("kill-switch not found");
    expect(killSwitch.getAttribute("aria-checked")).toBe("false");

    click(killSwitch);
    await flush();

    expect(actions.togglePauseAction).toHaveBeenCalledWith(true);
    expect(toast.info).toHaveBeenCalledWith("Automation suspended");
    expect(actions.saveSettingsAction).not.toHaveBeenCalled();
  });
});
