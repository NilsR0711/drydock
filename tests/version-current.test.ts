import { describe, expect, it } from "vitest";
import { getCurrentVersion } from "@/lib/version/current";

describe("getCurrentVersion", () => {
  it("prefers the DRYDOCK_VERSION environment variable", () => {
    expect(getCurrentVersion({ env: { DRYDOCK_VERSION: "1.4.2" } })).toBe("1.4.2");
  });

  it("trims surrounding whitespace from the env value", () => {
    expect(getCurrentVersion({ env: { DRYDOCK_VERSION: "  2.0.0 " } })).toBe("2.0.0");
  });

  it("falls back to the package.json version when the env var is absent", () => {
    expect(getCurrentVersion({ env: {}, readPackageVersion: () => "3.1.4" })).toBe("3.1.4");
  });

  it("returns 0.0.0 when the version cannot be determined (fail closed)", () => {
    expect(getCurrentVersion({ env: {}, readPackageVersion: () => null })).toBe("0.0.0");
  });

  it("returns 0.0.0 when reading the package version throws", () => {
    expect(
      getCurrentVersion({
        env: {},
        readPackageVersion: () => {
          throw new Error("no package.json");
        },
      }),
    ).toBe("0.0.0");
  });
});
