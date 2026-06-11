import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  classifyWebhookEvent,
  extractWebhookNudge,
  verifyGithubSignature,
  verifyGitlabToken,
  verifyWebhookSignature,
} from "@/lib/forge/webhook";

const SECRET = "s3cr3t-webhook-token";
const BODY = JSON.stringify({ action: "opened", issue: { number: 7 } });

function githubSignature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

describe("verifyGithubSignature", () => {
  it("accepts a correctly signed body", () => {
    expect(verifyGithubSignature(SECRET, BODY, githubSignature(SECRET, BODY))).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = githubSignature(SECRET, BODY);
    expect(verifyGithubSignature(SECRET, `${BODY} `, sig)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    expect(verifyGithubSignature(SECRET, BODY, githubSignature("other", BODY))).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    expect(verifyGithubSignature(SECRET, BODY, null)).toBe(false);
    expect(verifyGithubSignature(SECRET, BODY, "")).toBe(false);
    expect(verifyGithubSignature(SECRET, BODY, "garbage")).toBe(false);
  });
});

describe("verifyGitlabToken", () => {
  it("accepts a matching token", () => {
    expect(verifyGitlabToken(SECRET, SECRET)).toBe(true);
  });

  it("rejects a mismatched or missing token", () => {
    expect(verifyGitlabToken(SECRET, "nope")).toBe(false);
    expect(verifyGitlabToken(SECRET, null)).toBe(false);
    expect(verifyGitlabToken(SECRET, "")).toBe(false);
  });
});

describe("verifyWebhookSignature", () => {
  it("dispatches to HMAC verification for github", () => {
    expect(verifyWebhookSignature("github", SECRET, BODY, githubSignature(SECRET, BODY))).toBe(
      true,
    );
    expect(verifyWebhookSignature("github", SECRET, BODY, SECRET)).toBe(false);
  });

  it("dispatches to token comparison for gitlab", () => {
    expect(verifyWebhookSignature("gitlab", SECRET, BODY, SECRET)).toBe(true);
    expect(verifyWebhookSignature("gitlab", SECRET, BODY, githubSignature(SECRET, BODY))).toBe(
      false,
    );
  });

  it("rejects everything when no secret is configured", () => {
    expect(verifyWebhookSignature("github", "", BODY, githubSignature("", BODY))).toBe(false);
    expect(verifyWebhookSignature("gitlab", "", BODY, "")).toBe(false);
  });
});

describe("classifyWebhookEvent", () => {
  it("maps github issue events to 'issue'", () => {
    expect(classifyWebhookEvent("github", "issues")).toBe("issue");
    expect(classifyWebhookEvent("github", "issue_comment")).toBe("issue");
  });

  it("maps the github ping handshake to 'ping'", () => {
    expect(classifyWebhookEvent("github", "ping")).toBe("ping");
  });

  it("maps unrelated github events to 'other'", () => {
    expect(classifyWebhookEvent("github", "push")).toBe("other");
    expect(classifyWebhookEvent("github", null)).toBe("other");
  });

  it("maps gitlab issue and note hooks to 'issue'", () => {
    expect(classifyWebhookEvent("gitlab", "Issue Hook")).toBe("issue");
    expect(classifyWebhookEvent("gitlab", "Note Hook")).toBe("issue");
  });

  it("maps unrelated gitlab hooks to 'other'", () => {
    expect(classifyWebhookEvent("gitlab", "Push Hook")).toBe("other");
    expect(classifyWebhookEvent("gitlab", null)).toBe("other");
  });

  it("maps github check events to 'checks' (issue #180)", () => {
    expect(classifyWebhookEvent("github", "check_suite")).toBe("checks");
    expect(classifyWebhookEvent("github", "check_run")).toBe("checks");
  });

  it("maps github review events to 'review' (issue #180)", () => {
    expect(classifyWebhookEvent("github", "pull_request_review")).toBe("review");
    expect(classifyWebhookEvent("github", "pull_request_review_comment")).toBe("review");
  });

  it("maps gitlab pipeline hooks to 'checks' (issue #180)", () => {
    expect(classifyWebhookEvent("gitlab", "Pipeline Hook")).toBe("checks");
  });
});

describe("extractWebhookNudge — github checks", () => {
  it("extracts PR numbers from a completed check_suite", () => {
    const body = JSON.stringify({
      action: "completed",
      check_suite: { pull_requests: [{ number: 12 }, { number: 34 }] },
    });
    expect(extractWebhookNudge("github", "check_suite", body)).toEqual({
      kind: "checks",
      prNumbers: [12, 34],
    });
  });

  it("extracts PR numbers from a completed check_run", () => {
    const body = JSON.stringify({
      action: "completed",
      check_run: { pull_requests: [{ number: 7 }] },
    });
    expect(extractWebhookNudge("github", "check_run", body)).toEqual({
      kind: "checks",
      prNumbers: [7],
    });
  });

  it("returns an empty PR list for a fork PR whose payload carries none", () => {
    const body = JSON.stringify({ action: "completed", check_suite: { pull_requests: [] } });
    expect(extractWebhookNudge("github", "check_suite", body)).toEqual({
      kind: "checks",
      prNumbers: [],
    });
  });

  it("ignores check events that are not completed", () => {
    const requested = JSON.stringify({
      action: "requested",
      check_suite: { pull_requests: [{ number: 7 }] },
    });
    expect(extractWebhookNudge("github", "check_suite", requested)).toBeNull();
    const created = JSON.stringify({
      action: "created",
      check_run: { pull_requests: [{ number: 7 }] },
    });
    expect(extractWebhookNudge("github", "check_run", created)).toBeNull();
  });
});

describe("extractWebhookNudge — github reviews", () => {
  it("extracts the PR number from a submitted pull_request_review", () => {
    const body = JSON.stringify({ action: "submitted", pull_request: { number: 42 } });
    expect(extractWebhookNudge("github", "pull_request_review", body)).toEqual({
      kind: "review",
      prNumbers: [42],
    });
  });

  it("extracts the PR number from a created pull_request_review_comment", () => {
    const body = JSON.stringify({ action: "created", pull_request: { number: 42 } });
    expect(extractWebhookNudge("github", "pull_request_review_comment", body)).toEqual({
      kind: "review",
      prNumbers: [42],
    });
  });

  it("treats a review payload without a PR number as malformed (fail-closed)", () => {
    expect(
      extractWebhookNudge("github", "pull_request_review", JSON.stringify({ action: "submitted" })),
    ).toBeNull();
    expect(
      extractWebhookNudge(
        "github",
        "pull_request_review_comment",
        JSON.stringify({ action: "created", pull_request: { number: "42" } }),
      ),
    ).toBeNull();
  });

  it("ignores edited/dismissed/deleted review actions", () => {
    const edited = JSON.stringify({ action: "edited", pull_request: { number: 42 } });
    expect(extractWebhookNudge("github", "pull_request_review", edited)).toBeNull();
    const dismissed = JSON.stringify({ action: "dismissed", pull_request: { number: 42 } });
    expect(extractWebhookNudge("github", "pull_request_review", dismissed)).toBeNull();
    const deleted = JSON.stringify({ action: "deleted", pull_request: { number: 42 } });
    expect(extractWebhookNudge("github", "pull_request_review_comment", deleted)).toBeNull();
  });
});

describe("extractWebhookNudge — gitlab", () => {
  it("extracts the MR iid from a finished pipeline hook", () => {
    const body = JSON.stringify({
      object_attributes: { status: "success" },
      merge_request: { iid: 9 },
    });
    expect(extractWebhookNudge("gitlab", "Pipeline Hook", body)).toEqual({
      kind: "checks",
      prNumbers: [9],
    });
  });

  it("reports a finished branch pipeline without an MR as an empty PR list", () => {
    const body = JSON.stringify({ object_attributes: { status: "failed" } });
    expect(extractWebhookNudge("gitlab", "Pipeline Hook", body)).toEqual({
      kind: "checks",
      prNumbers: [],
    });
  });

  it("ignores pipelines that are still running or pending", () => {
    for (const status of ["running", "pending", "created"]) {
      const body = JSON.stringify({ object_attributes: { status }, merge_request: { iid: 9 } });
      expect(extractWebhookNudge("gitlab", "Pipeline Hook", body)).toBeNull();
    }
  });

  it("maps a note hook on a merge request to a review nudge", () => {
    const body = JSON.stringify({
      object_attributes: { noteable_type: "MergeRequest" },
      merge_request: { iid: 5 },
    });
    expect(extractWebhookNudge("gitlab", "Note Hook", body)).toEqual({
      kind: "review",
      prNumbers: [5],
    });
  });

  it("ignores note hooks on issues, commits and snippets", () => {
    for (const type of ["Issue", "Commit", "Snippet"]) {
      const body = JSON.stringify({ object_attributes: { noteable_type: type } });
      expect(extractWebhookNudge("gitlab", "Note Hook", body)).toBeNull();
    }
  });

  it("treats an MR note without an iid as malformed (fail-closed)", () => {
    const body = JSON.stringify({ object_attributes: { noteable_type: "MergeRequest" } });
    expect(extractWebhookNudge("gitlab", "Note Hook", body)).toBeNull();
  });
});

describe("extractWebhookNudge — robustness", () => {
  it("returns null for non-nudge events, malformed JSON and junk payload shapes", () => {
    expect(extractWebhookNudge("github", "issues", BODY)).toBeNull();
    expect(extractWebhookNudge("github", "ping", "{}")).toBeNull();
    expect(extractWebhookNudge("github", null, "{}")).toBeNull();
    expect(extractWebhookNudge("github", "check_suite", "not json")).toBeNull();
    expect(extractWebhookNudge("github", "check_suite", JSON.stringify({ action: 1 }))).toBeNull();
    expect(
      extractWebhookNudge(
        "github",
        "check_suite",
        JSON.stringify({ action: "completed", check_suite: { pull_requests: "junk" } }),
      ),
    ).toEqual({ kind: "checks", prNumbers: [] });
  });

  it("drops non-numeric PR entries instead of nudging a bogus key", () => {
    const body = JSON.stringify({
      action: "completed",
      check_suite: { pull_requests: [{ number: "12" }, { number: 7 }, {}, null] },
    });
    expect(extractWebhookNudge("github", "check_suite", body)).toEqual({
      kind: "checks",
      prNumbers: [7],
    });
  });
});
