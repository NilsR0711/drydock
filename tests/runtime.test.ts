import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireInstanceLock,
  isDraining,
  LOCK_TTL_MS,
  readInstanceLock,
  refreshInstanceLock,
  registerActiveJob,
  releaseInstanceLock,
  setDrainMode,
  startInstanceLockHeartbeat,
  unregisterActiveJob,
  waitForIdle,
} from "@/lib/orchestrator/runtime";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-"));
  process.env.DRYDOCK_HOME = home;
  setDrainMode(false);
});
afterEach(() => {
  // Reset the process-global runtime singleton so lock ownership never leaks
  // into a later case. releaseInstanceLock stops the heartbeat and clears
  // state.holdsLock in place — deleting RUNTIME_STATE_KEY would not help here,
  // since this suite imports runtime once and its `state` binding already points
  // at the original object (unlike the resetModules-based *-global suites).
  releaseInstanceLock();
  setDrainMode(false);
  delete process.env.DRYDOCK_HOME;
  rmSync(home, { recursive: true, force: true });
});

const lockFile = () => join(home, "instance.lock");
const writeLockFile = (record: Record<string, unknown>) =>
  writeFileSync(lockFile(), JSON.stringify(record));
const readLockFile = () => JSON.parse(readFileSync(lockFile(), "utf8"));

describe("drain mode", () => {
  it("toggles", () => {
    expect(isDraining()).toBe(false);
    setDrainMode(true);
    expect(isDraining()).toBe(true);
  });

  it("waitForIdle resolves once active jobs drain", async () => {
    registerActiveJob(1);
    let resolved = false;
    const p = waitForIdle(1000, 5).then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    unregisterActiveJob(1);
    await p;
    expect(resolved).toBe(true);
  });
});

describe("instance lock", () => {
  it("acquires when no lock exists", () => {
    expect(acquireInstanceLock()).toBe(true);
    const content = readFileSync(join(home, "instance.lock"), "utf8");
    expect(content).toContain(String(process.pid));
  });

  it("records a heartbeat timestamp when it acquires", () => {
    const before = Date.now();
    expect(acquireInstanceLock()).toBe(true);
    expect(readLockFile().ts).toBeGreaterThanOrEqual(before);
  });

  it("acquires when the existing lock is stale (dead pid)", () => {
    writeLockFile({ pid: 999999999, ts: 1 });
    expect(acquireInstanceLock()).toBe(true);
  });

  it("refuses when a live foreign pid holds a fresh lock", () => {
    // The vitest parent process is alive for the duration of the test.
    writeLockFile({ pid: process.ppid, ts: Date.now() });
    expect(acquireInstanceLock()).toBe(false);
  });

  it("reclaims a lock whose heartbeat expired even though the pid is alive (pid reuse)", () => {
    // After a host crash a fresh process can inherit the dead holder's pid, so
    // pidAlive() alone would wedge the lock forever (issue #211). An expired
    // heartbeat is the tell that this live pid is not the real Drydock holder.
    writeLockFile({ pid: process.ppid, ts: Date.now() - LOCK_TTL_MS - 1000 });
    expect(acquireInstanceLock()).toBe(true);
    expect(readLockFile().pid).toBe(process.pid);
  });

  it("takes over its own pid's stale lock (container restart / expired heartbeat)", () => {
    // A crashed instance can be restarted with the same pid (pid 1 in a
    // container); its lock still carries our pid but its heartbeat has lapsed,
    // so this fresh incarnation reclaims it rather than refusing forever.
    writeLockFile({ pid: process.pid, ts: Date.now() - LOCK_TTL_MS - 1000 });
    expect(acquireInstanceLock()).toBe(true);
    expect(readLockFile().pid).toBe(process.pid);
  });

  it("a redundant in-process init backs off instead of stealing its own fresh lock", () => {
    // The `started` guard already stops a second bundle layer from re-running
    // startOrchestrator, but the lock is hardened too (issue #379): once THIS
    // live process holds a fresh lock, a redundant acquire must not unlink and
    // re-claim it — that would re-run crash recovery (requeueExpiredLeases) and
    // steal the lock from itself. It backs off, leaving the lock untouched.
    expect(acquireInstanceLock()).toBe(true);
    const held = readLockFile();
    expect(acquireInstanceLock()).toBe(false);
    expect(readLockFile()).toEqual(held);
  });

  it("treats a live foreign holder with no heartbeat as stale", () => {
    writeLockFile({ pid: process.ppid });
    expect(acquireInstanceLock()).toBe(true);
  });

  it("takes over a corrupt lock file and rewrites it with our pid", () => {
    writeFileSync(join(home, "instance.lock"), "not json at all");
    expect(acquireInstanceLock()).toBe(true);
    const content = readFileSync(join(home, "instance.lock"), "utf8");
    expect(content).toContain(String(process.pid));
  });

  it("writes our pid after taking over a stale lock", () => {
    writeLockFile({ pid: 999999999, ts: 1 });
    expect(acquireInstanceLock()).toBe(true);
    expect(readLockFile().pid).toBe(process.pid);
  });
});

