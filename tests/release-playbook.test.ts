import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeReleasePlaybook,
  parseReleasePlaybook,
  RELEASE_PLAYBOOK_MAX_CHARS,
  RELEASE_PLAYBOOK_PATH,
  releasePlaybookPromptValue,
} from "@/lib/orchestrator/release-playbook";

describe("parseReleasePlaybook", () => {
  it("returns the trimmed content for a usable playbook", () => {
    expect(parseReleasePlaybook("\n  1. run pnpm release\n  2. push the tag\n  ")).toBe(
      "1. run pnpm release\n  2. push the tag",
    );
  });

  it("returns null for empty or whitespace-only content", () => {
    expect(parseReleasePlaybook("")).toBeNull();
    expect(parseReleasePlaybook("   \n\t\n")).toBeNull();
  });

  it("caps an oversized playbook and marks it truncated", () => {
    const huge = "x".repeat(RELEASE_PLAYBOOK_MAX_CHARS + 500);
    const parsed = parseReleasePlaybook(huge);
    expect(parsed).not.toBeNull();
    // The truncation marker is counted inside the cap, so the final string fits.
    expect((parsed as string).length).toBeLessThanOrEqual(RELEASE_PLAYBOOK_MAX_CHARS);
    expect(parsed).toMatch(/truncated/);
  });
});

describe("consumeReleasePlaybook", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drydock-release-playbook-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the file is absent", () => {
    expect(consumeReleasePlaybook(dir)).toBeNull();
  });

  it("reads then removes the file so it never lingers", () => {
    mkdirSync(join(dir, ".drydock"), { recursive: true });
    writeFileSync(join(dir, RELEASE_PLAYBOOK_PATH), "1. dispatch release-please\n2. publish tag");
    expect(consumeReleasePlaybook(dir)).toBe("1. dispatch release-please\n2. publish tag");
    // A second consume finds nothing — the file was removed.
    expect(consumeReleasePlaybook(dir)).toBeNull();
  });

  it("treats a blank file as no playbook", () => {
    mkdirSync(join(dir, ".drydock"), { recursive: true });
    writeFileSync(join(dir, RELEASE_PLAYBOOK_PATH), "   \n\n");
    expect(consumeReleasePlaybook(dir)).toBeNull();
  });
});

describe("releasePlaybookPromptValue", () => {
  it("instructs a from-scratch investigation when no playbook is recorded", () => {
    const value = releasePlaybookPromptValue(null);
    expect(value).toMatch(/no release playbook/i);
    expect(value).toMatch(/scratch/i);
  });

  it("embeds a recorded playbook with a follow-and-verify instruction", () => {
    const value = releasePlaybookPromptValue("1. run pnpm release\n2. push the tag");
    expect(value).toMatch(/recorded/i);
    expect(value).toMatch(/verif/i);
    expect(value).toContain("1. run pnpm release\n2. push the tag");
  });

  it("treats a blank playbook the same as none", () => {
    expect(releasePlaybookPromptValue("   ")).toBe(releasePlaybookPromptValue(null));
  });
});
