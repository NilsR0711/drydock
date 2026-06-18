// @vitest-environment jsdom
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { type ToastInput, ToastProvider, useToast } from "@/components/ui/toast";
import { type Rendered, render } from "./fixtures/react";

let mounted: Rendered | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = "";
});

/** Fires a single toast on mount so the test can inspect the rendered output. */
function Trigger({ input }: { input: ToastInput }) {
  const { toast } = useToast();
  useEffect(() => {
    toast(input);
  }, [toast, input]);
  return null;
}

describe("toast link (issue #258)", () => {
  it("renders the title as a job link when href is provided", () => {
    mounted = render(
      <ToastProvider>
        <Trigger input={{ title: "acme #42 needs a human", href: "/jobs/9", variant: "error" }} />
      </ToastProvider>,
    );
    const link = mounted.container.querySelector<HTMLAnchorElement>("a[href='/jobs/9']");
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("acme #42 needs a human");
  });

  it("renders a plain title when no href is provided", () => {
    mounted = render(
      <ToastProvider>
        <Trigger input={{ title: "Settings saved", variant: "success" }} />
      </ToastProvider>,
    );
    expect(mounted.container.querySelector("a")).toBeNull();
    expect(mounted.container.textContent).toContain("Settings saved");
  });
});
