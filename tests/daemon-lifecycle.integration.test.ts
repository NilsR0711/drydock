import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readDaemonState,
  runStartCommand,
  runStatusCommand,
  runStopCommand,
  writeDaemonState,
} from "../bin/daemon.mjs";

/**
 * End-to-end daemon lifecycle on the real OS (issue #216): a detached child
 * actually spawns, survives the call returning, answers a graceful HTTP stop,
 * and a crash-left stale state file is recovered. Runs against a lightweight
 * stub server (tests/fixtures/daemon-stub.mjs) so the same assertions hold on
 * ubuntu/macos/windows without building the full Next app.
 */

const STUB = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "daemon-stub.mjs");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ask the OS for an unused loopback port so parallel runs never collide. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close(() => reject(new Error("no port")));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll `fn` until it resolves truthy or the attempts run out. */
async function waitUntil(fn: () => Promise<boolean> | boolean, tries = 200, delay = 25) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await sleep(delay);
  }
  return false;
}

let dir: string;
let statePath: string;
let logPath: string;
let port: number;

/** Real deps wired to the stub server instead of the Next standalone build. */
function deps() {
  return {
    statePath,
    logPath,
    lockPath: join(dir, "instance.lock"),
    dataDir: dir,
    packageRoot: dir,
    buildServerCommand: ({ host, port: p }: { host: string; port: number }) => ({
      command: process.execPath,
      args: [STUB, "--host", host, "--port", String(p)],
    }),
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "drydock-daemon-it-"));
  statePath = join(dir, "daemon.json");
  logPath = join(dir, "drydock.log");
  port = await freePort();
});

afterEach(async () => {
  // Best-effort teardown: kill any survivor the test didn't stop itself.
  const state = readDaemonState(statePath);
  if (state && pidAlive(state.pid)) {
    try {
      process.kill(state.pid);
    } catch {
      // already gone
    }
    await waitUntil(() => !pidAlive(state.pid), 80, 25);
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("daemon lifecycle (integration)", () => {
  it("starts detached, reports running, then stops gracefully", async () => {
    const startCode = runStartCommand({ host: "127.0.0.1", port }, deps());
    expect(startCode).toBe(0);

    // start returned immediately while the child keeps running: the state file
    // names a live pid and the server becomes reachable on its own.
    const state = readDaemonState(statePath);
    expect(state).not.toBeNull();
    if (state === null) throw new Error("unreachable");
    expect(pidAlive(state.pid)).toBe(true);

    const reachable = await waitUntil(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        return res.ok;
      } catch {
        return false;
      }
    });
    expect(reachable).toBe(true);

    // status: running, exit 0.
    expect(runStatusCommand({}, { statePath })).toBe(0);

    // stop: graceful drain via the HTTP control endpoint, no signal needed.
    const stopCode = await runStopCommand({}, { statePath, timeoutMs: 8000, pollMs: 25 });
    expect(stopCode).toBe(0);
    expect(pidAlive(state.pid)).toBe(false);
    expect(readDaemonState(statePath)).toBeNull();

    // status: stopped, exit 3.
    expect(runStatusCommand({}, { statePath })).toBe(3);
  });

  it("refuses to start a second daemon while one is running", async () => {
    expect(runStartCommand({ host: "127.0.0.1", port }, deps())).toBe(0);
    const state = readDaemonState(statePath);
    if (state === null) throw new Error("expected state");
    expect(await waitUntil(() => pidAlive(state.pid))).toBe(true);

    expect(runStartCommand({ host: "127.0.0.1", port }, deps())).toBe(1);

    await runStopCommand({}, { statePath, timeoutMs: 8000, pollMs: 25 });
  });

  it("recovers a stale state file left by a crash", async () => {
    // Simulate a crash: a state file pointing at a long-dead pid.
    writeDaemonState(statePath, {
      pid: 2 ** 30, // implausibly high pid, certainly not alive
      host: "127.0.0.1",
      port,
      token: "dead",
      startedAt: 1,
      logFile: logPath,
    });

    const startCode = runStartCommand({ host: "127.0.0.1", port }, deps());
    expect(startCode).toBe(0);

    const state = readDaemonState(statePath);
    if (state === null) throw new Error("expected state");
    expect(state.token).not.toBe("dead");
    expect(await waitUntil(() => pidAlive(state.pid))).toBe(true);

    await runStopCommand({}, { statePath, timeoutMs: 8000, pollMs: 25 });
  });
});
