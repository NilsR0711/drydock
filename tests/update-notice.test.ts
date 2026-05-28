import { describe, expect, it } from "vitest";
import type { UpdateStatus } from "@/lib/version/update-check";
import { shouldShowUpdateNotice } from "@/lib/version/update-notice";

const updateAvailable: UpdateStatus = {
  updateAvailable: true,
  currentVersion: "0.1.1",
  latestVersion: "0.2.0",
  releaseUrl: "https://example/releases/v0.2.0",
};

describe("shouldShowUpdateNotice", () => {
  it("shows the notice when an update is available and nothing was dismissed", () => {
    expect(shouldShowUpdateNotice(updateAvailable, null)).toBe(true);
  });

  it("hides the notice when no update is available", () => {
    expect(
      shouldShowUpdateNotice(
        {
          updateAvailable: false,
          currentVersion: "0.1.1",
          latestVersion: "0.1.1",
          releaseUrl: null,
        },
        null,
      ),
    ).toBe(false);
  });

  it("hides the notice when the available version was already dismissed", () => {
    expect(shouldShowUpdateNotice(updateAvailable, "0.2.0")).toBe(false);
  });

  it("shows the notice again when a newer version supersedes the dismissed one", () => {
    expect(shouldShowUpdateNotice(updateAvailable, "0.1.5")).toBe(true);
  });
});
