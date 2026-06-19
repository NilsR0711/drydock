/**
 * Structured server-log sink (issue #294, ADR 035). Server-level diagnostics —
 * the driver loop, forge sync, orchestrator lifecycle, anything that today only
 * reaches `console` — are routed here so they land in a single, searchable place
 * that complements the per-job SSE stream.
 *
 * Each record is written three ways: appended as one redacted NDJSON line to a
 * rotating log file (durable, tail-able, survives restart), echoed to the
 * process console (so the daemon's captured stdout/stderr still shows it), and
 * fanned out in-process to live subscribers (the global Logs page's SSE tail).
 *
 * Secrets are scrubbed with {@link redactSecrets} before anything is written or
 * emitted — the same boundary the per-job broker uses (issues #24, #110) — so a
 * token echoed in an error never lands on disk or on a connected client.
 *
 * The registry lives on `globalThis` (see {@link getServerLogger}) for the same
 * reason as the dashboard bus and abort registry (issue #232): Next.js compiles
 * Server Actions, Route Handlers, and instrumentation into separate bundle
 * layers, and a module-local singleton would give each its own logger — so a
 * record emitted in one layer would never reach an SSE subscriber in another.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { redactSecrets } from "./redact";
import {
  isLogLevel,
  type LogFilter,
  type LogLevel,
  type LogRecord,
  levelRank,
  matchesLogFilter,
} from "./types";

const DEFAULT_LEVEL: LogLevel = "info";
const DEFAULT_MAX_BYTES = 5_000_000;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_BUFFER_SIZE = 1000;
const DEFAULT_RECENT_LIMIT = 200;

export interface ServerLoggerOptions {
  /** Absolute log-file path, or null to disable the file sink (in-memory only). */
  file?: string | null;
  level?: LogLevel;
  /** Rotate once the active file would exceed this many bytes. */
  maxBytes?: number;
  /** How many rotated copies to keep (`<file>.1` … `<file>.<maxFiles>`). */
  maxFiles?: number;
  /** In-memory ring-buffer capacity (fallback when the file is unavailable). */
  bufferSize?: number;
  /** Echo every record to the process console. Default true. */
  echo?: boolean;
}

type Listener = (record: LogRecord) => void;

export class ServerLogger {
  private level: LogLevel;
  private readonly file: string | null;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly bufferSize: number;
  private readonly echo: boolean;
  private readonly buffer: LogRecord[] = [];
  private readonly listeners = new Set<Listener>();
  private seq = 0;

  constructor(opts: ServerLoggerOptions = {}) {
    this.level = opts.level ?? DEFAULT_LEVEL;
    this.file = opts.file ?? null;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.bufferSize = opts.bufferSize ?? DEFAULT_BUFFER_SIZE;
    this.echo = opts.echo ?? true;
    // Continue the sequence across restarts so a snapshot read of the file and
    // the live stream share one monotonic id space (the SSE resume cursor).
    this.seq = this.readMaxSeq();
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  getConfig(): { level: LogLevel; file: string | null; maxBytes: number; maxFiles: number } {
    return { level: this.level, file: this.file, maxBytes: this.maxBytes, maxFiles: this.maxFiles };
  }

  debug(msg: string, fields?: Record<string, unknown>): LogRecord | null {
    return this.log("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): LogRecord | null {
    return this.log("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): LogRecord | null {
    return this.log("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): LogRecord | null {
    return this.log("error", msg, fields);
  }

  /**
   * Record one event. Returns the persisted (redacted) record, or null when the
   * event is below the configured level and therefore dropped. Never throws: a
   * failing file write degrades to console + in-memory so logging can't take
   * down its caller (these run inside hot paths like the child stdout handler).
   */
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): LogRecord | null {
    if (levelRank(level) < levelRank(this.level)) return null;
    const record = redactRecord({
      seq: ++this.seq,
      ts: Date.now(),
      level,
      msg,
      ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
    });
    this.append(record);
    if (this.echo) writeConsole(record);
    this.pushBuffer(record);
    this.emit(record);
    return record;
  }

  /**
   * Recent records, ascending by seq, after applying the filter and a final
   * `limit` (default 200). Reads the rotated files plus the active file in
   * chronological order so history that has rolled over is still searchable;
   * falls back to the in-memory ring buffer when no file is configured or it
   * cannot be read.
   */
  recent(filter: LogFilter & { limit?: number } = {}): LogRecord[] {
    const limit = filter.limit ?? DEFAULT_RECENT_LIMIT;
    const source = this.file ? this.readAll() : [...this.buffer];
    const matched = source.filter((r) => matchesLogFilter(r, filter));
    return matched.slice(-limit);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // --- internals ---------------------------------------------------------

  private pushBuffer(record: LogRecord): void {
    this.buffer.push(record);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
  }

  private emit(record: LogRecord): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(record);
      } catch {
        // A broken subscriber must not break the fan-out or its producer.
      }
    }
  }

  private append(record: LogRecord): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const line = `${JSON.stringify(record)}\n`;
      this.rotateIfNeeded(Buffer.byteLength(line));
      appendFileSync(this.file, line);
    } catch {
      // Disk full / permission error: keep the console + in-memory copy.
    }
  }

  private rotateIfNeeded(incomingBytes: number): void {
    if (!this.file) return;
    let size = 0;
    try {
      size = statSync(this.file).size;
    } catch {
      return; // no active file yet — nothing to rotate
    }
    if (size + incomingBytes <= this.maxBytes) return;
    // Drop the oldest, shift `.i` → `.i+1`, then move the active file to `.1`.
    const oldest = `${this.file}.${this.maxFiles}`;
    if (existsSync(oldest)) rmSync(oldest, { force: true });
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      if (existsSync(from)) renameSync(from, `${this.file}.${i + 1}`);
    }
    renameSync(this.file, `${this.file}.1`);
  }

  /** All persisted records, oldest → newest, across rotated + active files. */
  private readAll(): LogRecord[] {
    const out: LogRecord[] = [];
    for (let i = this.maxFiles; i >= 1; i--) out.push(...readRecords(`${this.file}.${i}`));
    out.push(...readRecords(this.file));
    return out;
  }

  private readMaxSeq(): number {
    if (!this.file) return 0;
    let max = 0;
    for (const r of this.readAll()) if (r.seq > max) max = r.seq;
    return max;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Parse one NDJSON log file into records, skipping unparseable lines. */
function readRecords(path: string | null): LogRecord[] {
  if (!path) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return []; // missing file (not yet rotated to this slot)
  }
  const out: LogRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as LogRecord;
      if (isLogLevel(rec.level) && typeof rec.seq === "number") out.push(rec);
    } catch {
      // Truncated final line from a crash mid-write — skip it.
    }
  }
  return out;
}

