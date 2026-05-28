import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));

describe("package.json publishability (issue #12)", () => {
  it("is no longer marked private", () => {
    expect(pkg.private).toBeUndefined();
  });

  it("exposes the `drydock` bin via the plain ESM launcher", () => {
    expect(pkg.bin).toEqual({ drydock: "bin/drydock.mjs" });
  });

  it("ships only build artifacts and the launcher — never sources or tests", () => {
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files).toContain("bin");
    expect(pkg.files).toContain(".next/standalone");
    expect(pkg.files).toContain(".next/static");
    expect(pkg.files).toContain("drizzle");
    for (const entry of pkg.files) {
      expect(entry).not.toMatch(/^src\b/);
      expect(entry).not.toMatch(/^tests\b/);
    }
  });

  it("carries the registry metadata npm needs", () => {
    expect(typeof pkg.description).toBe("string");
    expect(pkg.description.length).toBeGreaterThan(0);
    expect(Array.isArray(pkg.keywords)).toBe(true);
    expect(pkg.keywords.length).toBeGreaterThan(0);
    expect(pkg.license).toBe("MIT");
    expect(pkg.repository).toMatchObject({ type: "git" });
    expect(pkg.repository.url).toMatch(/NilsR0711\/drydock/);
    expect(typeof pkg.homepage).toBe("string");
    expect(pkg.bugs).toBeDefined();
  });

  it("publishes publicly and gates publish on a green build + tests", () => {
    expect(pkg.publishConfig).toMatchObject({ access: "public" });
    expect(typeof pkg.scripts.prepublishOnly).toBe("string");
    expect(pkg.scripts.prepublishOnly).toMatch(/test/);
    expect(pkg.scripts.prepublishOnly).toMatch(/build/);
  });

  it("requires a Node version that supports the standalone runtime", () => {
    expect(pkg.engines?.node).toBeDefined();
  });

  it("packages the standalone static assets as part of the build", () => {
    expect(pkg.scripts.build).toMatch(/package-standalone/);
  });

  it("builds the standalone bundle with webpack so native externals resolve", () => {
    // Turbopack references serverExternalPackages (better-sqlite3) by a hashed
    // module name that is unresolvable in the published standalone; webpack
    // emits a plain `require("better-sqlite3")`. Guard against regressing.
    expect(pkg.scripts.build).toMatch(/--webpack/);
  });
});
