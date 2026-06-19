import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServerLogger } from "@/lib/log/server-log";
import type { LogRecord } from "@/lib/log/types";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drydock-log-"));
  file = join(dir, "logs", "drydock.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Parse the NDJSON main log file into records. */
function readFileRecords(path = file): LogRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogRecord);
}

describe("ServerLogger file sink", () => {
  it("appends a structured NDJSON record (creating the directory)", () => {
    const log = new ServerLogger({ file, echo: false });
    log.info("driver started", { repo: "acme/widgets" });

    const records = readFileRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      seq: 1,
      level: "info",
      msg: "driver started",
      fields: { repo: "acme/widgets" },
    });
    expect(typeof records[0]?.ts).toBe("number");
  });

  it("redacts secrets in the message and fields before writing", () => {
    const log = new ServerLogger({ file, echo: false });
    const token = `ghp_${"a".repeat(36)}`;
    log.error(`push failed with ${token}`, { url: `https://x:${token}@github.com/x.git` });

    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(token);
    expect(raw).toContain("[REDACTED]");
    const rec = readFileRecords()[0];
    expect(rec?.msg).not.toContain(token);
  });

  it("does not write a file when no path is configured", () => {
    const log = new ServerLogger({ file: null, echo: false });
    log.info("in-memory only");
    expect(existsSync(file)).toBe(false);
    expect(log.recent({}).map((r) => r.msg)).toEqual(["in-memory only"]);
  });
});

describe("ServerLogger level threshold", () => {
  it("drops records below the configured level (sink level)", () => {
    const log = new ServerLogger({ file, level: "warn", echo: false });
    expect(log.debug("d")).toBeNull();
    expect(log.info("i")).toBeNull();
    expect(log.warn("w")).not.toBeNull();
    expect(log.error("e")).not.toBeNull();
    expect(readFileRecords().map((r) => r.msg)).toEqual(["w", "e"]);
  });

  it("honors a runtime setLevel change", () => {
    const log = new ServerLogger({ file, level: "info", echo: false });
    log.info("kept");
    log.setLevel("error");
    expect(log.getLevel()).toBe("error");
    log.info("dropped");
    log.error("kept-too");
    expect(readFileRecords().map((r) => r.msg)).toEqual(["kept", "kept-too"]);
  });
});

describe("ServerLogger seq", () => {
  it("assigns monotonic sequence ids", () => {
    const log = new ServerLogger({ file, echo: false });
    log.info("a");
    log.info("b");
    log.info("c");
    expect(readFileRecords().map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("continues the sequence from an existing file on restart", () => {
    new ServerLogger({ file, echo: false }).info("a");
    new ServerLogger({ file, echo: false }).info("a");
    const second = new ServerLogger({ file, echo: false });
    second.info("b");
    const seqs = readFileRecords().map((r) => r.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });
});

describe("ServerLogger recent", () => {
  it("returns recent records filtered by level and query, ascending by seq", () => {
    const log = new ServerLogger({ file, level: "debug", echo: false });
    log.debug("noise");
    log.info("driver started", { repo: "acme" });
    log.warn("ci pending");
    log.error("job failed", { repo: "acme" });

    expect(log.recent({ level: "warn" }).map((r) => r.msg)).toEqual(["ci pending", "job failed"]);
    expect(log.recent({ query: "acme" }).map((r) => r.msg)).toEqual([
      "driver started",
      "job failed",
    ]);
    expect(log.recent({ limit: 2 }).map((r) => r.msg)).toEqual(["ci pending", "job failed"]);
  });
});

describe("ServerLogger rotation", () => {
  it("rotates the file past the size cap and bounds the number of files", () => {
    const log = new ServerLogger({ file, echo: false, maxBytes: 200, maxFiles: 2 });
    for (let i = 0; i < 40; i++) log.info(`record number ${i} with some padding text`);

    // Main file plus at most `maxFiles` rotated copies; nothing beyond the cap.
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(false);

    // The newest record survives and is readable via recent().
    const msgs = log.recent({ limit: 100 }).map((r) => r.msg);
    expect(msgs.at(-1)).toBe("record number 39 with some padding text");
    // Older records were dropped by rotation — retention is bounded.
    expect(msgs).not.toContain("record number 0 with some padding text");
  });
});

describe("ServerLogger subscribe", () => {
  it("fans out each redacted record to subscribers until unsubscribed", () => {
    const log = new ServerLogger({ file: null, echo: false });
    const seen: LogRecord[] = [];
    const off = log.subscribe((r) => seen.push(r));

    const token = `ghp_${"b".repeat(36)}`;
    log.info(`got ${token}`);
    off();
    log.info("after unsubscribe");

    expect(seen.map((r) => r.msg)).toEqual([expect.stringContaining("[REDACTED]")]);
    expect(seen[0]?.msg).not.toContain(token);
  });
});
