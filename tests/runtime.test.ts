import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireInstanceLock,
  isDraining,
  registerActiveJob,
  setDrainMode,
  unregisterActiveJob,
  waitForIdle,
} from "@/lib/orchestrator/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-"));
  process.env.AUTOCLAUDE_HOME = home;
  setDrainMode(false);
});
afterEach(() => {
  // biome-ignore lint/performance/noDelete: cleaning up test env
  delete process.env.AUTOCLAUDE_HOME;
});

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

  it("acquires when the existing lock is stale (dead pid)", () => {
    writeFileSync(join(home, "instance.lock"), JSON.stringify({ pid: 999999999, ts: 1 }));
    expect(acquireInstanceLock()).toBe(true);
  });

  it("refuses when a live pid holds the lock", () => {
    writeFileSync(
      join(home, "instance.lock"),
      JSON.stringify({ pid: process.pid, ts: Date.now() }),
    );
    expect(acquireInstanceLock()).toBe(false);
  });
});
