import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDevArgs,
  buildDevEnv,
  DEFAULT_DEV_HEAP_MB,
  isMainModule,
  resolveDevHeapMb,
} from "../scripts/dev.mjs";

// Guards the fix for issue #204: `next dev` defaults to Turbopack, whose native
// memory grew unbounded (~108 GB RSS) and hard-crashed the host. The dev wrapper
// pins webpack and caps the V8 heap so a runaway dev server fails fast instead.

describe("resolveDevHeapMb", () => {
  it("defaults to the built-in heap cap when unset", () => {
    expect(resolveDevHeapMb({})).toBe(DEFAULT_DEV_HEAP_MB);
  });

  it("honours a positive DRYDOCK_DEV_HEAP_MB override", () => {
    expect(resolveDevHeapMb({ DRYDOCK_DEV_HEAP_MB: "8192" })).toBe(8192);
  });

  it("falls back to the default for non-positive or unparseable overrides", () => {
    expect(resolveDevHeapMb({ DRYDOCK_DEV_HEAP_MB: "0" })).toBe(DEFAULT_DEV_HEAP_MB);
    expect(resolveDevHeapMb({ DRYDOCK_DEV_HEAP_MB: "-512" })).toBe(DEFAULT_DEV_HEAP_MB);
    expect(resolveDevHeapMb({ DRYDOCK_DEV_HEAP_MB: "abc" })).toBe(DEFAULT_DEV_HEAP_MB);
    expect(resolveDevHeapMb({ DRYDOCK_DEV_HEAP_MB: "" })).toBe(DEFAULT_DEV_HEAP_MB);
  });
});

describe("buildDevEnv", () => {
  it("caps the V8 old-space heap when NODE_OPTIONS is unset", () => {
    expect(buildDevEnv({}).NODE_OPTIONS).toBe(`--max-old-space-size=${DEFAULT_DEV_HEAP_MB}`);
  });

  it("appends the heap cap while preserving existing NODE_OPTIONS", () => {
    expect(buildDevEnv({ NODE_OPTIONS: "--enable-source-maps" }).NODE_OPTIONS).toBe(
      `--enable-source-maps --max-old-space-size=${DEFAULT_DEV_HEAP_MB}`,
    );
  });

  it("respects an operator's explicit --max-old-space-size override", () => {
    expect(buildDevEnv({ NODE_OPTIONS: "--max-old-space-size=2048" }).NODE_OPTIONS).toBe(
      "--max-old-space-size=2048",
    );
  });

  it("uses the DRYDOCK_DEV_HEAP_MB cap", () => {
    expect(buildDevEnv({ DRYDOCK_DEV_HEAP_MB: "8192" }).NODE_OPTIONS).toBe(
      "--max-old-space-size=8192",
    );
  });

  it("preserves other environment variables without mutating the input", () => {
    const input: Record<string, string | undefined> = { PATH: "/usr/bin", FOO: "bar" };
    const result = buildDevEnv(input);
    expect(result.PATH).toBe("/usr/bin");
    expect(result.FOO).toBe("bar");
    expect(input.NODE_OPTIONS).toBeUndefined();
  });
});

describe("buildDevArgs", () => {
  it("runs the dev server on webpack, never Turbopack", () => {
    const args = buildDevArgs();
    expect(args).toContain("--webpack");
    expect(args).not.toContain("--turbo");
    expect(args).not.toContain("--turbopack");
  });

  it("binds to the loopback dashboard host and port by default", () => {
    expect(buildDevArgs()).toEqual(["dev", "--webpack", "-H", "127.0.0.1", "-p", "3737"]);
  });

  it("accepts host and port overrides", () => {
    expect(buildDevArgs({ host: "0.0.0.0", port: 4000 })).toEqual([
      "dev",
      "--webpack",
      "-H",
      "0.0.0.0",
      "-p",
      "4000",
    ]);
  });
});

describe("isMainModule", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drydock-dev-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const DEV_SCRIPT = fileURLToPath(new URL("../scripts/dev.mjs", import.meta.url));

  it("is true when invoked as the entry point", () => {
    expect(isMainModule(DEV_SCRIPT, DEV_SCRIPT)).toBe(true);
  });

  it("resolves symlinked entry paths to the real module", () => {
    const link = join(dir, "dev-link.mjs");
    symlinkSync(DEV_SCRIPT, link);
    expect(isMainModule(DEV_SCRIPT, link)).toBe(true);
  });

  it("is false when imported (different entry) or without an entry path", () => {
    expect(isMainModule(DEV_SCRIPT, join(dir, "other.mjs"))).toBe(false);
    expect(isMainModule(DEV_SCRIPT, undefined)).toBe(false);
  });
});
