// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { CredentialBanner } from "@/components/credential-banner";
import { type Rendered, render } from "./fixtures/react";

let mounted: Rendered | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

const failures = [
  { target: "github", label: "GitHub CLI auth", message: "Re-authenticate with `gh auth login`." },
  { target: "agent:openrouter", label: "OpenRouter API key", message: "HTTP 401" },
];

describe("CredentialBanner (issue #177)", () => {
  it("renders nothing while credentials are healthy", () => {
    mounted = render(<CredentialBanner failures={[]} />);
    expect(mounted.container.innerHTML).toBe("");
  });

  it("lists every failing target with its message", () => {
    mounted = render(<CredentialBanner failures={failures} />);
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("GitHub CLI auth");
    expect(text).toContain("Re-authenticate with `gh auth login`.");
    expect(text).toContain("OpenRouter API key");
    expect(text).toContain("HTTP 401");
  });

  it("explains that new jobs are paused until auth recovers", () => {
    mounted = render(<CredentialBanner failures={failures} />);
    expect(mounted.container.textContent).toMatch(/new jobs are paused/i);
  });

  it("announces the outage as an alert for assistive tech", () => {
    mounted = render(<CredentialBanner failures={failures} />);
    expect(mounted.container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
