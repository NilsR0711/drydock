// Daemon lifecycle for the packaged Drydock CLI (issue #216): start/stop/status/
// restart run the server as a long-lived background process so it keeps working
// through issues after the terminal closes. Like ops.mjs this is plain ESM under
// bin/ (which ships in the npm tarball) with no build step; command functions
// take their I/O and OS primitives as injected deps and return an exit code
// instead of calling process.exit, so the cross-platform logic stays unit- and
// integration-testable. bin/drydock.mjs owns the process boundary.
//
// Cross-platform stop is the subtle part. POSIX signals are unreliable on
// Windows (SIGTERM is a hard TerminateProcess, never a graceful drain), so the
// primary stop path asks the running server to drain over HTTP via the control
// endpoint (src/app/api/control/shutdown). Signals are only a fallback when that
// endpoint is unreachable.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readLockState } from "./ops.mjs";

/**
 * Directory holding Drydock's local state. Mirrors bin/drydock.mjs's
 * resolveDataDir so the daemon's bookkeeping lands beside the database.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [opts]
 */
function resolveDataDir({ env = process.env, home = homedir() } = {}) {
  const override = env.DRYDOCK_DATA_DIR?.trim();
  return override ? override : join(home, ".drydock");
}

/**
 * Path of the daemon state file: the CLI's record of the detached process (pid,
 * host, port, control token, start time) so later `status`/`stop` invocations
 * can find and signal it.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [opts]
 */
export function resolveDaemonStatePath(opts = {}) {
  return join(resolveDataDir(opts), "daemon.json");
}

/**
 * Path the detached server's stdout/stderr is redirected to, so the operator can
 * read logs without a terminal attached.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [opts]
 */
export function resolveDaemonLogPath(opts = {}) {
  return join(resolveDataDir(opts), "drydock.log");
}

/**
 * @typedef {{ pid: number, host: string, port: number, token: string,
 *             startedAt: number, logFile: string }} DaemonState
 */

/**
 * Read the daemon state file. Returns null when it is absent, unreadable,
 * corrupt, or missing a valid pid — every caller treats a null state as "no
 * daemon recorded", never as an error.
 *
 * @param {string} path
 * @returns {DaemonState | null}
 */
export function readDaemonState(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const { pid } = parsed;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Atomically write the daemon state file with owner-only permissions: it holds
 * the control token, so it must not be world-readable. Writing to a temp file
 * and renaming means a crash mid-write never leaves a torn record.
 *
 * @param {string} path
 * @param {DaemonState} state
 */
export function writeDaemonState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  // Open with an explicit 0o600 mode rather than writeFileSync: that keeps the
  // token-bearing file owner-only without depending on the process umask.
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(state));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Remove the daemon state file; absent is success. @param {string} path */
export function clearDaemonState(path) {
  rmSync(path, { force: true });
}

/** Cryptographically-random control token for the shutdown endpoint. */
function defaultGenerateToken() {
  return randomBytes(24).toString("hex");
}

/** @param {number} pid */
function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we may not signal it — still alive.
    return err && typeof err === "object" && err.code === "EPERM";
  }
}

/**
 * Human-readable uptime: "1h 2m 3s", dropping leading zero units but always
 * keeping seconds so a fresh start still reads "0s".
 *
 * @param {number} ms
 */
