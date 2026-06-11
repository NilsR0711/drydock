import { describe, expect, it } from "vitest";
import { redactSecrets } from "@/lib/log/redact";

describe("redactSecrets", () => {
  it("redacts GitHub personal access tokens", () => {
    const token = `ghp_${"a".repeat(36)}`;
    expect(redactSecrets(`using ${token} now`)).toBe("using [REDACTED] now");
  });

  it("redacts every GitHub token prefix", () => {
    for (const prefix of ["gho_", "ghu_", "ghs_", "ghr_"]) {
      const token = `${prefix}${"B".repeat(36)}`;
      expect(redactSecrets(token)).toBe("[REDACTED]");
    }
  });

  it("redacts fine-grained GitHub PATs", () => {
    const token = `github_pat_${"C".repeat(22)}_${"d".repeat(59)}`;
    expect(redactSecrets(`token=${token}`)).toBe("token=[REDACTED]");
  });

  it("redacts GitLab personal access tokens", () => {
    const token = `glpat-${"x".repeat(20)}`;
    expect(redactSecrets(token)).toBe("[REDACTED]");
  });

  it("redacts Bearer authorization values", () => {
    expect(redactSecrets("Authorization: Bearer aZ09._-secretvalue")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  it("redacts multiple secrets in one string", () => {
    const a = `ghp_${"a".repeat(36)}`;
    const b = `glpat-${"z".repeat(20)}`;
    expect(redactSecrets(`${a} and ${b}`)).toBe("[REDACTED] and [REDACTED]");
  });

  it("leaves text without secrets untouched", () => {
    const text = "git push origin main && gh pr create --title hello";
    expect(redactSecrets(text)).toBe(text);
  });

  it("does not redact short ghp-like words that are not tokens", () => {
    expect(redactSecrets("ghp_short")).toBe("ghp_short");
  });

  it("redacts tokens embedded in GitHub clone URLs", () => {
    const url = `https://x-access-token:${"a".repeat(40)}@github.com/owner/repo.git`;
    expect(redactSecrets(`remote: ${url}`)).toBe(
      "remote: https://[REDACTED]@github.com/owner/repo.git",
    );
  });

  it("redacts tokens embedded in GitLab clone URLs", () => {
    const url = `https://oauth2:${"z".repeat(20)}@gitlab.com/group/proj.git`;
    expect(redactSecrets(url)).toBe("https://[REDACTED]@gitlab.com/group/proj.git");
  });

  it("redacts PRIVATE-TOKEN header values", () => {
    expect(redactSecrets("PRIVATE-TOKEN: super-secret-value")).toBe("PRIVATE-TOKEN: [REDACTED]");
  });

  it("redacts Authorization Basic credentials", () => {
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe(
      "Authorization: Basic [REDACTED]",
    );
  });

  it("redacts AWS access key IDs", () => {
    const key = `AKIA${"A".repeat(16)}`;
    expect(redactSecrets(`AWS_ACCESS_KEY_ID=${key}`)).toBe("AWS_ACCESS_KEY_ID=[REDACTED]");
  });

  it("leaves ordinary URLs without credentials untouched", () => {
    const url = "https://github.com/owner/repo.git";
    expect(redactSecrets(url)).toBe(url);
  });

  it("redacts Anthropic API keys", () => {
    const key = `sk-ant-api03-${"Q".repeat(40)}`;
    expect(redactSecrets(`ANTHROPIC_API_KEY=${key}`)).toBe("ANTHROPIC_API_KEY=[REDACTED]");
  });

  it("redacts OpenAI API keys (plain and project-scoped)", () => {
    expect(redactSecrets(`sk-${"a".repeat(40)}`)).toBe("[REDACTED]");
    expect(redactSecrets(`sk-proj-${"b".repeat(40)}`)).toBe("[REDACTED]");
  });

  it("does not redact short sk- words that are not keys", () => {
    expect(redactSecrets("sk-short and sk-ant-short stay")).toBe("sk-short and sk-ant-short stay");
  });

  it("redacts OpenRouter API keys (issue #169)", () => {
    const key = `sk-or-v1-${"0123456789abcdef".repeat(4)}`;
    expect(redactSecrets(`OPENROUTER_API_KEY=${key}`)).toBe("OPENROUTER_API_KEY=[REDACTED]");
    expect(redactSecrets(`Bearer ${key}`)).toBe("Bearer [REDACTED]");
  });

  it("redacts Telegram bot tokens, including inside a Bot API URL", () => {
    const token = `123456789:AAH${"x".repeat(32)}`;
    expect(redactSecrets(`https://api.telegram.org/bot${token}/sendMessage`)).toBe(
      "https://api.telegram.org/bot[REDACTED]/sendMessage",
    );
    expect(redactSecrets(`token ${token} end`)).toBe("token [REDACTED] end");
  });
});

describe("redactSecrets on serialized JSON (issue: broker payload corruption)", () => {
  it("never matches a URL-with-port across JSON string boundaries", () => {
    // A port URL in one field plus an `@` in a later field used to be swallowed
    // into one bogus "credential", structurally destroying the payload.
    const json = JSON.stringify({ t: { u: "https://h:1" }, e: "x@y" });
    expect(redactSecrets(json)).toBe(json);
    expect(() => JSON.parse(redactSecrets(json))).not.toThrow();
  });

  it("keeps sibling fields intact when a URL with a port precedes an email", () => {
    const json = JSON.stringify({
      a: "https://example.com:8443",
      n: 42,
      email: "ops@example.com",
    });
    expect(redactSecrets(json)).toBe(json);
  });

  it("still redacts real URL credentials inside a JSON string", () => {
    const json = JSON.stringify({ remote: `https://oauth2:${"z".repeat(20)}@gitlab.com/g/p.git` });
    const out = redactSecrets(json);
    expect(JSON.parse(out)).toEqual({ remote: "https://[REDACTED]@gitlab.com/g/p.git" });
  });

  it("stops a PRIVATE-TOKEN match at the JSON string boundary", () => {
    const json = JSON.stringify({ h: "PRIVATE-TOKEN: secret", x: 1 });
    const out = redactSecrets(json);
    expect(JSON.parse(out)).toEqual({ h: "PRIVATE-TOKEN: [REDACTED]", x: 1 });
  });
});
