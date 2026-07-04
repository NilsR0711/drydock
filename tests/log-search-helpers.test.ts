import { describe, expect, it } from "vitest";
import {
  buildLikeSnippet,
  escapeFtsMatch,
  escapeLikePattern,
  MATCH_END,
  MATCH_START,
  splitByMarkers,
  splitByQuery,
} from "@/lib/db/log-search";

describe("escapeFtsMatch", () => {
  it("wraps a plain term in a single quoted phrase", () => {
    expect(escapeFtsMatch("ENOSPC")).toBe('"ENOSPC"');
  });

  it("neutralizes FTS operators by treating the whole term as one phrase", () => {
    // Without quoting, `OR`/`NOT`/`*` would be parsed as query syntax.
    expect(escapeFtsMatch("foo OR bar")).toBe('"foo OR bar"');
    expect(escapeFtsMatch("crash*")).toBe('"crash*"');
  });

  it("escapes embedded double quotes by doubling them", () => {
    expect(escapeFtsMatch('say "hi"')).toBe('"say ""hi"""');
  });
});

describe("escapeLikePattern", () => {
  it("wraps the term in wildcards for a substring match", () => {
    expect(escapeLikePattern("login")).toBe("%login%");
  });

  it("escapes LIKE wildcards so % and _ match literally", () => {
    expect(escapeLikePattern("100%")).toBe("%100\\%%");
    expect(escapeLikePattern("re_name")).toBe("%re\\_name%");
  });

  it("escapes a literal backslash", () => {
    expect(escapeLikePattern("a\\b")).toBe("%a\\\\b%");
  });
});

describe("buildLikeSnippet", () => {
  it("wraps the first match in the highlight markers", () => {
    const snip = buildLikeSnippet('{"stderr":"write failed: ENOSPC now"}', "ENOSPC");
    expect(snip).toContain(`${MATCH_START}ENOSPC${MATCH_END}`);
  });

  it("preserves the matched substring's original casing", () => {
    const snip = buildLikeSnippet("The Path Is /Src/Db.ts here", "src/db.ts");
    expect(snip).toContain(`${MATCH_START}Src/Db.ts${MATCH_END}`);
  });

  it("adds a leading ellipsis when the match is not at the start", () => {
    const long = `${"x".repeat(200)} ENOSPC ${"y".repeat(200)}`;
    const snip = buildLikeSnippet(long, "ENOSPC");
    expect(snip.startsWith("…")).toBe(true);
    expect(snip.endsWith("…")).toBe(true);
    // The window stays short, not the whole 400+ char payload.
    expect(snip.length).toBeLessThan(long.length);
  });

  it("does not add a leading ellipsis when the match is at the very start", () => {
    const snip = buildLikeSnippet("ENOSPC and then more text", "ENOSPC");
    expect(snip.startsWith("…")).toBe(false);
  });

  it("falls back to a leading slice when the term is absent", () => {
    const snip = buildLikeSnippet("no needle in this haystack payload", "missing");
    expect(snip).not.toContain(MATCH_START);
    expect(snip.length).toBeGreaterThan(0);
  });
});

describe("splitByMarkers", () => {
  it("splits a marked snippet into plain and matched segments", () => {
    const text = `before ${MATCH_START}HIT${MATCH_END} after`;
    expect(splitByMarkers(text)).toEqual([
      { text: "before ", match: false },
      { text: "HIT", match: true },
      { text: " after", match: false },
    ]);
  });

  it("handles multiple matches", () => {
    const text = `${MATCH_START}a${MATCH_END}-${MATCH_START}b${MATCH_END}`;
    expect(splitByMarkers(text)).toEqual([
      { text: "a", match: true },
      { text: "-", match: false },
      { text: "b", match: true },
    ]);
  });

  it("returns plain text unchanged when there are no markers", () => {
    expect(splitByMarkers("plain")).toEqual([{ text: "plain", match: false }]);
  });

  it("does not throw on an unbalanced start marker", () => {
    const text = `oops ${MATCH_START}dangling`;
    expect(() => splitByMarkers(text)).not.toThrow();
    expect(
      splitByMarkers(text)
        .map((s) => s.text)
        .join(""),
    ).toBe("oops dangling");
  });
});

describe("splitByQuery", () => {
  it("marks case-insensitive matches while preserving original casing", () => {
    expect(splitByQuery("Fix the Bug now", "bug")).toEqual([
      { text: "Fix the ", match: false },
      { text: "Bug", match: true },
      { text: " now", match: false },
    ]);
  });

  it("returns the whole string unmarked for an empty query", () => {
    expect(splitByQuery("anything", "")).toEqual([{ text: "anything", match: false }]);
  });

  it("marks every occurrence", () => {
    expect(splitByQuery("aXaXa", "a")).toEqual([
      { text: "a", match: true },
      { text: "X", match: false },
      { text: "a", match: true },
      { text: "X", match: false },
      { text: "a", match: true },
    ]);
  });
});
