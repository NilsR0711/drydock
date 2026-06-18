import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeFollowups,
  FOLLOWUPS_METADATA_PATH,
  parseFollowups,
  readFollowups,
} from "@/lib/orchestrator/followups-metadata";

describe("parseFollowups", () => {
  it("returns an empty list for empty or whitespace-only content", () => {
    expect(parseFollowups("")).toEqual([]);
    expect(parseFollowups("   \n  \n\t")).toEqual([]);
  });

  it("ignores prose with no `## ` heading (no usable title)", () => {
    expect(parseFollowups("Just some notes the agent left, no headings.")).toEqual([]);
  });

  it("parses `## title` blocks into title + body entries", () => {
    const raw = [
      "Intro prose before the first heading is ignored.",
      "",
      "## feat(api): paginate the issues endpoint",
      "",
      "The endpoint returns everything. Out of scope here.",
      "Acceptance: results are cursor-paginated.",
      "",
      "## fix(ui): debounce the search box",
      "Typing fires a request per keystroke.",
    ].join("\n");

    expect(parseFollowups(raw)).toEqual([
      {
        title: "feat(api): paginate the issues endpoint",
        body: "The endpoint returns everything. Out of scope here.\nAcceptance: results are cursor-paginated.",
      },
      {
        title: "fix(ui): debounce the search box",
        body: "Typing fires a request per keystroke.",
      },
    ]);
  });

  it("keeps an entry whose body is empty", () => {
    expect(parseFollowups("## chore: drop the legacy column")).toEqual([
      { title: "chore: drop the legacy column", body: "" },
    ]);
  });

  it("trims the heading text and skips a heading with no title text", () => {
    const raw = ["##   ", "Body for the empty heading.", "##  real title  ", "Body."].join("\n");
    expect(parseFollowups(raw)).toEqual([{ title: "real title", body: "Body." }]);
  });

  it("dedupes repeated titles within the file, keeping the first body", () => {
    const raw = ["## dup title", "First body.", "## dup title", "Second body."].join("\n");
    expect(parseFollowups(raw)).toEqual([{ title: "dup title", body: "First body." }]);
  });

  it("caps the number of entries so a pathological file cannot file unbounded issues", () => {
    const raw = Array.from({ length: 100 }, (_, i) => `## entry ${i}\nbody ${i}`).join("\n");
    const parsed = parseFollowups(raw);
    expect(parsed.length).toBe(20);
    expect(parsed[0]?.title).toBe("entry 0");
  });

  it("caps an over-long title and body with a truncation marker on the body", () => {
    const raw = `## ${"T".repeat(500)}\n${"B".repeat(100_000)}BODY_TAIL_SENTINEL`;
    const [entry] = parseFollowups(raw);
    expect(entry?.title.length).toBe(300);
    expect(entry?.body).toContain("… (truncated)");
    expect(entry?.body).not.toContain("BODY_TAIL_SENTINEL");
  });
});

describe("readFollowups / consumeFollowups", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drydock-followups-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFollowups(content: string): void {
    mkdirSync(join(dir, ".drydock"), { recursive: true });
    writeFileSync(join(dir, FOLLOWUPS_METADATA_PATH), content, "utf8");
  }

  it("returns an empty list when the file is absent", () => {
    expect(readFollowups(dir)).toEqual([]);
    expect(consumeFollowups(dir)).toEqual([]);
  });

  it("reads the entries without removing the file", () => {
    writeFollowups("## chore: tidy up\nbody");
    expect(readFollowups(dir)).toEqual([{ title: "chore: tidy up", body: "body" }]);
    expect(existsSync(join(dir, FOLLOWUPS_METADATA_PATH))).toBe(true);
  });

  it("consume removes the file even when its content has no entries", () => {
    writeFollowups("   \n");
    expect(consumeFollowups(dir)).toEqual([]);
    expect(existsSync(join(dir, FOLLOWUPS_METADATA_PATH))).toBe(false);
  });

  it("consume returns the parsed entries and removes the file", () => {
    writeFollowups("## feat: new thing\nwhy it matters");
    expect(consumeFollowups(dir)).toEqual([{ title: "feat: new thing", body: "why it matters" }]);
    expect(existsSync(join(dir, FOLLOWUPS_METADATA_PATH))).toBe(false);
  });
});
