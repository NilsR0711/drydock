import { describe, expect, it } from "vitest";
import { bumpSemver, compareSemver, isNewerVersion, parseSemver } from "@/lib/version/semver";

describe("parseSemver", () => {
  it("parses a plain version", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
  });

  it("strips a leading v prefix", () => {
    expect(parseSemver("v0.1.1")).toEqual({ major: 0, minor: 1, patch: 1, prerelease: null });
  });

  it("captures a prerelease label", () => {
    expect(parseSemver("1.2.3-beta.1")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: "beta.1",
    });
  });

  it("ignores build metadata", () => {
    expect(parseSemver("1.2.3+build.5")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
    });
  });

  it("returns null for a non-semver string", () => {
    expect(parseSemver("not-a-version")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareSemver("1.1.2", "1.1.1")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "2.0.0")).toBeLessThan(0);
  });

  it("treats equal versions as equal", () => {
    expect(compareSemver("1.2.3", "v1.2.3")).toBe(0);
  });

  it("ranks a prerelease below its release", () => {
    expect(compareSemver("1.2.3-rc.1", "1.2.3")).toBeLessThan(0);
    expect(compareSemver("1.2.3", "1.2.3-rc.1")).toBeGreaterThan(0);
  });
});

describe("bumpSemver", () => {
  it("bumps the patch component", () => {
    expect(bumpSemver("1.2.3", "patch")).toBe("1.2.4");
  });

  it("bumps the minor component and resets patch", () => {
    expect(bumpSemver("1.2.3", "minor")).toBe("1.3.0");
  });

  it("bumps the major component and resets minor and patch", () => {
    expect(bumpSemver("1.2.3", "major")).toBe("2.0.0");
  });

  it("ignores a leading v prefix and any prerelease label", () => {
    expect(bumpSemver("v1.2.3-rc.1", "patch")).toBe("1.2.4");
  });

  it("throws for an unparseable version", () => {
    expect(() => bumpSemver("not-a-version", "patch")).toThrow();
  });
});

describe("isNewerVersion", () => {
  it("is true when the candidate is greater", () => {
    expect(isNewerVersion("1.2.4", "1.2.3")).toBe(true);
  });

  it("is false when the candidate is equal or older", () => {
    expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false);
    expect(isNewerVersion("1.2.2", "1.2.3")).toBe(false);
  });

  it("is false when either side is unparseable (fail closed)", () => {
    expect(isNewerVersion("garbage", "1.2.3")).toBe(false);
    expect(isNewerVersion("1.2.4", "garbage")).toBe(false);
  });
});
