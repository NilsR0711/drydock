import { afterEach, describe, expect, it, vi } from "vitest";

describe("createDb", () => {
  it("closes the sqlite handle when migration fails to prevent a handle leak", async () => {
    // Spy on better-sqlite3 to capture the created instance and verify close() is called.
    vi.resetModules();
    let closeWasCalled = false;
    vi.doMock("better-sqlite3", () => ({
      default: class FakeDatabase {
        pragma() {}
        exec() {
          throw new Error("simulated migration SQL error");
        }
        close() {
          closeWasCalled = true;
        }
      },
    }));

    const { createDb } = await import("@/lib/db/client");
    expect(() => createDb(":memory:")).toThrow("simulated migration SQL error");
    expect(closeWasCalled).toBe(true);

    vi.doUnmock("better-sqlite3");
    vi.resetModules();
  });
});

describe("getDb", () => {
  afterEach(() => {
    delete process.env.DRYDOCK_DB;
    vi.resetModules();
    vi.doUnmock("better-sqlite3");
  });

  it("latches migration errors so subsequent calls fail fast without re-opening the DB", async () => {
    vi.resetModules();
    let constructCount = 0;
    vi.doMock("better-sqlite3", () => ({
      default: class FakeDatabase {
        constructor() {
          constructCount++;
          throw new Error("DB open failure");
        }
      },
    }));

    process.env.DRYDOCK_DB = ":memory:"; // skip real FS path
    const { getDb } = await import("@/lib/db/client");

    let err1: Error | undefined;
    let err2: Error | undefined;
    try {
      getDb();
    } catch (e) {
      err1 = e as Error;
    }
    try {
      getDb();
    } catch (e) {
      err2 = e as Error;
    }

    expect(err1).toBeInstanceOf(Error);
    // Same latched error object on repeat calls — no second DB open attempted.
    expect(err2).toBe(err1);
    expect(constructCount).toBe(1);
  });
});
