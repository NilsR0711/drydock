import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSafeHost,
  compareVersions,
  detectInstallKind,
  isLoopbackHost,
  isMainModule,
  parseArgs,
  planUpdate,
  resolveDataDir,
  resolveDbPath,
  resolveLatestVersion,
  resolveMcpEntry,
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
    expect(() => parseArgs(["bogus"])).toThrow(/bogus/);
  });

  it("recognises the `mcp` subcommand", () => {
    expect(parseArgs(["mcp"])).toEqual({ mode: "mcp" });
  });

  it("rejects extra arguments after `mcp`", () => {
    expect(() => parseArgs(["mcp", "extra"])).toThrow(/extra/);
  });

  it("lets --help take precedence over `mcp`", () => {
    expect(parseArgs(["mcp", "--help"])).toEqual({ mode: "help" });
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

  it("recognises an explicit `serve` subcommand with the usual flags", () => {
    expect(parseArgs(["serve"])).toEqual({
      mode: "serve",
      host: "127.0.0.1",
      port: 3737,
      open: false,
    });
    expect(parseArgs(["serve", "--port", "8080"]).port).toBe(8080);
  });

  it("recognises `backup` without a path", () => {
    expect(parseArgs(["backup"])).toEqual({ mode: "backup", path: undefined });
  });

  it("recognises `backup` with a target path", () => {
    expect(parseArgs(["backup", "/tmp/snap.db"])).toEqual({ mode: "backup", path: "/tmp/snap.db" });
  });

  it("rejects extra arguments after `backup <path>`", () => {
    expect(() => parseArgs(["backup", "a", "b"])).toThrow(/b/);
  });

  it("recognises `restore` with a backup path", () => {
    expect(parseArgs(["restore", "/tmp/snap.db"])).toEqual({
      mode: "restore",
      path: "/tmp/snap.db",
    });
  });

  it("rejects `restore` without a backup path", () => {
    expect(() => parseArgs(["restore"])).toThrow(/path/i);
  });

  it("recognises `doctor` and rejects extra arguments", () => {
    expect(parseArgs(["doctor"])).toEqual({ mode: "doctor" });
    expect(() => parseArgs(["doctor", "now"])).toThrow(/now/);
  });

  it("recognises `service install` and `service uninstall`", () => {
    expect(parseArgs(["service", "install"])).toEqual({ mode: "service", action: "install" });
    expect(parseArgs(["service", "uninstall"])).toEqual({ mode: "service", action: "uninstall" });
  });

  it("rejects `service` without or with an unknown action", () => {
    expect(() => parseArgs(["service"])).toThrow(/install|uninstall/);
    expect(() => parseArgs(["service", "bogus"])).toThrow(/bogus/);
    expect(() => parseArgs(["service", "install", "extra"])).toThrow(/extra/);
  });

  it("recognises `start` with default and explicit host/port", () => {
    expect(parseArgs(["start"])).toEqual({ mode: "start", host: "127.0.0.1", port: 3737 });
    expect(parseArgs(["start", "--port", "8080"])).toEqual({
      mode: "start",
      host: "127.0.0.1",
      port: 8080,
    });
    expect(parseArgs(["start", "--host", "127.0.0.2", "--port=9000"])).toEqual({
      mode: "start",
      host: "127.0.0.2",
      port: 9000,
    });
  });

  it("rejects unknown options and stray arguments for `start`", () => {
    expect(() => parseArgs(["start", "--open"])).toThrow(/open/);
    expect(() => parseArgs(["start", "extra"])).toThrow(/extra/);
    expect(() => parseArgs(["start", "--port", "bad"])).toThrow(/invalid port/i);
  });

  it("recognises `restart` like `start`", () => {
    expect(parseArgs(["restart"])).toEqual({ mode: "restart", host: "127.0.0.1", port: 3737 });
    expect(parseArgs(["restart", "--port", "8080"])).toEqual({
      mode: "restart",
      host: "127.0.0.1",
      port: 8080,
    });
  });

  it("recognises `stop` and `status` and rejects extra arguments", () => {
    expect(parseArgs(["stop"])).toEqual({ mode: "stop" });
    expect(parseArgs(["status"])).toEqual({ mode: "status" });
    expect(() => parseArgs(["stop", "now"])).toThrow(/now/);
    expect(() => parseArgs(["status", "now"])).toThrow(/now/);
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

  it("fully encodes the scoped package name in the registry URL", async () => {
    let requested = "";
    const fetchImpl = ((url: string) => {
      requested = url;
      return Promise.resolve({ ok: true, json: async () => ({ version: "0.1.2" }) });
    }) as unknown as typeof fetch;
    await resolveLatestVersion("@nilsr0711/drydock", { fetchImpl });
    expect(requested).toBe("https://registry.npmjs.org/%40nilsr0711%2Fdrydock/latest");
    expect(requested).not.toContain("@nilsr0711/drydock");
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

describe("resolveMcpEntry", () => {
  it("points at the bundled MCP server beside the standalone runtime", () => {
    expect(resolveMcpEntry("/opt/drydock")).toBe(
      join("/opt/drydock", ".next", "standalone", "mcp-server.cjs"),
    );
  });
});

describe("isLoopbackHost", () => {
  it("recognises 127.0.0.1 as loopback", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
  });

  it("recognises ::1 as loopback", () => {
    expect(isLoopbackHost("::1")).toBe(true);
  });

  it("recognises localhost as loopback", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
  });

  it("recognises 0.0.0.0 as non-loopback", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });

  it("recognises a LAN address as non-loopback", () => {
    expect(isLoopbackHost("192.168.1.100")).toBe(false);
  });

  it("recognises an externally routable IPv6 address as non-loopback", () => {
    expect(isLoopbackHost("::")).toBe(false);
  });
});

describe("assertSafeHost", () => {
  it("allows 127.0.0.1 without DRYDOCK_ALLOW_REMOTE", () => {
    expect(() => assertSafeHost("127.0.0.1", {})).not.toThrow();
  });

  it("allows ::1 without DRYDOCK_ALLOW_REMOTE", () => {
    expect(() => assertSafeHost("::1", {})).not.toThrow();
  });

  it("allows localhost without DRYDOCK_ALLOW_REMOTE", () => {
    expect(() => assertSafeHost("localhost", {})).not.toThrow();
  });

  it("refuses 0.0.0.0 without DRYDOCK_ALLOW_REMOTE and names the host in the error", () => {
    expect(() => assertSafeHost("0.0.0.0", {})).toThrow(/0\.0\.0\.0/);
  });

  it("refuses 0.0.0.0 and mentions DRYDOCK_ALLOW_REMOTE in the error", () => {
    expect(() => assertSafeHost("0.0.0.0", {})).toThrow(/DRYDOCK_ALLOW_REMOTE/);
  });

  it("refuses a LAN address without opt-in and names the host", () => {
    expect(() => assertSafeHost("192.168.1.1", {})).toThrow(/192\.168\.1\.1/);
  });

  it("allows 0.0.0.0 when DRYDOCK_ALLOW_REMOTE=1", () => {
    expect(() => assertSafeHost("0.0.0.0", { DRYDOCK_ALLOW_REMOTE: "1" })).not.toThrow();
  });

  it("allows a LAN address when DRYDOCK_ALLOW_REMOTE=1", () => {
    expect(() => assertSafeHost("192.168.1.1", { DRYDOCK_ALLOW_REMOTE: "1" })).not.toThrow();
  });

  it("still refuses when DRYDOCK_ALLOW_REMOTE is set to an empty string", () => {
    expect(() => assertSafeHost("0.0.0.0", { DRYDOCK_ALLOW_REMOTE: "" })).toThrow(
      /DRYDOCK_ALLOW_REMOTE/,
    );
  });
});
