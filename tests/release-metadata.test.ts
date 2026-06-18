import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeReleaseMetadata,
  parseReleaseMetadata,
  RELEASE_METADATA_PATH,
} from "@/lib/orchestrator/release-metadata";

describe("parseReleaseMetadata", () => {
  it("extracts a tag line, the title, and the notes", () => {
    const meta = parseReleaseMetadata("Tag: v1.4.0\nRelease 1.4.0\n\n- feat: x\n- fix: y");
    expect(meta).toEqual({ tag: "v1.4.0", title: "Release 1.4.0", notes: "- feat: x\n- fix: y" });
  });

  it("derives the tag from a version-looking title when no tag line is present", () => {
    const meta = parseReleaseMetadata("v2.0.0\n\nNotes here");
    expect(meta?.tag).toBe("v2.0.0");
    expect(meta?.title).toBe("v2.0.0");
    expect(meta?.notes).toBe("Notes here");
  });

  it("leaves the tag null for a non-version title with no tag line", () => {
    const meta = parseReleaseMetadata("Triggered release-please workflow\n\nNo tag cut directly.");
    expect(meta?.tag).toBeNull();
    expect(meta?.title).toBe("Triggered release-please workflow");
  });

  it("returns null for empty or whitespace-only content", () => {
    expect(parseReleaseMetadata("")).toBeNull();
    expect(parseReleaseMetadata("   \n\n")).toBeNull();
  });

  it("returns null when only a tag line is present (no title)", () => {
    expect(parseReleaseMetadata("Tag: v1.0.0")).toEqual({
      tag: "v1.0.0",
      title: "v1.0.0",
      notes: "",
    });
  });
});

describe("consumeReleaseMetadata", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drydock-release-meta-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the file is absent", () => {
    expect(consumeReleaseMetadata(dir)).toBeNull();
  });

  it("reads then removes the file so it never lingers", () => {
    mkdirSync(join(dir, ".drydock"), { recursive: true });
    const path = join(dir, RELEASE_METADATA_PATH);
    writeFileSync(path, "v3.1.0\n\nshipped");
    const meta = consumeReleaseMetadata(dir);
    expect(meta?.tag).toBe("v3.1.0");
    // A second consume finds nothing — the file was removed.
    expect(consumeReleaseMetadata(dir)).toBeNull();
  });
});