/**
 * Redact the whole record in one pass by scrubbing its serialized form, so a
 * secret hiding in any string field (not just `msg`) is caught. Falls back to a
 * message-only redaction if the round-trip ever fails.
 */
function redactRecord(record: LogRecord): LogRecord {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(record))) as LogRecord;
  } catch {
    return { seq: record.seq, ts: record.ts, level: record.level, msg: redactSecrets(record.msg) };
  }
}

function writeConsole(record: LogRecord): void {
  const fields = record.fields ? ` ${safeStringify(record.fields)}` : "";
  const line = `[${new Date(record.ts).toISOString()}] ${record.level.toUpperCase()} ${record.msg}${fields}`;
  if (record.level === "error") console.error(line);
  else if (record.level === "warn") console.warn(line);
  else console.log(line);
}

/**
 * Resolve the log-file path from the environment. An explicit `DRYDOCK_LOG_FILE`
 * wins; otherwise it sits next to the database under `<data dir>/logs`. A
 * transient/in-memory database (`:memory:`, or no `DRYDOCK_DB` at all — the test
 * and ephemeral case) disables the file sink so tests never write stray logs.
 */
export function resolveLogFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.DRYDOCK_LOG_FILE?.trim();
  if (explicit) return explicit;
  const db = env.DRYDOCK_DB?.trim();
  if (!db || db === ":memory:") return null;
  return join(dirname(db), "logs", "drydock.log");
}

function resolveLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = env.DRYDOCK_LOG_LEVEL?.trim().toLowerCase();
  return isLogLevel(raw) ? raw : DEFAULT_LEVEL;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerLoggerOptions {
  return {
    file: resolveLogFile(env),
    level: resolveLevel(env),
    maxBytes: positiveInt(env.DRYDOCK_LOG_MAX_BYTES, DEFAULT_MAX_BYTES),
    maxFiles: positiveInt(env.DRYDOCK_LOG_MAX_FILES, DEFAULT_MAX_FILES),
  };
}

const GLOBAL_KEY = Symbol.for("drydock.server-logger");
type GlobalWithLogger = typeof globalThis & { [GLOBAL_KEY]?: ServerLogger };

/** Process-wide structured logger, configured from the environment on first use. */
export function getServerLogger(): ServerLogger {
  const g = globalThis as GlobalWithLogger;
  g[GLOBAL_KEY] ??= new ServerLogger(configFromEnv());
  return g[GLOBAL_KEY];
}

/** Apply a runtime log level (e.g. from saved settings) to the live logger. */
export function setServerLogLevel(level: LogLevel): void {
  getServerLogger().setLevel(level);
}
