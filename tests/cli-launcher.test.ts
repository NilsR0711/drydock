import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  detectInstallKind,
  isMainModule,
  parseArgs,
  planUpdate,
  resolveDataDir,
  resolveDbPath,
  resolveLatestVersion,
  updateCommand,
} from "../bin/drydock.mjs";

const DRYDOCK_BIN = fileURLToPath(new URL("../bin/drydock.mjs", import.meta.url));

describe("parseArgs", () => {
  it("defaults to serving on 127.0.0.1:3737 without opening a browser", () => {
    expect(parseArgs([])).toEqual({ mode: "serve", host: "127.0.0.1", port: 3737, open: false });
  });

  it("returns help mode for --help and -h, taking precedence over other flags", () => {
    expect(parseArgs(["--help"])).toEqual({ mode: "help" });
    expect(parseArgs(["-h"])).toEqual({ mode: "help" });
    expect(parseArgs(["--port", "8080", "--help"])).toEqual({ mode: "help" });
  });

  it("returns version mode for --version and -v", () => {
    expect(parseArgs(["--version"])).toEqual({ mode: "version" });
    expect(parseArgs(["-v"])).toEqual({ mode: "version" });
  });

  it("parses --port, -p and --port=N", () => {
    expect(parseArgs(["--port", "8080"]).port).toBe(8080);
    expect(parseArgs(["-p", "8080"]).port).toBe(8080);
    expect(parseArgs(["--port=8080"]).port).toBe(8080);
  });

  it("parses --host, -H and --host=H", () => {
    expect(parseArgs(["--host", "0.0.0.0"]).host).toBe("0.0.0.0");
    expect(parseArgs(["-H", "0.0.0.0"]).host).toBe("0.0.0.0");
    expect(parseArgs(["--host=0.0.0.0"]).host).toBe("0.0.0.0");
  });

  it("sets open when --open is given", () => {
    expect(parseArgs(["--open"]).open).toBe(true);
  });

  it("rejects a non-numeric port", () => {
    expect(() => parseArgs(["--port", "abc"])).toThrow(/invalid port/i);
  });

  it("rejects an out-of-range port", () => {
    expect(() => parseArgs(["--port", "0"])).toThrow(/invalid port/i);
    expect(() => parseArgs(["--port", "70000"])).toThrow(/invalid port/i);
  });

  it("rejects a flag that is missing its value", () => {
    expect(() => parseArgs(["--port"])).toThrow(/missing value/i);
  });

  it("rejects an unknown flag and names it", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/bogus/);
  });

  it("rejects an unexpected positional argument", () => {
    expect(() => parseArgs(["mcp"])).toThrow(/mcp/);
  });

  it("recognises the `update` subcommand", () => {
    expect(parseArgs(["update"])).toEqual({ mode: "update" });
  });

  it("rejects extra arguments after `update`", () => {
    expect(() => parseArgs(["update", "now"])).toThrow(/now/);
  });

  it("lets --help take precedence over `update`", () => {
    expect(parseArgs(["update", "--help"])).toEqual({ mode: "help" });
  });
});

describe("isMainModule", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drydock-main-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("treats the module as main when invoked directly", () => {
    expect(isMainModule(DRYDOCK_BIN, DRYDOCK_BIN)).toBe(true);
  });

  it("treats the module as main when invoked through a symlink (global/npx install)", () => {
    const link = join(dir, "drydock");
    symlinkSync(DRYDOCK_BIN, link);
    expect(isMainModule(DRYDOCK_BIN, link)).toBe(true);
  });

  it("is not main when the entry path points elsewhere", () => {
    expect(isMainModule(DRYDOCK_BIN, join(dir, "other.mjs"))).toBe(false);
  });

  it("is not main when there is no entry path", () => {
    expect(isMainModule(DRYDOCK_BIN, undefined)).toBe(false);
  });
});

