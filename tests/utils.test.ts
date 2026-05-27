import { cn } from "@/lib/utils";
import { describe, expect, it } from "vitest";

describe("cn", () => {
  it("joins truthy class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("drops falsy values", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });

  it("returns empty string when nothing truthy", () => {
    expect(cn(false, null)).toBe("");
  });
});
