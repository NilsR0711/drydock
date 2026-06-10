import { describe, expect, it } from "vitest";
import {
  classifyFeedback,
  feedbackMarker,
  hasOurReply,
  isTrustedReviewer,
  statusForClassification,
} from "@/lib/orchestrator/review-feedback";

describe("isTrustedReviewer", () => {
  const cfg = {
    trustedReviewers: ["alice", "Bob"],
    trustedBots: [],
    ignoredBots: ["dependabot[bot]"],
  };

  it("accepts an allowlisted human (case-insensitive)", () => {
    expect(isTrustedReviewer("alice", cfg)).toBe(true);
    expect(isTrustedReviewer("BOB", cfg)).toBe(true);
  });

  it("rejects a reviewer not on the allowlist", () => {
    expect(isTrustedReviewer("mallory", cfg)).toBe(false);
  });

  it("ignores configured bots even if otherwise allowlisted", () => {
    expect(
      isTrustedReviewer("dependabot[bot]", { ...cfg, trustedReviewers: ["dependabot[bot]"] }),
    ).toBe(false);
  });

  it("ignores [bot] logins that are not on the trusted-bots allowlist", () => {
    expect(
      isTrustedReviewer("some-ci[bot]", {
        trustedReviewers: ["some-ci[bot]"],
        trustedBots: [],
        ignoredBots: [],
      }),
    ).toBe(false);
  });

  it("accepts an allowlisted bot (case-insensitive) — issue #158", () => {
    const gate = { trustedReviewers: [], trustedBots: ["cursor[bot]"], ignoredBots: [] };
    expect(isTrustedReviewer("cursor[bot]", gate)).toBe(true);
    expect(isTrustedReviewer("Cursor[bot]", gate)).toBe(true);
  });

  it("trusted-bots entries do not grant trust to humans", () => {
    expect(
      isTrustedReviewer("alice", { trustedReviewers: [], trustedBots: ["alice"], ignoredBots: [] }),
    ).toBe(false);
  });

  it("an explicit ignore beats the trusted-bots allowlist", () => {
    expect(
      isTrustedReviewer("cursor[bot]", {
        trustedReviewers: [],
        trustedBots: ["cursor[bot]"],
        ignoredBots: ["cursor[bot]"],
      }),
    ).toBe(false);
  });

  it("trusts nobody when the allowlists are empty (opt-in safety)", () => {
    expect(
      isTrustedReviewer("alice", { trustedReviewers: [], trustedBots: [], ignoredBots: [] }),
    ).toBe(false);
    expect(
      isTrustedReviewer("cursor[bot]", {
        trustedReviewers: [],
        trustedBots: [],
        ignoredBots: [],
      }),
    ).toBe(false);
  });
});

describe("classifyFeedback", () => {
  it("treats a plain change request as actionable", () => {
    expect(classifyFeedback("Please rename this variable to `count`.")).toBe("actionable");
    expect(classifyFeedback("Extract this into a helper and add a test.")).toBe("actionable");
  });

  it("treats an interrogative comment as a question", () => {
    expect(classifyFeedback("Why did you choose a map here instead of a set?")).toBe("question");
    expect(classifyFeedback("Is this thread-safe?")).toBe("question");
  });

  it("treats explicitly deferred feedback as out of scope", () => {
    expect(classifyFeedback("This is out of scope for this PR; let's do it in a follow-up.")).toBe(
      "out_of_scope",
    );
    expect(classifyFeedback("Unrelated, but we should track this in a separate PR.")).toBe(
      "out_of_scope",
    );
  });

  it("prefers an imperative request over a trailing question mark", () => {
    expect(classifyFeedback("Please guard against null here, can you?")).toBe("actionable");
  });
});

describe("statusForClassification", () => {
  it("maps each classification to its lifecycle entry state", () => {
    expect(statusForClassification("actionable")).toBe("queued");
    expect(statusForClassification("question")).toBe("flagged");
    expect(statusForClassification("out_of_scope")).toBe("rejected");
  });
});

describe("feedbackMarker / hasOurReply", () => {
  it("builds a stable per-thread marker", () => {
    expect(feedbackMarker("THREAD_abc")).toBe("<!-- drydock:review-feedback:THREAD_abc -->");
  });

  it("detects a prior Drydock reply by its marker", () => {
    const comments = [
      { author: "alice", body: "please fix" },
      { author: "drydock-bot", body: "done\n<!-- drydock:review-feedback:THREAD_abc -->" },
    ];
    expect(hasOurReply(comments, "THREAD_abc")).toBe(true);
    expect(hasOurReply(comments, "THREAD_other")).toBe(false);
  });
});
