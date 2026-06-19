import { describe, expect, it } from "vitest";
import { parsePrUrl } from "@/lib/forge/pr-url";

describe("parsePrUrl", () => {
  it("parses a canonical GitHub pull request URL", () => {
    expect(parsePrUrl("https://github.com/acme/widgets/pull/42")).toEqual({
      platform: "github",
      host: "github.com",
      owner: "acme",
      repo: "widgets",
      slug: "acme/widgets",
      prNumber: 42,
    });
  });

  it("ignores trailing path, query and fragment on a GitHub URL", () => {
    const parsed = parsePrUrl("https://github.com/acme/widgets/pull/42/files?w=1#r123");
    expect(parsed?.prNumber).toBe(42);
    expect(parsed?.slug).toBe("acme/widgets");
  });

  it("parses a GitHub Enterprise host", () => {
    const parsed = parsePrUrl("https://github.example.com/acme/widgets/pull/7");
    expect(parsed).toMatchObject({ platform: "github", host: "github.example.com", prNumber: 7 });
  });

  it("parses a canonical GitLab merge request URL", () => {
    expect(parsePrUrl("https://gitlab.com/acme/widgets/-/merge_requests/13")).toEqual({
      platform: "gitlab",
      host: "gitlab.com",
      owner: "acme",
      repo: "widgets",
      slug: "acme/widgets",
      prNumber: 13,
    });
  });

  it("parses a GitLab URL with nested subgroups", () => {
    expect(parsePrUrl("https://gitlab.com/group/sub/widgets/-/merge_requests/5")).toEqual({
      platform: "gitlab",
      host: "gitlab.com",
      owner: "group/sub",
      repo: "widgets",
      slug: "group/sub/widgets",
      prNumber: 5,
    });
  });

  it("parses a legacy GitLab merge request URL without the /-/ segment", () => {
    const parsed = parsePrUrl("https://gitlab.com/acme/widgets/merge_requests/9");
    expect(parsed).toMatchObject({ platform: "gitlab", slug: "acme/widgets", prNumber: 9 });
  });

  it("accepts a .git suffix on the repo segment", () => {
    expect(parsePrUrl("https://github.com/acme/widgets.git/pull/1")?.repo).toBe("widgets");
  });

  it("returns null for a non-PR URL", () => {
    expect(parsePrUrl("https://github.com/acme/widgets/issues/42")).toBeNull();
    expect(parsePrUrl("https://github.com/acme/widgets")).toBeNull();
  });

  it("returns null for a non-numeric or zero PR number", () => {
    expect(parsePrUrl("https://github.com/acme/widgets/pull/abc")).toBeNull();
    expect(parsePrUrl("https://github.com/acme/widgets/pull/0")).toBeNull();
  });

  it("returns null for non-http(s) schemes and garbage", () => {
    expect(parsePrUrl("ftp://github.com/acme/widgets/pull/1")).toBeNull();
    expect(parsePrUrl("not a url")).toBeNull();
    expect(parsePrUrl("")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(parsePrUrl("  https://github.com/acme/widgets/pull/3  ")?.prNumber).toBe(3);
  });

  it("uses the last token when a namespace segment shadows the PR keyword", () => {
    expect(parsePrUrl("https://gitlab.com/group/merge_requests/proj/-/merge_requests/5")).toEqual({
      platform: "gitlab",
      host: "gitlab.com",
      owner: "group/merge_requests/proj".split("/").slice(0, -1).join("/"),
      repo: "proj",
      slug: "group/merge_requests/proj",
      prNumber: 5,
    });
    expect(parsePrUrl("https://github.com/pull/widgets/pull/3")).toMatchObject({
      slug: "pull/widgets",
      prNumber: 3,
    });
  });
});
