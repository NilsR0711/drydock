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

  it("gates publish on a standalone smoke boot (issue #209)", () => {
    // The standalone bundle can build cleanly yet crash on boot when the Next
    // file tracer drops a runtime module. Booting `.next/standalone/server.js`
    // before upload is the only check that catches it, so prepublishOnly must
    // run the smoke test and an executable script must back it.
    expect(typeof pkg.scripts.smoke).toBe("string");
    expect(pkg.scripts.smoke).toMatch(/smoke-standalone/);
    expect(pkg.scripts.prepublishOnly).toMatch(/smoke/);
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

  it("runs the dev server through the memory-capped wrapper (issue #204)", () => {
    // `next dev` defaults to Turbopack, whose native memory grew unbounded
    // (~108 GB RSS) and hard-crashed the host. The wrapper pins webpack and
    // caps the V8 heap; guard against regressing back to a bare `next dev`.
    expect(pkg.scripts.dev).toMatch(/scripts\/dev\.mjs/);
    expect(pkg.scripts.dev).not.toMatch(/next dev/);
  });

  it("does not declare the unused UI-state packages zustand or nuqs (issue #427)", () => {
    // Both were listed as prod dependencies but imported nowhere in src/,
    // tests/, scripts/, bin/, or any config. They inflated the install size
    // and audit surface of the published package and — because prod deps are
    // baked into the standalone bundle — turned every Dependabot bump into a
    // pointless manual release cycle. Guard against them creeping back in via
    // any dependency section.
    const declared = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
    };
    expect(declared).not.toHaveProperty("zustand");
    expect(declared).not.toHaveProperty("nuqs");
  });
});
