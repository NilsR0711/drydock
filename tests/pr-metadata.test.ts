import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumePrMetadata,
  PR_METADATA_PATH,
  parsePrMetadata,
  readPrMetadata,
} from "@/lib/orchestrator/pr-metadata";

describe("parsePrMetadata", () => {
  it("returns null for empty or whitespace-only content", () => {
    expect(parsePrMetadata("")).toBeNull();
    expect(parsePrMetadata("   \n  \n")).toBeNull();
  });

  it("uses the first non-blank line as the title and the rest as the body", () => {
    const raw = [
      "feat(api): add pagination to the issues endpoint",
      "",
      "## Problem",
      "The endpoint returned every issue at once.",
    ].join("\n");

    expect(parsePrMetadata(raw)).toEqual({
      title: "feat(api): add pagination to the issues endpoint",
      body: ["## Problem", "The endpoint returned every issue at once."].join("\n"),
    });
  });

  it("skips leading blank lines before the title", () => {
    const raw = ["", "  ", "fix: handle missing config", "", "Body text."].join("\n");
    const meta = parsePrMetadata(raw);
    expect(meta?.title).toBe("fix: handle missing config");
    expect(meta?.body).toBe("Body text.");
  });

  it("yields an empty body when only a title line is present", () => {
    expect(parsePrMetadata("chore: bump deps\n")).toEqual({
      title: "chore: bump deps",
      body: "",
    });
  });

  it("caps a pathologically long title", () => {
    const meta = parsePrMetadata(`${"T".repeat(5_000)}\n\nbody`);
    expect(meta).not.toBeNull();
    expect(meta?.title.length).toBeLessThanOrEqual(300);
  });

  it("caps a pathologically long body with a truncation marker", () => {
    const meta = parsePrMetadata(`title\n\n${"B".repeat(100_000)}BODY_TAIL_SENTINEL`);
    expect(meta?.body).toContain("… (truncated)");
    expect(meta?.body).not.toContain("BODY_TAIL_SENTINEL");
  });
});

describe("readPrMetadata / consumePrMetadata", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drydock-prmeta-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write `.drydock/PR.md` under the temp worktree and return its absolute path. */
  function writeMeta(content: string) {
    const file = join(dir, PR_METADATA_PATH);
    mkdirSync(join(dir, ".drydock"), { recursive: true });
    writeFileSync(file, content);
    return file;
  }

  it("returns null when the file is absent", () => {
    expect(readPrMetadata(dir)).toBeNull();
    expect(consumePrMetadata(dir)).toBeNull();
  });

  it("reads and parses an existing file without deleting it", () => {
    const file = writeMeta("feat: ship it\n\nDetails.");
    expect(readPrMetadata(dir)).toEqual({ title: "feat: ship it", body: "Details." });
    expect(existsSync(file)).toBe(true);
  });

  it("consume reads, parses, and deletes the file so it never lands in the commit", () => {
    const file = writeMeta("feat: ship it\n\nDetails.");
    expect(consumePrMetadata(dir)).toEqual({ title: "feat: ship it", body: "Details." });
    expect(existsSync(file)).toBe(false);
  });

  it("consume deletes the file even when its content does not parse", () => {
    const file = writeMeta("   \n  ");
    expect(consumePrMetadata(dir)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });
});
