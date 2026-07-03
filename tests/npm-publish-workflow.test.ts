import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/npm-publish.yml"), "utf8");

// Minimum npm that supports tokenless OIDC trusted publishing (issue #395).
const MIN_NPM = [11, 5, 1] as const;

function gte(version: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    const a = version[i] ?? 0;
    const b = min[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

describe("npm-publish.yml npm version pin (issue #395)", () => {
  it("never installs the floating npm@latest in the publish job", () => {
    // `npm@latest` is a moving target: two runs of the same tag can publish
    // with different npm versions, and a future npm major could break the
    // release pipeline overnight. The publish job holds `id-token: write`, so
    // it must run a deliberately chosen npm, never whatever `latest` resolves
    // to. Matches only the executable install, so a comment may still explain
    // why the floating tag is avoided.
    expect(workflow).not.toMatch(/npm install -g npm@latest/);
  });

  it("pins the global npm to an exact, known-good version", () => {
    const match = workflow.match(/npm install -g npm@(\d+)\.(\d+)\.(\d+)\b/);
    expect(
      match,
      "expected an exact `npm install -g npm@X.Y.Z` pin in npm-publish.yml",
    ).not.toBeNull();
    if (match === null) return;
    const version = [Number(match[1]), Number(match[2]), Number(match[3])];
    // Trusted publishing (OIDC, tokenless) requires npm >= 11.5.1.
    expect(gte(version, MIN_NPM)).toBe(true);
  });
});
