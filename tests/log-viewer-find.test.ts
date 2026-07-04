import { describe, expect, it } from "vitest";
import { type LogLine, lineMatchesQuery, lineText } from "@/components/log-viewer";

describe("lineText", () => {
  it("includes a string payload verbatim", () => {
    expect(lineText({ id: 1, type: "text", payload: "hello world" })).toContain("hello world");
  });

  it("includes object payload fields (searchable transcript text)", () => {
    const line: LogLine = { id: 1, type: "text", payload: { text: "touched schema.ts" } };
    expect(lineText(line)).toContain("schema.ts");
  });

  it("surfaces a tool_use file path", () => {
    const line: LogLine = {
      id: 1,
      type: "tool_use",
      payload: { name: "Edit", input: { file_path: "src/lib/db/schema.ts" } },
    };
    expect(lineText(line)).toContain("src/lib/db/schema.ts");
  });

  it("surfaces a status transition target", () => {
    const line: LogLine = { id: 1, type: "status", payload: { to: "error_max_turns" } };
    expect(lineText(line)).toContain("error_max_turns");
  });
});

describe("lineMatchesQuery", () => {
  const line: LogLine = { id: 1, type: "error", payload: { stderr: "write failed: ENOSPC" } };

  it("matches every line when the query is empty", () => {
    expect(lineMatchesQuery(line, "")).toBe(true);
    expect(lineMatchesQuery(line, "   ")).toBe(true);
  });

  it("matches case-insensitively on payload content", () => {
    expect(lineMatchesQuery(line, "enospc")).toBe(true);
    expect(lineMatchesQuery(line, "ENOSPC")).toBe(true);
  });

  it("does not match when the term is absent", () => {
    expect(lineMatchesQuery(line, "timeout")).toBe(false);
  });
});
