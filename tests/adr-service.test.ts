import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  listAdrs,
  parseAdrTitle,
  pendingCount,
  registerAdr,
  setAdrStatus,
} from "@/lib/adr/service";
import { createDb, type DB } from "@/lib/db/client";
import { addRepo } from "@/lib/repos/service";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

describe("parseAdrTitle", () => {
  it("uses the first markdown heading", () => {
    expect(parseAdrTitle("# ADR 042: Use Foo\n\nbody", "x.md")).toBe("ADR 042: Use Foo");
  });
  it("falls back to the filename", () => {
    expect(parseAdrTitle("no heading here", "docs/adr/007-thing.md")).toBe("007-thing.md");
  });
});

describe("ADR registration", () => {
  it("registers a pending ADR", () => {
    const adr = registerAdr({ filePath: "/r/docs/adr/001.md", content: "# Title" }, db);
    expect(adr.status).toBe("pending_review");
    expect(adr.title).toBe("Title");
    expect(pendingCount(db)).toBe(1);
  });

  it("registers and lists ADRs filtered by repo", () => {
    const a = addRepo({ path: "/a", name: "a" }, db).id;
    const b = addRepo({ path: "/b", name: "b" }, db).id;
    registerAdr({ repoId: a, filePath: "/a/docs/adr/1.md", content: "# A" }, db);
    registerAdr({ repoId: b, filePath: "/b/docs/adr/1.md", content: "# B" }, db);
    expect(listAdrs(undefined, db, a).map((x) => x.title)).toEqual(["A"]);
    expect(listAdrs(undefined, db, b).map((x) => x.title)).toEqual(["B"]);
    expect(listAdrs(undefined, db)).toHaveLength(2);
  });

  it("is idempotent per file path", () => {
    registerAdr({ filePath: "/r/docs/adr/001.md", content: "# A" }, db);
    registerAdr({ filePath: "/r/docs/adr/001.md", content: "# A again" }, db);
    expect(listAdrs(undefined, db)).toHaveLength(1);
  });

  it("scopes dedup to the repo: the same path in two repos registers twice", () => {
    const a = addRepo({ path: "/a", name: "a" }, db).id;
    const b = addRepo({ path: "/b", name: "b" }, db).id;
    const first = registerAdr({ repoId: a, filePath: "docs/adr/001.md", content: "# From A" }, db);
    const second = registerAdr({ repoId: b, filePath: "docs/adr/001.md", content: "# From B" }, db);
    expect(second.id).not.toBe(first.id);
    expect(second.repoId).toBe(b);
    expect(listAdrs(undefined, db, a).map((x) => x.title)).toEqual(["From A"]);
    expect(listAdrs(undefined, db, b).map((x) => x.title)).toEqual(["From B"]);
  });

  it("is idempotent per (repo, path) and keeps null-repo ADRs separate", () => {
    const a = addRepo({ path: "/a", name: "a" }, db).id;
    const scoped = registerAdr({ repoId: a, filePath: "docs/adr/002.md", content: "# S" }, db);
    expect(registerAdr({ repoId: a, filePath: "docs/adr/002.md", content: "# S2" }, db).id).toBe(
      scoped.id,
    );
    const unscoped = registerAdr({ filePath: "docs/adr/002.md", content: "# U" }, db);
    expect(unscoped.id).not.toBe(scoped.id);
    expect(unscoped.repoId).toBeNull();
    expect(registerAdr({ filePath: "docs/adr/002.md", content: "# U2" }, db).id).toBe(unscoped.id);
    expect(listAdrs(undefined, db)).toHaveLength(2);
  });

  it("approve / reject transitions", () => {
    const adr = registerAdr({ filePath: "/r/docs/adr/002.md", content: "# B" }, db);
    expect(setAdrStatus(adr.id, "approved", db).status).toBe("approved");
    expect(pendingCount(db)).toBe(0);
    const adr2 = registerAdr({ filePath: "/r/docs/adr/003.md", content: "# C" }, db);
    expect(setAdrStatus(adr2.id, "rejected", db).status).toBe("rejected");
  });
});

describe("chokidar watcher", () => {
  it("registers a new ADR file written into the watched dir", async () => {
    const { watchAdrDirs } = await import("@/lib/adr/watcher");
    const repoRoot = mkdtempSync(join(tmpdir(), "ac-adr-"));
    const adrDir = join(repoRoot, "docs/adr");
    mkdirSync(adrDir, { recursive: true });

    process.env.DRYDOCK_DB = ":memory:";
    // Force polling so the `add` event is deterministic: the native fsevents
    // backend can initialize/emit late on a loaded macOS CI runner, which made
    // this test flaky. Polling picks up the new file on a fixed interval.
    const watchers = watchAdrDirs([{ path: repoRoot }], { usePolling: true, interval: 50 });
    await new Promise<void>((resolve) => {
      watchers[0]?.on("ready", () => resolve());
    });
    // The watcher uses the default getDb() singleton (DRYDOCK_DB=:memory:).
    const { getDb } = await import("@/lib/db/client");
    writeFileSync(join(adrDir, "001-test.md"), "# ADR 001: Watched decision\n");

    // Poll until the add event has been processed instead of racing a fixed
    // sleep — chokidar's add event can fire late under load. Budget ~9s, well
    // within the 15s test timeout, so even a slow runner has room.
    const seen = async () => {
      for (let i = 0; i < 180; i++) {
        if (listAdrs(undefined, getDb()).some((r) => r.title === "ADR 001: Watched decision")) {
          return true;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };
    const found = await seen();
    await Promise.all(watchers.map((w) => w.close()));
    expect(found).toBe(true);
  }, 15000);
});
