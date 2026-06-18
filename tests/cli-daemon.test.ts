import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeStatus,
  formatUptime,
  readDaemonState,
  resolveDaemonLogPath,
  resolveDaemonStatePath,
  runStartCommand,
  runStatusCommand,
  runStopCommand,
  writeDaemonState,
} from "../bin/daemon.mjs";

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

/** First element with a non-undefined type, so `noUncheckedIndexedAccess` is happy. */
function first<T>(arr: T[]): T {
  const value = arr[0];
  if (value === undefined) throw new Error("expected at least one element");
  return value;
}

/** A fake detached child: records unref() and exposes a pid. */
function fakeChild(pid: number) {
  let unrefed = false;
  return {
    pid,
    unref() {
      unrefed = true;
    },
    on() {},
    wasUnrefed: () => unrefed,
  };
}

let dir: string;
let statePath: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drydock-daemon-"));
  statePath = join(dir, "daemon.json");
  logPath = join(dir, "drydock.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveDaemonStatePath / resolveDaemonLogPath", () => {
  it("default to files under ~/.drydock", () => {
    expect(resolveDaemonStatePath({ env: {}, home: "/home/jane" })).toBe(
      "/home/jane/.drydock/daemon.json",
    );
    expect(resolveDaemonLogPath({ env: {}, home: "/home/jane" })).toBe(
      "/home/jane/.drydock/drydock.log",
    );
  });

  it("honour DRYDOCK_DATA_DIR", () => {
    expect(resolveDaemonStatePath({ env: { DRYDOCK_DATA_DIR: "/data" }, home: "/home/jane" })).toBe(
      "/data/daemon.json",
    );
    expect(resolveDaemonLogPath({ env: { DRYDOCK_DATA_DIR: "/data" }, home: "/home/jane" })).toBe(
      "/data/drydock.log",
    );
  });
});

describe("writeDaemonState / readDaemonState", () => {
  it("round-trips a state record and writes it 0600", () => {
    const state = {
      pid: 4242,
      host: "127.0.0.1",
      port: 3737,
      token: "abc",
      startedAt: 1000,
      logFile: logPath,
    };
    writeDaemonState(statePath, state);
    expect(readDaemonState(statePath)).toEqual(state);
    if (process.platform !== "win32") {
      expect(statSync(statePath).mode & 0o777).toBe(0o600);
    }
  });

  it("returns null for a missing file", () => {
    expect(readDaemonState(join(dir, "nope.json"))).toBeNull();
  });

  it("returns null for corrupt JSON or a missing pid", () => {
    writeFileSync(statePath, "{ not json");
    expect(readDaemonState(statePath)).toBeNull();
    writeFileSync(statePath, JSON.stringify({ host: "127.0.0.1" }));
    expect(readDaemonState(statePath)).toBeNull();
    writeFileSync(statePath, JSON.stringify({ pid: -1, host: "127.0.0.1", port: 1 }));
    expect(readDaemonState(statePath)).toBeNull();
  });
});

describe("formatUptime", () => {
  it("formats sub-minute, minute, and hour durations", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(5_000)).toBe("5s");
    expect(formatUptime(65_000)).toBe("1m 5s");
    expect(formatUptime(3_661_000)).toBe("1h 1m 1s");
  });
});

describe("describeStatus", () => {
  const state = {
    pid: 99,
    host: "127.0.0.1",
    port: 3737,
    token: "t",
    startedAt: 1000,
    logFile: "/x.log",
  };

  it("reports not running when there is no state", () => {
    expect(describeStatus(null, { pidAlive: () => true, now: () => 2000 })).toEqual({
      running: false,
    });
  });

  it("reports stale when the recorded pid is dead", () => {
    const status = describeStatus(state, { pidAlive: () => false, now: () => 2000 });
    expect(status.running).toBe(false);
    expect(status.stale).toBe(true);
    expect(status.pid).toBe(99);
  });

  it("reports running with url and uptime when the pid is alive", () => {
    const status = describeStatus(state, { pidAlive: () => true, now: () => 4000 });
    expect(status).toEqual({
      running: true,
      pid: 99,
      host: "127.0.0.1",
      port: 3737,
      url: "http://127.0.0.1:3737",
      startedAt: 1000,
      uptimeMs: 3000,
    });
  });
});

