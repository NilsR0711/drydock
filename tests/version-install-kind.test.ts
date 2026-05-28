import { describe, expect, it } from "vitest";
import { getInstallKind } from "@/lib/version/current";

describe("getInstallKind", () => {
  it("reads the install kind from DRYDOCK_INSTALL_KIND", () => {
    expect(getInstallKind({ DRYDOCK_INSTALL_KIND: "global" })).toBe("global");
    expect(getInstallKind({ DRYDOCK_INSTALL_KIND: "npx" })).toBe("npx");
    expect(getInstallKind({ DRYDOCK_INSTALL_KIND: "local" })).toBe("local");
  });

  it("defaults to local when the variable is missing or unrecognised", () => {
    expect(getInstallKind({})).toBe("local");
    expect(getInstallKind({ DRYDOCK_INSTALL_KIND: "weird" })).toBe("local");
  });
});
