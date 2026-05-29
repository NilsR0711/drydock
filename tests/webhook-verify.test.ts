import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  classifyWebhookEvent,
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
});