/** Build start deps with a fake spawn, in-memory liveness, and captured IO. */
function startDeps(io: ReturnType<typeof captureIo>, overrides: Record<string, unknown> = {}) {
  const spawned: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  const child = fakeChild(5555);
  return {
    spawned,
    child,
    deps: {
      statePath,
      logPath,
      lockPath: join(dir, "instance.lock"),
      dataDir: dir,
      packageRoot: dir,
      now: () => 1000,
      generateToken: () => "fixed-token",
      pidAlive: () => false,
      readLock: () => ({ state: "free" }),
      openAppendFd: () => 7,
      closeFd: () => {},
      spawnImpl: (command: string, args: string[], options: Record<string, unknown>) => {
        spawned.push({ command, args, options });
        return child;
      },
      log: io.log,
      error: io.error,
      ...overrides,
    },
  };
}

describe("runStartCommand", () => {
  it("spawns a detached server, writes state, and returns 0", () => {
    const io = captureIo();
    const { deps, spawned, child } = startDeps(io);
    const code = runStartCommand({ host: "127.0.0.1", port: 3737 }, deps);

    expect(code).toBe(0);
    expect(spawned).toHaveLength(1);
    const call = first(spawned);
    expect(call.options.detached).toBe(true);
    expect(call.options.windowsHide).toBe(true);
    expect((call.options.env as Record<string, string>).DRYDOCK_CONTROL_TOKEN).toBe("fixed-token");
    expect(call.options.stdio).toEqual(["ignore", 7, 7]);
    expect(child.wasUnrefed()).toBe(true);

    const state = readDaemonState(statePath);
    expect(state).toMatchObject({
      pid: 5555,
      host: "127.0.0.1",
      port: 3737,
      token: "fixed-token",
      startedAt: 1000,
    });
  });

  it("refuses to start when a daemon is already running", () => {
    const io = captureIo();
    writeDaemonState(statePath, {
      pid: 1234,
      host: "127.0.0.1",
      port: 3737,
      token: "t",
      startedAt: 1,
      logFile: logPath,
    });
    const { deps, spawned } = startDeps(io, { pidAlive: (pid: number) => pid === 1234 });
    const code = runStartCommand({ host: "127.0.0.1", port: 3737 }, deps);

    expect(code).toBe(1);
    expect(spawned).toHaveLength(0);
    expect(io.err.join("\n")).toMatch(/already running/i);
  });

  it("refuses to start when a foreground instance holds the lock", () => {
    const io = captureIo();
    const { deps, spawned } = startDeps(io, {
      readLock: () => ({ state: "held", pid: 4321 }),
    });
    const code = runStartCommand({ host: "127.0.0.1", port: 3737 }, deps);

    expect(code).toBe(1);
    expect(spawned).toHaveLength(0);
    expect(io.err.join("\n")).toMatch(/already running/i);
  });

  it("takes over a stale state file left by a crash", () => {
    const io = captureIo();
    writeDaemonState(statePath, {
      pid: 1234,
      host: "127.0.0.1",
      port: 3737,
      token: "old",
      startedAt: 1,
      logFile: logPath,
    });
    // pid 1234 is dead; the new child is 5555.
    const { deps, spawned } = startDeps(io, { pidAlive: (pid: number) => pid === 5555 });
    const code = runStartCommand({ host: "127.0.0.1", port: 3737 }, deps);

    expect(code).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(readDaemonState(statePath)).toMatchObject({ pid: 5555, token: "fixed-token" });
  });
});

/** A pidAlive that reports alive for the first `aliveTimes` polls, then dead. */
function dyingAfter(aliveTimes: number) {
  let calls = 0;
  return () => {
    calls += 1;
    return calls <= aliveTimes;
  };
}

function stopDeps(io: ReturnType<typeof captureIo>, overrides: Record<string, unknown> = {}) {
  const kills: { pid: number; signal?: string }[] = [];
  const fetches: { url: string; headers: Record<string, string> }[] = [];
  return {
    kills,
    fetches,
    deps: {
      statePath,
      now: () => 0,
      platform: "linux",
      timeoutMs: 1000,
      pollMs: 1,
      sleep: async () => {},
      pidAlive: () => true,
      killImpl: (pid: number, signal?: string) => {
        kills.push({ pid, signal });
      },
      fetchImpl: async (url: string, init: { headers: Record<string, string> }) => {
        fetches.push({ url, headers: init.headers });
        return { ok: true, status: 202 };
      },
      log: io.log,
      error: io.error,
      ...overrides,
    },
  };
}

