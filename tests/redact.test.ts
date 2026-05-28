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
});
