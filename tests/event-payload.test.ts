import { describe, expect, it } from "vitest";
import { parseEventPayload } from "@/lib/stream/event-payload";

describe("parseEventPayload", () => {
  it("parses a valid JSON payload into its value", () => {
    expect(parseEventPayload('{"text":"hello"}')).toEqual({ text: "hello" });
  });

  it("returns a degraded fallback for invalid JSON instead of throwing", () => {
    expect(() => parseEventPayload("{not valid json")).not.toThrow();
    expect(parseEventPayload("{not valid json")).toEqual({
      error: "unparseable event payload",
    });
  });

  it("returns the fallback for an empty string", () => {
    expect(parseEventPayload("")).toEqual({ error: "unparseable event payload" });
  });
});
