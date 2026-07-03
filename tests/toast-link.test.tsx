// @vitest-environment jsdom
import type { ReactNode } from "react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ToastInput, ToastProvider, useToast } from "@/components/ui/toast";
import { type Rendered, render } from "./fixtures/react";

// next/link only performs client-side navigation with a full App Router context,
// which jsdom cannot provide. Stub it with a marked anchor so the test can assert
// the toast renders its title *through* next/link (client-side routing) rather
// than a raw <a> that triggers a full document reload and drops SSE streams.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a data-nextlink="true" href={href} {...rest}>
      {children}
    </a>
  ),
}));

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

describe("toast link (issues #258, #405)", () => {
  it("renders the title as a client-side next/link when href is provided", () => {
    mounted = render(
      <ToastProvider>
        <Trigger input={{ title: "acme #42 needs a human", href: "/jobs/9", variant: "error" }} />
      </ToastProvider>,
    );
    const link = mounted.container.querySelector<HTMLAnchorElement>("a[href='/jobs/9']");
    expect(link).not.toBeNull();
    expect(link?.dataset.nextlink).toBe("true");
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