describe("updateCommand", () => {
  it("installs the latest published version globally", () => {
    expect(updateCommand()).toEqual({
      command: "npm",
      args: ["install", "--global", "@nilsr0711/drydock@latest"],
    });
  });
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.2", "0.1.1")).toBe(1);
    expect(compareVersions("0.1.1", "0.1.2")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("tolerates a leading v", () => {
    expect(compareVersions("v0.1.2", "0.1.1")).toBe(1);
  });

  it("throws on an unparseable version", () => {
    expect(() => compareVersions("nope", "0.1.0")).toThrow();
  });
});

describe("planUpdate", () => {
  it("skips when already on the latest version", () => {
    expect(planUpdate("0.1.2", "0.1.2")).toEqual({ action: "skip", reason: "up-to-date" });
  });

  it("skips when the installed version is ahead of the registry (dev build)", () => {
    expect(planUpdate("0.2.0", "0.1.2")).toEqual({ action: "skip", reason: "up-to-date" });
  });

  it("installs and reports the transition when an update is available", () => {
    expect(planUpdate("0.1.1", "0.1.2")).toEqual({
      action: "install",
      reason: "update-available",
      latestVersion: "0.1.2",
    });
  });

  it("installs anyway when the latest version is unknown", () => {
    expect(planUpdate("0.1.1", null)).toEqual({ action: "install", reason: "unknown-latest" });
  });

  it("installs anyway when the latest version is unparseable", () => {
    expect(planUpdate("0.1.1", "garbage")).toEqual({ action: "install", reason: "unknown-latest" });
  });
});

describe("resolveLatestVersion", () => {
  // Minimal stand-in for fetch; only `ok` and `json` are read by the function.
  const fakeFetch = (impl: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>) =>
    impl as unknown as typeof fetch;

  it("reads the version from the npm registry latest dist-tag", async () => {
    const fetchImpl = fakeFetch(async () => ({
      ok: true,
      json: async () => ({ version: "0.1.2" }),
    }));
    expect(await resolveLatestVersion("@nilsr0711/drydock", { fetchImpl })).toBe("0.1.2");
  });

  it("returns null on a non-ok response", async () => {
    const fetchImpl = fakeFetch(async () => ({ ok: false, json: async () => ({}) }));
    expect(await resolveLatestVersion("@nilsr0711/drydock", { fetchImpl })).toBeNull();
  });

  it("returns null when the payload has no version", async () => {
    const fetchImpl = fakeFetch(async () => ({ ok: true, json: async () => ({}) }));
    expect(await resolveLatestVersion("@nilsr0711/drydock", { fetchImpl })).toBeNull();
  });

  it("returns null when the request throws", async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error("offline");
    });
    expect(await resolveLatestVersion("@nilsr0711/drydock", { fetchImpl })).toBeNull();
  });
});

describe("detectInstallKind", () => {
  it("classifies a global npm install", () => {
    expect(detectInstallKind("/usr/local/lib/node_modules/@nilsr0711/drydock")).toBe("global");
  });

  it("classifies an npx cache run", () => {
    expect(detectInstallKind("/home/jane/.npm/_npx/abc123/node_modules/@nilsr0711/drydock")).toBe(
      "npx",
    );
  });

  it("classifies a local development checkout", () => {
    expect(detectInstallKind("/home/jane/Programming/drydock")).toBe("local");
  });

  it("handles Windows-style separators", () => {
    expect(
      detectInstallKind(
        "C:\\Users\\jane\\AppData\\Roaming\\npm\\node_modules\\@nilsr0711\\drydock",
      ),
    ).toBe("global");
  });
});

describe("resolveDataDir", () => {
  it("defaults to ~/.drydock", () => {
    expect(resolveDataDir({ env: {}, home: "/home/jane" })).toBe("/home/jane/.drydock");
  });

  it("honours the DRYDOCK_DATA_DIR override", () => {
    expect(resolveDataDir({ env: { DRYDOCK_DATA_DIR: "/data/dd" }, home: "/home/jane" })).toBe(
      "/data/dd",
    );
  });

  it("falls back to the real home directory by default", () => {
    expect(resolveDataDir()).toBe(join(homedir(), ".drydock"));
  });
});

describe("resolveDbPath", () => {
  it("places the database inside the data directory", () => {
    expect(resolveDbPath({ env: {}, home: "/home/jane" })).toBe("/home/jane/.drydock/drydock.db");
  });

  it("honours an explicit DRYDOCK_DB override regardless of the data dir", () => {
    expect(resolveDbPath({ env: { DRYDOCK_DB: "/tmp/custom.db" }, home: "/home/jane" })).toBe(
      "/tmp/custom.db",
    );
  });
});