describe("instance lock heartbeat", () => {
  it("refreshInstanceLock advances the heartbeat while we still hold it", () => {
    expect(acquireInstanceLock()).toBe(true);
    writeLockFile({ pid: process.pid, ts: 1 });
    const before = Date.now();
    expect(refreshInstanceLock()).toBe(true);
    expect(readLockFile().ts).toBeGreaterThanOrEqual(before);
  });

  it("refreshInstanceLock does not touch a lock owned by another pid", () => {
    writeLockFile({ pid: process.ppid, ts: 1 });
    expect(refreshInstanceLock()).toBe(false);
    expect(readLockFile()).toEqual({ pid: process.ppid, ts: 1 });
  });

  it("refreshInstanceLock returns false when the lock file is gone", () => {
    expect(refreshInstanceLock()).toBe(false);
  });

  it("refreshInstanceLock leaves no temp file behind on the failure path", () => {
    writeLockFile({ pid: process.ppid, ts: 1 });
    expect(refreshInstanceLock()).toBe(false);
    expect(existsSync(`${lockFile()}.${process.pid}.tmp`)).toBe(false);
  });

  it("startInstanceLockHeartbeat keeps the heartbeat fresh", async () => {
    expect(acquireInstanceLock()).toBe(true);
    writeLockFile({ pid: process.pid, ts: 1 });
    startInstanceLockHeartbeat(5);
    await new Promise((r) => setTimeout(r, 30));
    expect(readLockFile().ts).toBeGreaterThan(1);
  });

  it("startInstanceLockHeartbeat stops once the lock is lost", async () => {
    expect(acquireInstanceLock()).toBe(true);
    startInstanceLockHeartbeat(5);
    // Another process steals the lock; our heartbeat must give up, not clobber it.
    writeLockFile({ pid: process.ppid, ts: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(readLockFile()).toEqual({ pid: process.ppid, ts: 1 });
  });
});

describe("releaseInstanceLock", () => {
  it("removes the lock file we own", () => {
    expect(acquireInstanceLock()).toBe(true);
    releaseInstanceLock();
    expect(existsSync(lockFile())).toBe(false);
  });

  it("leaves a lock owned by another pid untouched", () => {
    writeLockFile({ pid: process.ppid, ts: Date.now() });
    releaseInstanceLock();
    expect(existsSync(lockFile())).toBe(true);
  });

  it("is a no-op when no lock file exists", () => {
    expect(() => releaseInstanceLock()).not.toThrow();
  });
});

describe("readInstanceLock", () => {
  it("reports no holder when no lock file exists", () => {
    expect(readInstanceLock()).toEqual({ held: false, pid: null, self: false });
  });

  it("reports self when this process holds the lock", () => {
    expect(acquireInstanceLock()).toBe(true);
    expect(readInstanceLock()).toEqual({ held: true, pid: process.pid, self: true });
  });

  it("reports a live foreign holder as held but not self", () => {
    // The vitest parent process is alive for the duration of the test.
    writeFileSync(
      join(home, "instance.lock"),
      JSON.stringify({ pid: process.ppid, ts: Date.now() }),
    );
    expect(readInstanceLock()).toEqual({ held: true, pid: process.ppid, self: false });
  });

  it("treats a dead pid as not held", () => {
    writeFileSync(join(home, "instance.lock"), JSON.stringify({ pid: 999999999, ts: 1 }));
    expect(readInstanceLock()).toEqual({ held: false, pid: 999999999, self: false });
  });

  it("reports a live foreign holder with an expired heartbeat as not held", () => {
    // pid reuse: the live pid is no longer the real Drydock holder (issue #211).
    writeFileSync(
      join(home, "instance.lock"),
      JSON.stringify({ pid: process.ppid, ts: Date.now() - LOCK_TTL_MS - 1000 }),
    );
    expect(readInstanceLock()).toEqual({ held: false, pid: process.ppid, self: false });
  });

  it("treats a holder with no heartbeat as not held", () => {
    writeFileSync(join(home, "instance.lock"), JSON.stringify({ pid: process.ppid }));
    expect(readInstanceLock()).toEqual({ held: false, pid: process.ppid, self: false });
  });

  it("treats a corrupt lock file as not held", () => {
    writeFileSync(join(home, "instance.lock"), "not json at all");
    expect(readInstanceLock()).toEqual({ held: false, pid: null, self: false });
  });

  it("treats a non-numeric pid as not held", () => {
    writeFileSync(join(home, "instance.lock"), JSON.stringify({ pid: "nope", ts: 1 }));
    expect(readInstanceLock()).toEqual({ held: false, pid: null, self: false });
  });

  it("treats a non-positive or fractional pid as malformed, never probing it", () => {
    // pid 0 would signal our own process group in process.kill(pid, 0) and
    // misreport a corrupt lock file as held; negative pids address groups too.
    for (const pid of [0, -1, 3.14]) {
      writeFileSync(join(home, "instance.lock"), JSON.stringify({ pid, ts: 1 }));
      expect(readInstanceLock()).toEqual({ held: false, pid: null, self: false });
    }
  });

  it("never modifies the lock file, even a stale or corrupt one", () => {
    const path = join(home, "instance.lock");
    writeFileSync(path, JSON.stringify({ pid: 999999999, ts: 1 }));
    readInstanceLock();
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ pid: 999999999, ts: 1 }));
  });
});
