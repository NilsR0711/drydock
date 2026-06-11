import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  runServiceCommand,
  SERVICE_LABEL,
  servicePath,
} from "../bin/ops.mjs";

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (line: string) => out.push(line),
    error: (line: string) => err.push(line),
  };
}

/** Records every CLI invocation and returns a fixed result. */
function recordingRunner(exitCode = 0) {
  const calls: { cmd: string; args: string[] }[] = [];
  const runner = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return { exitCode, stdout: "", stderr: "" };
  };
  return { calls, runner };
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "drydock-service-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("buildLaunchdPlist", () => {
  it("launches `node <bin> serve` at login and restarts on crash", () => {
    const plist = buildLaunchdPlist({
      nodePath: "/usr/local/bin/node",
      binPath: "/lib/drydock/bin/drydock.mjs",
      logPath: "/home/jane/.drydock/drydock.log",
    });
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/lib/drydock/bin/drydock.mjs</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("/home/jane/.drydock/drydock.log");
  });

  it("escapes XML special characters in paths", () => {
    const plist = buildLaunchdPlist({
      nodePath: "/opt/a&b/node",
      binPath: "/lib/<dd>/bin.mjs",
      logPath: "/log.log",
    });
    expect(plist).toContain("/opt/a&amp;b/node");
    expect(plist).toContain("/lib/&lt;dd&gt;/bin.mjs");
    expect(plist).not.toContain("a&b");
  });
});

describe("buildSystemdUnit", () => {
  it("runs `node <bin> serve` with quoted paths and restarts on failure", () => {
    const unit = buildSystemdUnit({
      nodePath: "/usr/bin/node",
      binPath: "/home/jane/lib/drydock with space/bin/drydock.mjs",
    });
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/home/jane/lib/drydock with space/bin/drydock.mjs" serve',
    );
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });
});

describe("servicePath", () => {
  it("places a launchd agent plist on macOS", () => {
    expect(servicePath("darwin", "/Users/jane")).toBe(
      `/Users/jane/Library/LaunchAgents/${SERVICE_LABEL}.plist`,
    );
  });

  it("places a systemd user unit on Linux", () => {
    expect(servicePath("linux", "/home/jane")).toBe(
      "/home/jane/.config/systemd/user/drydock.service",
    );
  });

  it("returns null on unsupported platforms", () => {
    expect(servicePath("win32", "C:\\Users\\jane")).toBeNull();
  });
});

describe("runServiceCommand", () => {
  const base = {
    nodePath: "/usr/local/bin/node",
    binPath: "/lib/drydock/bin/drydock.mjs",
    dataDir: "/home/jane/.drydock",
    uid: 501,
  };

  it("installs and bootstraps a launchd agent on macOS", async () => {
    const io = captureIo();
    const { calls, runner } = recordingRunner();

    const code = await runServiceCommand("install", {
      ...base,
      platform: "darwin",
      home,
      runner,
      ...io,
    });

    expect(code).toBe(0);
    const plistPath = join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    expect(existsSync(plistPath)).toBe(true);
    expect(readFileSync(plistPath, "utf8")).toContain("<string>serve</string>");
    expect(calls).toContainEqual({
      cmd: "launchctl",
      args: ["bootstrap", "gui/501", plistPath],
    });
  });

  it("uninstalls the launchd agent and removes the plist", async () => {
    const io = captureIo();
    const { calls, runner } = recordingRunner();
    await runServiceCommand("install", { ...base, platform: "darwin", home, runner, ...io });

    const code = await runServiceCommand("uninstall", {
      ...base,
      platform: "darwin",
      home,
      runner,
      ...io,
    });

    expect(code).toBe(0);
    expect(existsSync(join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`))).toBe(false);
    expect(calls).toContainEqual({
      cmd: "launchctl",
      args: ["bootout", `gui/501/${SERVICE_LABEL}`],
    });
  });

  it("installs and enables a systemd user unit on Linux", async () => {
    const io = captureIo();
    const { calls, runner } = recordingRunner();

    const code = await runServiceCommand("install", {
      ...base,
      platform: "linux",
      home,
      runner,
      ...io,
    });

    expect(code).toBe(0);
    const unitPath = join(home, ".config", "systemd", "user", "drydock.service");
    expect(existsSync(unitPath)).toBe(true);
    expect(calls).toContainEqual({ cmd: "systemctl", args: ["--user", "daemon-reload"] });
    expect(calls).toContainEqual({
      cmd: "systemctl",
      args: ["--user", "enable", "--now", "drydock.service"],
    });
  });

  it("uninstalls the systemd unit, disabling it first", async () => {
    const io = captureIo();
    const { calls, runner } = recordingRunner();
    await runServiceCommand("install", { ...base, platform: "linux", home, runner, ...io });

    const code = await runServiceCommand("uninstall", {
      ...base,
      platform: "linux",
      home,
      runner,
      ...io,
    });

    expect(code).toBe(0);
    expect(existsSync(join(home, ".config", "systemd", "user", "drydock.service"))).toBe(false);
    expect(calls).toContainEqual({
      cmd: "systemctl",
      args: ["--user", "disable", "--now", "drydock.service"],
    });
  });

  it("fails with a clear message on unsupported platforms", async () => {
    const io = captureIo();
    const { runner } = recordingRunner();

    const code = await runServiceCommand("install", {
      ...base,
      platform: "win32",
      home,
      runner,
      ...io,
    });

    expect(code).toBe(1);
    expect(io.err.join("\n")).toMatch(/not supported/i);
  });

  it("fails when the platform service manager rejects the install", async () => {
    const io = captureIo();
    const { runner } = recordingRunner(1);

    const code = await runServiceCommand("install", {
      ...base,
      platform: "linux",
      home,
      runner,
      ...io,
    });

    expect(code).toBe(1);
  });

  it("treats uninstalling a service that was never installed as a no-op", async () => {
    const io = captureIo();
    const { runner } = recordingRunner();

    const code = await runServiceCommand("uninstall", {
      ...base,
      platform: "darwin",
      home,
      runner,
      ...io,
    });

    expect(code).toBe(0);
    expect(io.out.join("\n")).toMatch(/not installed/i);
  });
});