export function formatUptime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (h > 0 || m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

/**
 * @typedef {{ running: boolean, stale?: boolean, pid?: number, host?: string,
 *             port?: number, url?: string, startedAt?: number, uptimeMs?: number }} DaemonStatus
 */

/**
 * Derive a status view from the state file and a liveness probe. A state file
 * whose pid is dead is "stale" (a crash left it behind), not running.
 *
 * @param {DaemonState | null} state
 * @param {{ pidAlive: (pid: number) => boolean, now: () => number }} deps
 * @returns {DaemonStatus}
 */
export function describeStatus(state, { pidAlive, now }) {
  if (!state) return { running: false };
  if (!pidAlive(state.pid)) return { running: false, stale: true, pid: state.pid };
  return {
    running: true,
    pid: state.pid,
    host: state.host,
    port: state.port,
    url: `http://${state.host}:${state.port}`,
    startedAt: state.startedAt,
    uptimeMs: now() - state.startedAt,
  };
}

/** Render a status view as the lines `drydock status` prints. */
function formatStatus(status) {
  if (!status.running) {
    if (status.stale) {
      return `Drydock is not running (stale state file for pid ${status.pid}).`;
    }
    return "Drydock is not running.";
  }
  return [
    "Drydock is running.",
    `  pid:    ${status.pid}`,
    `  url:    ${status.url}`,
    `  uptime: ${formatUptime(status.uptimeMs)}`,
  ].join("\n");
}

/**
 * Default server command: launch the bundled launcher's `serve` mode. The
 * child re-enters bin/drydock.mjs, which boots the standalone Next server and
 * forwards the control token through to it.
 *
 * @param {{ host: string, port: number, packageRoot: string }} opts
 * @returns {{ command: string, args: string[] }}
 */
function defaultServerCommand({ host, port, packageRoot }) {
  return {
    command: process.execPath,
    args: [
      join(packageRoot, "bin", "drydock.mjs"),
      "serve",
      "--host",
      host,
      "--port",
      String(port),
    ],
  };
}

/**
 * `drydock start`: launch the server detached from the terminal and return
 * immediately. Refuses if a daemon (or a foreground instance holding the lock)
 * is already running, and takes over a stale state file left by a crash. The
 * child is unref'd and its stdio redirected to the log file so it survives the
 * parent shell closing on every OS.
 *
 * @param {{ host: string, port: number }} opts
 * @param {object} deps
 * @returns {number} exit code
 */
export function runStartCommand(
  { host, port },
  {
    statePath,
    logPath,
    lockPath,
    dataDir,
    packageRoot,
    now = () => Date.now(),
    generateToken = defaultGenerateToken,
    pidAlive = defaultPidAlive,
    readLock = (p) => readLockState(p),
    openAppendFd = (p) => openSync(p, "a"),
    closeFd = (fd) => closeSync(fd),
    spawnImpl = spawn,
    buildServerCommand = defaultServerCommand,
    log = console.log,
    error = console.error,
  },
) {
  const existing = readDaemonState(statePath);
  if (existing && pidAlive(existing.pid)) {
    error(
      `Drydock is already running (pid ${existing.pid}) on http://${existing.host}:${existing.port}.`,
    );
    return 1;
  }

  // A foreground `drydock` (no daemon state) would still hold the instance lock;
  // refuse rather than racing it for the port.
  const lock = readLock(lockPath);
  if (lock.state === "held") {
    error(
      `Drydock is already running (pid ${lock.pid ?? "unknown"}); stop it before starting a daemon.`,
    );
    return 1;
  }

  if (existing) {
    log(`Removing stale daemon state for dead pid ${existing.pid}.`);
    clearDaemonState(statePath);
  }

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });

  const token = generateToken();
  const { command, args } = buildServerCommand({ host, port, packageRoot });

  const logFd = openAppendFd(logPath);
  let child;
  try {
    child = spawnImpl(command, args, {
      cwd: packageRoot,
      env: { ...process.env, DRYDOCK_CONTROL_TOKEN: token },
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    // The child duplicated the fd; the parent must close its copy so the log
    // file isn't held open after start returns.
    closeFd(logFd);
  }

  child.unref();

  writeDaemonState(statePath, {
    pid: child.pid,
    host,
    port,
    token,
    startedAt: now(),
    logFile: logPath,
  });

  log(`Drydock started (pid ${child.pid}) on http://${host}:${port}. Logs: ${logPath}`);
  return 0;
}

const DEFAULT_STOP_TIMEOUT_MS = 15_000;
/** Grace given to a graceful drain (HTTP control or SIGTERM) before escalating. */
const SIGKILL_GRACE_MS = 5_000;

/**
 * Poll `pidAlive(pid)` until it reports dead or the budget runs out. Bounded by
 * a fixed iteration count (timeout / poll interval) rather than wall-clock time
 * so the wait is deterministic and the injected `sleep` can be a no-op in tests.
 *
 * @returns {Promise<boolean>} true once the process is gone, false on timeout.
 */
async function waitForExit(pid, { pidAlive, sleep, pollMs, timeoutMs }) {
  const iterations = Math.max(1, Math.ceil(timeoutMs / pollMs));
  for (let i = 0; i < iterations; i++) {
    if (!pidAlive(pid)) return true;
    await sleep(pollMs);
  }
  return !pidAlive(pid);
}

/**
 * `drydock stop`: stop a running daemon, gracefully on every OS. Asks the server
 * to drain over the HTTP control endpoint first (the only portable mechanism on
 * Windows); falls back to SIGTERM→SIGKILL on POSIX, or a hard terminate on
 * Windows, only when that endpoint is unreachable. Idempotent: stopping when
 * nothing runs (or only a stale state file remains) succeeds.
 *
 * @param {{}} _opts
 * @param {object} deps
 * @returns {Promise<number>} exit code
 */
export async function runStopCommand(
  _opts,
  {
    statePath,
    platform = process.platform,
    timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    pollMs = 200,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    pidAlive = defaultPidAlive,
    killImpl = (pid, signal) => process.kill(pid, signal),
    fetchImpl = fetch,
    log = console.log,
    error = console.error,
  },
) {
  const state = readDaemonState(statePath);
  if (!state) {
    log("Drydock is not running.");
    return 0;
  }
  if (!pidAlive(state.pid)) {
    clearDaemonState(statePath);
    log("Drydock is not running (removed stale state).");
    return 0;
  }

  // Primary, portable path: ask the server to drain and exit over HTTP.
  let drainRequested = false;
  try {
    const res = await fetchImpl(`http://${state.host}:${state.port}/api/control/shutdown`, {
      method: "POST",
      headers: { "x-drydock-control-token": state.token },
    });
    drainRequested = Boolean(res?.ok);
  } catch {
    drainRequested = false;
  }

  // Signal fallback only when the control endpoint did not accept the request.
  if (!drainRequested) {
    if (platform === "win32") {
      // No usable POSIX signal; a hard terminate is the only option left.
      error("Control endpoint unreachable; terminating the process (drain not guaranteed).");
      safeKill(killImpl, state.pid, undefined, error);
    } else {
      safeKill(killImpl, state.pid, "SIGTERM", error);
    }
  }

  const exited = await waitForExit(state.pid, { pidAlive, sleep, pollMs, timeoutMs });

  if (!exited) {
    // Last resort: escalate. SIGKILL on POSIX, another hard terminate on Windows.
    safeKill(killImpl, state.pid, platform === "win32" ? undefined : "SIGKILL", error);
    const killed = await waitForExit(state.pid, {
      pidAlive,
      sleep,
      pollMs,
      timeoutMs: SIGKILL_GRACE_MS,
    });
    if (!killed) {
      error(`Failed to stop Drydock (pid ${state.pid}); it is still running.`);
      return 1;
    }
  }

  clearDaemonState(statePath);
  log("Drydock stopped.");
  return 0;
}

/** Kill that swallows ESRCH (already gone) and reports anything else. */
function safeKill(killImpl, pid, signal, error) {
  try {
    killImpl(pid, signal);
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ESRCH") return;
    error(`Signal to pid ${pid} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * `drydock status`: report whether the daemon is running, with pid, URL, and
 * uptime. Exit 0 when running, 3 (the systemd "program not running" convention)
 * when stopped or stale, so the command is scriptable.
 *
 * @param {{}} _opts
 * @param {object} deps
 * @returns {number} exit code
 */
export function runStatusCommand(
  _opts,
  { statePath, pidAlive = defaultPidAlive, now = () => Date.now(), log = console.log },
) {
  const status = describeStatus(readDaemonState(statePath), { pidAlive, now });
  log(formatStatus(status));
  return status.running ? 0 : 3;
}

/**
 * `drydock restart`: stop any running daemon, then start a fresh one. A failed
 * stop aborts the restart so a still-running instance is never double-started.
 *
 * @param {{ host: string, port: number }} opts
 * @param {object} deps Shared deps forwarded to stop and start.
 * @returns {Promise<number>} exit code
 */
export async function runRestartCommand(opts, deps) {
  const stopCode = await runStopCommand({}, deps);
  if (stopCode !== 0) return stopCode;
  return runStartCommand(opts, deps);
}
