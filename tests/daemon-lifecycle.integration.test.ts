import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearDaemonState,
  readDaemonState,
  runStartCommand,
  runStatusCommand,
  runStopCommand,
  writeDaemonState,
} from "../bin/daemon.mjs";

interface DaemonState {
  pid: number;
  host: string;
  port: number;
  token: string;
  startedAt: number;
  logFile: string;
}

/**
 * End-to-end daemon lifecycle on the real OS (issue #216): a detached child
 * actually spawns, survives the call returning, answers a graceful HTTP stop,
 * and a crash-left stale state file is recovered. Runs against a lightweight
 * stub server (tests/fixtures/daemon-stub.mjs) so the same assertions hold on
 * ubuntu/macos/windows without building the full Next app.
 */

const STUB = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "daemon-stub.mjs");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask the OS for a likely-free loopback port. There is an unavoidable window
 * between releasing it here and the daemon binding it, so callers must treat a
 * port as a *candidate* and retry on collision (see `startReachable`) rather
 * than assume exclusivity.
 */
function candidatePort(): Promise<number> {
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

/**
 * Start the daemon and wait until it is actually serving, retrying on a fresh
 * candidate port if the chosen one was taken in the allocate→bind window (the
 * stub exits non-zero on `EADDRINUSE`, so a lost race is observable, not a
 * hang). Returns the bound port and the live state. Race-free by construction:
 * a collision is detected and retried rather than flaking the assertion.
 */
async function startReachable(tries = 8): Promise<{ port: number; state: DaemonState }> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const port = await candidatePort();
    if (runStartCommand({ host: "127.0.0.1", port }, deps()) !== 0) {
      clearDaemonState(statePath);
      continue;
    }
    const state = readDaemonState(statePath) as DaemonState | null;
    if (state === null) continue;

    let reachable = false;
    for (let i = 0; i < 200; i++) {
      if (!pidAlive(state.pid)) break; // server died (lost the port race) → retry
      try {
        if ((await fetch(`http://127.0.0.1:${port}/`)).ok) {
          reachable = true;
          break;
        }
      } catch {
        // not listening yet
      }
      await sleep(25);
    }
    if (reachable) return { port, state };

    if (pidAlive(state.pid)) {
      try {
        process.kill(state.pid);
      } catch {
        // already gone
      }
    }
    clearDaemonState(statePath);
  }
  throw new Error("daemon never became reachable");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drydock-daemon-it-"));
  statePath = join(dir, "daemon.json");
  logPath = join(dir, "drydock.log");
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
    // start returned immediately while the detached child keeps running and
    // becomes reachable on its own.
    const { state } = await startReachable();
    expect(pidAlive(state.pid)).toBe(true);

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
    const { port } = await startReachable();

    // A second start sees the live daemon and refuses without spawning.
    expect(runStartCommand({ host: "127.0.0.1", port }, deps())).toBe(1);

    await runStopCommand({}, { statePath, timeoutMs: 8000, pollMs: 25 });
  });

  it("recovers a stale state file left by a crash", async () => {
    // Simulate a crash: a state file pointing at a long-dead pid.
    writeDaemonState(statePath, {
      pid: 2 ** 30, // implausibly high pid, certainly not alive
      host: "127.0.0.1",
      port: 3737,
      token: "dead",
      startedAt: 1,
      logFile: logPath,
    });

    // start takes over the stale state and brings up a fresh daemon.
    const { state } = await startReachable();
    expect(state.token).not.toBe("dead");
    expect(pidAlive(state.pid)).toBe(true);

    await runStopCommand({}, { statePath, timeoutMs: 8000, pollMs: 25 });
  });
});
