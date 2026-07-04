// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { LogMatchSnippet } from "@/components/log-match-snippet";
import { MATCH_END, MATCH_START } from "@/lib/db/log-search";
import { type Rendered, render } from "./fixtures/react";

describe("LogMatchSnippet (issue #409)", () => {
  let mounted: Rendered | undefined;

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("wraps the matched span in <mark> while keeping surrounding context", () => {
    const snippet = `before ${MATCH_START}ENOSPC${MATCH_END} after`;
    mounted = render(<LogMatchSnippet snippet={snippet} />);
    expect(mounted.container.querySelector("mark")?.textContent).toBe("ENOSPC");
    // The control characters are consumed; only readable text remains.
    expect(mounted.container.textContent).toBe("before ENOSPC after");
  });

  it("renders plain context without a mark when nothing is delimited", () => {
    mounted = render(<LogMatchSnippet snippet="just context" />);
    expect(mounted.container.querySelector("mark")).toBeNull();
    expect(mounted.container.textContent).toBe("just context");
  });
});
