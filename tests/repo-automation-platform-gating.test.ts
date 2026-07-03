import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { repoAutomation } from "@/lib/repos/automation";
import { addRepo, updateRepo } from "@/lib/repos/service";

/**
 * The review-feedback and release drivers can only run on a forge that
 * implements the optional review-thread / release methods (GitHub today). Both
 * toggles used to persist for any platform, so a GitLab repo could report
 * `autoReviewFeedback` on-by-default and `releaseEnabled` active while the
 * drivers silently skipped it (issue #407). `repoAutomation` is the effective
 * view both the drivers and the UI read, so it must clamp those flags to the
 * platform's real capability.
 */

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

function repoWithFlags(platform: "github" | "gitlab"): ReturnType<typeof addRepo> {
  const repo = addRepo(
    platform === "gitlab"
      ? { path: `/${platform}`, name: platform, platform, apiToken: "glpat-x" }
      : { path: `/${platform}`, name: platform, platform },
    db,
  );
  return updateRepo(repo.id, { autoReviewFeedback: true, releaseEnabled: true }, db);
}

describe("repoAutomation platform capability gating (issue #407)", () => {
  it("keeps both flags for a GitHub repo (no regression)", () => {
    const cfg = repoAutomation(repoWithFlags("github"));
    expect(cfg.autoReviewFeedback).toBe(true);
    expect(cfg.releaseEnabled).toBe(true);
  });

  it("clamps both flags to false for a GitLab repo even when persisted on", () => {
    const cfg = repoAutomation(repoWithFlags("gitlab"));
    expect(cfg.autoReviewFeedback).toBe(false);
    expect(cfg.releaseEnabled).toBe(false);
  });

  it("leaves other automation flags untouched by the platform gate", () => {
    const repo = updateRepo(
      addRepo({ path: "/gl", name: "gl", platform: "gitlab", apiToken: "t" }, db).id,
      { autoTriageEnabled: true, autoProcessEnabled: true },
      db,
    );
    const cfg = repoAutomation(repo);
    expect(cfg.autoTriageEnabled).toBe(true);
    expect(cfg.autoProcessEnabled).toBe(true);
  });
});
