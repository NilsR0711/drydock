import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeQuestions,
  parseQuestions,
  QUESTIONS_METADATA_PATH,
  readQuestions,
} from "@/lib/orchestrator/questions-metadata";

describe("parseQuestions", () => {
  it("returns null for empty or whitespace-only content", () => {
    expect(parseQuestions("")).toBeNull();
    expect(parseQuestions("   \n  \n\t")).toBeNull();
  });

  it("returns the trimmed question block verbatim", () => {
    const raw = [
      "  ",
      "## Open questions",
      "- Should the cache be per-user or global?",
      "- Which TTL is acceptable?",
      "  ",
    ].join("\n");
    expect(parseQuestions(raw)).toBe(
      [
        "## Open questions",
        "- Should the cache be per-user or global?",
        "- Which TTL is acceptable?",
      ].join("\n"),
    );
  });

  it("caps a pathologically long block with a truncation marker", () => {
    const parsed = parseQuestions(`${"Q".repeat(100_000)}QUESTION_TAIL_SENTINEL`);
    expect(parsed).toContain("… (truncated)");
    expect(parsed).not.toContain("QUESTION_TAIL_SENTINEL");
    expect((parsed ?? "").length).toBeLessThanOrEqual(60_000 + "\n… (truncated)".length);
  });
});

describe("readQuestions / consumeQuestions", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drydock-questions-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeQuestions(content: string): void {
    const full = join(dir, QUESTIONS_METADATA_PATH);
    mkdirSync(join(dir, ".drydock"), { recursive: true });
    writeFileSync(full, content, "utf8");
  }

  it("returns null when the file is absent", () => {
    expect(readQuestions(dir)).toBeNull();
    expect(consumeQuestions(dir)).toBeNull();
  });

  it("reads the question block without removing the file", () => {
    writeQuestions("Need a decision on the schema.");
    expect(readQuestions(dir)).toBe("Need a decision on the schema.");
    expect(existsSync(join(dir, QUESTIONS_METADATA_PATH))).toBe(true);
  });

  it("consume removes the file even when its content is empty", () => {
    writeQuestions("   \n");
    expect(consumeQuestions(dir)).toBeNull();
    expect(existsSync(join(dir, QUESTIONS_METADATA_PATH))).toBe(false);
  });

  it("consume returns the parsed questions and removes the file", () => {
    writeQuestions("Should I delete the legacy table?");
    expect(consumeQuestions(dir)).toBe("Should I delete the legacy table?");
    expect(existsSync(join(dir, QUESTIONS_METADATA_PATH))).toBe(false);
  });
});
