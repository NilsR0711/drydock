import { describe, expect, it } from "vitest";
import { getForge } from "@/lib/forge/registry";
import { type ForgeCapability, platformSupportsCapability } from "@/lib/forge/types";

/**
 * The optional review-feedback and release methods are GitHub-only today
 * (issue #407). The orchestrator drivers gate on the concrete client's methods
 * at runtime; `platformSupportsCapability` is the client-safe mirror the
 * workspace UI uses to disable toggles a platform can never honour. These tests
 * pin the declared table and — crucially — assert it stays in lock-step with
 * what the real forge clients actually implement, so closing the GitLab gap
 * can't silently leave the UI lying.
 */

/** The concrete `ForgeClient` methods each capability requires (mirrors the driver guards). */
const CAPABILITY_METHODS: Record<ForgeCapability, readonly string[]> = {
  reviewFeedback: [
    "listReviewThreads",
    "replyToReviewThread",
    "updateReviewComment",
    "resolveReviewThread",
    "reactToReviewComment",
  ],
  releaseManagement: ["listReleases", "listMergedPrs", "createRelease"],
};

describe("platformSupportsCapability", () => {
  it("reports GitHub as supporting both review-feedback and release management", () => {
    expect(platformSupportsCapability("github", "reviewFeedback")).toBe(true);
    expect(platformSupportsCapability("github", "releaseManagement")).toBe(true);
  });

  it("reports GitLab as supporting neither (the current gap)", () => {
    expect(platformSupportsCapability("gitlab", "reviewFeedback")).toBe(false);
    expect(platformSupportsCapability("gitlab", "releaseManagement")).toBe(false);
  });

  it("falls back to the default forge (GitHub) for unknown/missing platforms", () => {
    expect(platformSupportsCapability("", "reviewFeedback")).toBe(true);
    expect(platformSupportsCapability(null, "releaseManagement")).toBe(true);
    expect(platformSupportsCapability(undefined, "reviewFeedback")).toBe(true);
    expect(platformSupportsCapability("bitbucket", "releaseManagement")).toBe(true);
  });

  // Drift guard: the declared table must match reality. If someone implements
  // the GitLab MR Discussions / Releases APIs (or removes a GitHub method) this
  // fails until the capability table is corrected — the UI can never claim a
  // capability the client lacks, nor hide one it has.
  it.each([
    "github",
    "gitlab",
  ] as const)("declares capabilities for %s that match its forge client's methods", (platform) => {
    const forge = getForge({ path: ".", platform }) as unknown as Record<string, unknown>;
    for (const capability of Object.keys(CAPABILITY_METHODS) as ForgeCapability[]) {
      const implemented = CAPABILITY_METHODS[capability].every(
        (m) => typeof forge[m] === "function",
      );
      expect(
        platformSupportsCapability(platform, capability),
        `${platform} ${capability}: declared support must equal method presence`,
      ).toBe(implemented);
    }
  });
});