function writeRunningState(pid = 5555) {
  writeDaemonState(statePath, {
    pid,
    host: "127.0.0.1",
    port: 3737,
    token: "tok",
    startedAt: 0,
    logFile: logPath,
  });
}

describe("runStopCommand", () => {
  it("reports not running when there is no state", async () => {
    const io = captureIo();
    const { deps } = stopDeps(io);
    expect(await runStopCommand({}, deps)).toBe(0);
    expect(io.out.join("\n")).toMatch(/not running/i);
  });

  it("clears a stale state file and reports not running", async () => {
    const io = captureIo();
    writeRunningState();
    const { deps } = stopDeps(io, { pidAlive: () => false });
    expect(await runStopCommand({}, deps)).toBe(0);
    expect(readDaemonState(statePath)).toBeNull();
  });

  it("stops gracefully via the HTTP control endpoint", async () => {
    const io = captureIo();
    writeRunningState();
    const { deps, kills, fetches } = stopDeps(io, { pidAlive: dyingAfter(1) });
    expect(await runStopCommand({}, deps)).toBe(0);

    expect(fetches).toHaveLength(1);
    const sent = first(fetches);
    expect(sent.url).toBe("http://127.0.0.1:3737/api/control/shutdown");
    expect(sent.headers["x-drydock-control-token"]).toBe("tok");
    expect(kills).toHaveLength(0); // graceful path never signals
    expect(readDaemonState(statePath)).toBeNull();
    expect(io.out.join("\n")).toMatch(/stopped/i);
  });

  it("falls back to SIGTERM when the control endpoint is unreachable", async () => {
    const io = captureIo();
    writeRunningState();
    const { deps, kills } = stopDeps(io, {
      pidAlive: dyingAfter(1),
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(await runStopCommand({}, deps)).toBe(0);
    expect(kills).toEqual([{ pid: 5555, signal: "SIGTERM" }]);
    expect(readDaemonState(statePath)).toBeNull();
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const io = captureIo();
    writeRunningState();
    // The process ignores SIGTERM and only dies once SIGKILL lands.
    let killedHard = false;
    const kills: { pid: number; signal?: string }[] = [];
    const { deps } = stopDeps(io, {
      timeoutMs: 3,
      pidAlive: () => !killedHard,
      fetchImpl: async () => ({ ok: false, status: 500 }),
      killImpl: (pid: number, signal?: string) => {
        kills.push({ pid, signal });
        if (signal === "SIGKILL") killedHard = true;
      },
    });
    expect(await runStopCommand({}, deps)).toBe(0);
    expect(kills.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("returns 1 when the process never dies", async () => {
    const io = captureIo();
    writeRunningState();
    const { deps } = stopDeps(io, {
      timeoutMs: 3,
      pidAlive: () => true,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(await runStopCommand({}, deps)).toBe(1);
    expect(io.err.join("\n")).toMatch(/failed to stop/i);
  });

  it("hard-kills without a POSIX signal on Windows when the endpoint fails", async () => {
    const io = captureIo();
    writeRunningState();
    const { deps, kills } = stopDeps(io, {
      platform: "win32",
      pidAlive: dyingAfter(1),
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(await runStopCommand({}, deps)).toBe(0);
    expect(kills).toEqual([{ pid: 5555, signal: undefined }]);
  });
});

describe("runStatusCommand", () => {
  it("returns 0 and prints a running report", () => {
    const io = captureIo();
    writeRunningState();
    const code = runStatusCommand(
      {},
      { statePath, pidAlive: () => true, now: () => 5000, log: io.log, error: io.error },
    );
    expect(code).toBe(0);
    expect(io.out.join("\n")).toMatch(/running/i);
    expect(io.out.join("\n")).toMatch(/3737/);
  });

  it("returns 3 when not running", () => {
    const io = captureIo();
    const code = runStatusCommand(
      {},
      { statePath, pidAlive: () => true, now: () => 5000, log: io.log, error: io.error },
    );
    expect(code).toBe(3);
    expect(io.out.join("\n")).toMatch(/not running/i);
  });

  it("returns 3 and notes a stale state file", () => {
    const io = captureIo();
    writeRunningState();
    const code = runStatusCommand(
      {},
      { statePath, pidAlive: () => false, now: () => 5000, log: io.log, error: io.error },
    );
    expect(code).toBe(3);
    expect(io.out.join("\n")).toMatch(/stale/i);
  });
});
