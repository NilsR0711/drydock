// Ops subcommands for the packaged Drydock CLI (issue #176): backup/restore,
// doctor, and service install. Lives under bin/ (which ships in the npm
// tarball) as plain ESM with no build step, because the published package
// contains no src/ tree. Command functions never call process.exit — they
// return an exit code so they stay unit-testable; bin/drydock.mjs owns the
// process boundary.

import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Path of the single-instance lock the server holds while running. Mirrors the
 * server's `worktreeHome()` resolution (DRYDOCK_HOME ?? ~/.drydock) so the CLI
 * inspects the same file the orchestrator locks.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [opts]
 */
export function resolveLockPath({ env = process.env, home = homedir() } = {}) {
  return join(env.DRYDOCK_HOME ?? join(home, ".drydock"), "instance.lock");
}

/** @param {number} pid */
function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Inspect the instance lock file: free (absent), held (live pid), stale (dead
 * pid or corrupt content), or unknown (the file exists but cannot be read,
 * e.g. EACCES/EIO). Unknown is fail-closed: callers guarding destructive
 * operations must treat it like held, never like free. Mirrors the staleness
 * rules of the server's `acquireInstanceLock`.
 *
 * @param {string} lockPath
 * @param {{ pidAlive?: (pid: number) => boolean }} [deps]
 * @returns {{ state: "free" | "held" | "stale" | "unknown", pid?: number }}
 */
export function readLockState(lockPath, { pidAlive = defaultPidAlive } = {}) {
  let raw;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") return { state: "free" };
    return { state: "unknown" };
  }
  try {
    const { pid } = JSON.parse(raw);
    if (!Number.isInteger(pid)) return { state: "stale" };
    return pidAlive(pid) ? { state: "held", pid } : { state: "stale", pid };
  } catch {
    return { state: "stale" };
  }
}

/**
 * Timestamped backup filename, formatted exactly like the server-side backup
 * job so both kinds of snapshots sort and prune together.
 *
 * @param {Date} [now]
 */
export function timestampedBackupName(now = new Date()) {
  return `drydock-${now.toISOString().replace(/[:.]/g, "-")}.db`;
}

/**
 * Resolve where `drydock backup [path]` writes: no argument → timestamped file
 * under `<dataDir>/backups`; an existing directory → timestamped file inside
 * it; anything else is taken verbatim as the target file.
 *
 * @param {string | undefined} pathArg
 * @param {{ dataDir: string, now?: Date }} opts
 */
export function resolveBackupTarget(pathArg, { dataDir, now = new Date() }) {
  if (!pathArg) return join(dataDir, "backups", timestampedBackupName(now));
  try {
    if (statSync(pathArg).isDirectory()) return join(pathArg, timestampedBackupName(now));
  } catch {
    // Not an existing path — treat it as an explicit target file.
  }
  return pathArg;
}

// better-sqlite3 is a native dependency; load it lazily so `drydock --help`
// and friends never pay for (or crash on) the binding when it is not needed.
async function loadDatabase() {
  const mod = await import("better-sqlite3");
  return mod.default;
}

/**
 * `drydock backup [path]`: write a consistent snapshot of the SQLite database
 * via better-sqlite3's native `.backup()`, which is WAL-aware — safe while the
 * server is running. Unlike the server's scheduled backup job this never
 * prunes anything: a manual command must not delete files the operator did not
 * ask it to touch.
 *
 * @param {string | undefined} pathArg
 * @param {{ dbPath: string, dataDir: string, now?: Date,
 *           log?: (line: string) => void, error?: (line: string) => void }} deps
 * @returns {Promise<number>} exit code
 */
export async function runBackupCommand(
  pathArg,
  { dbPath, dataDir, now = new Date(), log = console.log, error = console.error },
) {
  if (!existsSync(dbPath)) {
    error(`No database found at ${dbPath} — nothing to back up yet.`);
    return 1;
  }
  const target = resolveBackupTarget(pathArg, { dataDir, now });
  if (existsSync(target)) {
    error(`Backup target already exists: ${target}`);
    return 1;
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    const Database = await loadDatabase();
    const db = new Database(dbPath, { readonly: true });
    try {
      await db.backup(target);
    } finally {
      db.close();
    }
  } catch (err) {
    error(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  log(`Backed up ${dbPath} → ${target}`);
  return 0;
}

/**
 * `drydock restore <path>`: replace the live database with a backup. Refuses
 * while a live drydock process holds the instance lock (restoring under a
 * running server would corrupt both states), validates the backup with
 * `PRAGMA integrity_check` before touching anything, and removes the target's
 * `-wal`/`-shm` sidecars so SQLite cannot replay old WAL frames over the
 * restored file. The copy lands in a temp file first and is renamed into
 * place, so a crash mid-copy never leaves a torn database.
 *
 * @param {string} sourcePath
 * @param {{ dbPath: string, lockPath: string, pidAlive?: (pid: number) => boolean,
 *           log?: (line: string) => void, error?: (line: string) => void }} deps
 * @returns {Promise<number>} exit code
 */
export async function runRestoreCommand(
  sourcePath,
  { dbPath, lockPath, pidAlive, log = console.log, error = console.error },
) {
  if (!existsSync(sourcePath)) {
    error(`Backup file not found: ${sourcePath}`);
    return 1;
  }

  const Database = await loadDatabase();
  try {
    const src = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      const rows = src.pragma("integrity_check");
      const ok = Array.isArray(rows) && rows.length === 1 && rows[0]?.integrity_check === "ok";
      if (!ok) {
        error(`${sourcePath} is not a valid SQLite database: integrity check failed.`);
        return 1;
      }
    } finally {
      src.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(`${sourcePath} is not a valid SQLite database: ${message}`);
    return 1;
  }

  const lock = readLockState(lockPath, pidAlive ? { pidAlive } : {});
  if (lock.state === "held") {
    error(
      `A drydock instance is running (pid ${lock.pid}) — stop it before restoring, ` +
        `otherwise the live server would overwrite the restored state.`,
    );
    return 1;
  }
  if (lock.state === "unknown") {
    error(
      `The instance lock at ${lockPath} exists but could not be read, so a live ` +
        `drydock process cannot be ruled out — fix the lock file's permissions ` +
        `(or remove it if no instance is running) and retry.`,
    );
    return 1;
  }

  const tmp = `${dbPath}.restore-tmp`;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    copyFileSync(sourcePath, tmp);
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    renameSync(tmp, dbPath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup: reporting the original failure matters more.
    }
    error(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  log(`Restored ${sourcePath} → ${dbPath}`);
  return 0;
}

// --- doctor ----------------------------------------------------------------

/** Per-probe wall-clock bound so one hung CLI or endpoint can't wedge doctor. */
const PROBE_TIMEOUT_MS = 15_000;

/** Free-space thresholds for the data dir probe. */
const DISK_FAIL_BYTES = 200 * 1024 * 1024; // SQLite + WAL need headroom to commit.
const DISK_WARN_BYTES = 1024 * 1024 * 1024;

/**
 * Run a CLI and capture its output; rejects on spawn failure or timeout.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
function defaultRunner(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`'${cmd}' timed out after ${PROBE_TIMEOUT_MS}ms`));
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

/** First line of CLI output, trimmed and bounded, for one-line probe reports. */
function firstLine(text) {
  return (
    String(text || "")
      .trim()
      .split("\n")[0] ?? ""
  ).slice(0, 120);
}

/**
 * Read the repo rows the doctor needs (agents in use, GitLab endpoints) from
 * the SQLite DB. Returns an empty list when the DB or table does not exist
 * yet — a fresh install must not make repo-derived probes fail.
 *
 * @param {string} dbPath
 * @returns {Promise<{ agent: string, platform: string, apiBaseUrl: string | null, apiToken: string | null }[]>}
 */
async function readRepoRows(dbPath) {
  if (!existsSync(dbPath)) return [];
  try {
    const Database = await loadDatabase();
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return db
        .prepare(
          "SELECT agent, platform, api_base_url AS apiBaseUrl, api_token AS apiToken FROM repos",
        )
        .all();
    } finally {
      db.close();
    }
  } catch {
    // Unreadable or unmigrated DB — the integrity probe reports that story.
    return [];
  }
}

/** Probe one CLI's presence via `--version`. */
async function probeCliVersion(runner, command) {
  try {
    const res = await runner(command, ["--version"]);
    if (res.exitCode === 0) return { status: "ok", detail: firstLine(res.stdout) || "installed" };
    return {
      status: "fail",
      detail: `'${command} --version' exited ${res.exitCode}: ${firstLine(res.stderr || res.stdout)}`,
    };
  } catch (err) {
    return { status: "fail", detail: `'${command}' not found (${firstLine(String(err))})` };
  }
}

/**
 * `drydock doctor`: one health probe per line — GitHub CLI auth, agent CLIs,
 * GitLab token validity per configured base URL, free disk space at the data
 * dir, `PRAGMA integrity_check`, and the instance lock. Returns a non-zero
 * exit code when any probe fails so the command is scriptable. Definitive
 * failures (bad auth, missing required CLI, corrupt DB, full disk) fail;
 * transient conditions (network errors, stale locks) only warn.
 *
 * @param {{ dbPath: string, dataDir: string, lockPath: string,
 *           runner?: (cmd: string, args: string[]) => Promise<{ exitCode: number, stdout: string, stderr: string }>,
 *           fetchImpl?: typeof fetch,
 *           statfsImpl?: (path: string) => { bavail: number | bigint, bsize: number | bigint },
 *           pidAlive?: (pid: number) => boolean,
 *           log?: (line: string) => void, error?: (line: string) => void }} deps
 * @returns {Promise<number>} exit code
 */
export async function runDoctorCommand({
  dbPath,
  dataDir,
  lockPath,
  runner = defaultRunner,
  fetchImpl = fetch,
  statfsImpl = statfsSync,
  pidAlive,
  log = console.log,
  error = console.error,
}) {
  const repos = await readRepoRows(dbPath);
  const agentsInUse = new Set(repos.map((r) => r.agent));

  /** @type {{ name: string, status: string, detail: string }[]} */
  const results = [];

  // GitHub CLI auth — required by every non-GitLab repo and the default setup.
  try {
    const res = await runner("gh", ["auth", "status"]);
    results.push(
      res.exitCode === 0
        ? { name: "github auth", status: "ok", detail: "gh auth status passed" }
        : {
            name: "github auth",
            status: "fail",
            detail: `gh auth status exited ${res.exitCode}: ${firstLine(res.stderr || res.stdout)}`,
          },
    );
  } catch (err) {
    results.push({
      name: "github auth",
      status: "fail",
      detail: `gh CLI not found (${firstLine(String(err))})`,
    });
  }

  // Agent CLIs: claude is the default agent and always required; codex only
  // fails when a configured repo actually uses it.
  results.push({ name: "claude cli", ...(await probeCliVersion(runner, "claude")) });
  const codex = await probeCliVersion(runner, "codex");
  if (codex.status === "fail" && !agentsInUse.has("codex")) {
    results.push({
      name: "codex cli",
      status: "skip",
      detail: "not installed (no repo uses codex)",
    });
  } else {
    results.push({ name: "codex cli", ...codex });
  }

  // GitLab token validity, one probe per distinct configured base URL.
  const gitlabBases = new Map();
  for (const repo of repos) {
    if (repo.platform !== "gitlab" || !repo.apiBaseUrl || !repo.apiToken) continue;
    const base = repo.apiBaseUrl.trim().replace(/\/+$/, "");
    if (base && !gitlabBases.has(base)) gitlabBases.set(base, repo.apiToken);
  }
  if (gitlabBases.size === 0) {
    results.push({ name: "gitlab token", status: "skip", detail: "no GitLab repos configured" });
  }
  for (const [base, token] of gitlabBases) {
    let host = base;
    try {
      host = new URL(base).host;
    } catch {
      // Keep the raw base as the display name.
    }
    const name = `gitlab ${host}`;
    try {
      const res = await fetchImpl(`${base}/api/v4/user`, {
        headers: { "PRIVATE-TOKEN": token },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) {
        results.push({
          name,
          status: "fail",
          detail: `token rejected (HTTP ${res.status}) — update it in the repo's forge settings`,
        });
      } else if (res.ok) {
        results.push({ name, status: "ok", detail: "token accepted" });
      } else {
        results.push({
          name,
          status: "warn",
          detail: `HTTP ${res.status} — could not verify token`,
        });
      }
    } catch (err) {
      results.push({
        name,
        status: "warn",
        detail: `unreachable — could not verify token (${firstLine(String(err))})`,
      });
    }
  }

  // Free disk space where the DB (plus WAL and backups) lives.
  try {
    const stat = statfsImpl(dataDir);
    const free = Number(stat.bavail) * Number(stat.bsize);
    const human = `${(free / 1024 ** 3).toFixed(1)} GiB free at ${dataDir}`;
    if (free < DISK_FAIL_BYTES) {
      results.push({ name: "disk space", status: "fail", detail: human });
    } else if (free < DISK_WARN_BYTES) {
      results.push({ name: "disk space", status: "warn", detail: human });
    } else {
      results.push({ name: "disk space", status: "ok", detail: human });
    }
  } catch (err) {
    results.push({
      name: "disk space",
      status: "warn",
      detail: `could not stat ${dataDir} (${firstLine(String(err))})`,
    });
  }

  // Database integrity. A missing DB is a fresh install, not a failure.
  if (!existsSync(dbPath)) {
    results.push({ name: "db integrity", status: "skip", detail: "no database yet" });
  } else {
    try {
      const Database = await loadDatabase();
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const rows = db.pragma("integrity_check");
        const ok = Array.isArray(rows) && rows.length === 1 && rows[0]?.integrity_check === "ok";
        results.push(
          ok
            ? { name: "db integrity", status: "ok", detail: "PRAGMA integrity_check passed" }
            : {
                name: "db integrity",
                status: "fail",
                detail: "PRAGMA integrity_check reported errors",
              },
        );
      } finally {
        db.close();
      }
    } catch (err) {
      results.push({
        name: "db integrity",
        status: "fail",
        detail: `could not open database (${firstLine(String(err))})`,
      });
    }
  }

  // Instance lock: informative — a running dock is healthy, a stale lock warns.
  const lock = readLockState(lockPath, pidAlive ? { pidAlive } : {});
  if (lock.state === "held") {
    results.push({
      name: "instance lock",
      status: "ok",
      detail: `instance running (pid ${lock.pid})`,
    });
  } else if (lock.state === "stale") {
    results.push({
      name: "instance lock",
      status: "warn",
      detail: "stale lock file (holder is dead); the next start takes it over",
    });
  } else if (lock.state === "unknown") {
    results.push({
      name: "instance lock",
      status: "warn",
      detail: `lock file at ${lockPath} is unreadable — check its permissions`,
    });
  } else {
    results.push({ name: "instance lock", status: "ok", detail: "no instance running" });
  }

  for (const { name, status, detail } of results) {
    log(`${status.padEnd(5)}${name.padEnd(28)}${detail}`);
  }
  const failed = results.filter((r) => r.status === "fail").length;
  if (failed > 0) {
    error(`doctor: ${failed} probe(s) failed.`);
    return 1;
  }
  return 0;
}

// --- service install/uninstall ----------------------------------------------

/** Reverse-DNS label shared by the launchd plist filename and its job label. */
export const SERVICE_LABEL = "com.drydock.serve";

/** systemd user unit filename. */
const SYSTEMD_UNIT = "drydock.service";

/** @param {string} value */
function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * launchd agent plist that starts `node <bin> serve` at login. KeepAlive on
 * unsuccessful exit only: a crash restarts the dock, a clean stop stays down.
 * Node's absolute path is embedded because launchd does not inherit a login
 * shell's PATH (nvm and friends).
 *
 * @param {{ nodePath: string, binPath: string, logPath: string }} opts
 */
export function buildLaunchdPlist({ nodePath, binPath, logPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(binPath)}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

/**
 * systemd user unit that starts `node <bin> serve` at login. Paths are quoted
 * for systemd's ExecStart word splitting; journald captures the output, so no
 * log path is needed.
 *
 * @param {{ nodePath: string, binPath: string }} opts
 */
export function buildSystemdUnit({ nodePath, binPath }) {
  return `[Unit]
Description=Drydock — autonomously turn GitHub issues into pull requests
After=network-online.target

[Service]
ExecStart="${nodePath}" "${binPath}" serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/**
 * Where the platform's service definition lives, or null when the platform has
 * no supported user-level service manager.
 *
 * @param {string} platform process.platform value
 * @param {string} home
 * @returns {string | null}
 */
export function servicePath(platform, home) {
  if (platform === "darwin") return join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  if (platform === "linux") return join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
  return null;
}

/**
 * `drydock service install|uninstall`: generate and load a launchd agent
 * (macOS) or systemd user unit (Linux) that runs `drydock serve` at login.
 * Install is idempotent — it unloads any previous definition before loading
 * the fresh one. Uninstalling a service that was never installed is a no-op.
 *
 * @param {"install" | "uninstall"} action
 * @param {{ platform: string, home: string, nodePath: string, binPath: string, dataDir: string,
 *           uid?: number,
 *           runner?: (cmd: string, args: string[]) => Promise<{ exitCode: number, stdout: string, stderr: string }>,
 *           log?: (line: string) => void, error?: (line: string) => void }} deps
 * @returns {Promise<number>} exit code
 */
export async function runServiceCommand(
  action,
  {
    platform,
    home,
    nodePath,
    binPath,
    dataDir,
    uid = typeof process.getuid === "function" ? process.getuid() : 0,
    runner = defaultRunner,
    log = console.log,
    error = console.error,
  },
) {
  const definitionPath = servicePath(platform, home);
  if (!definitionPath) {
    error(
      `\`drydock service\` is not supported on ${platform} — only macOS (launchd) and Linux (systemd) are.`,
    );
    return 1;
  }

  // Tolerate "was not loaded" responses; only the final load/enable must succeed.
  const run = async (cmd, args) => {
    try {
      return await runner(cmd, args);
    } catch (err) {
      return { exitCode: 127, stdout: "", stderr: String(err) };
    }
  };

  if (action === "uninstall") {
    if (!existsSync(definitionPath)) {
      log(`Service is not installed (no file at ${definitionPath}).`);
      return 0;
    }
    if (platform === "darwin") {
      await run("launchctl", ["bootout", `gui/${uid}/${SERVICE_LABEL}`]);
    } else {
      await run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    }
    rmSync(definitionPath, { force: true });
    if (platform === "linux") await run("systemctl", ["--user", "daemon-reload"]);
    log(`Service uninstalled (${definitionPath} removed).`);
    return 0;
  }

  mkdirSync(dirname(definitionPath), { recursive: true });
  if (platform === "darwin") {
    const logPath = join(dataDir, "drydock.log");
    writeFileSync(definitionPath, buildLaunchdPlist({ nodePath, binPath, logPath }));
    // Unload any previous incarnation so a re-install picks up the new plist.
    await run("launchctl", ["bootout", `gui/${uid}/${SERVICE_LABEL}`]);
    const res = await run("launchctl", ["bootstrap", `gui/${uid}`, definitionPath]);
    if (res.exitCode !== 0) {
      error(
        `launchctl bootstrap failed (exit ${res.exitCode}): ${firstLine(res.stderr || res.stdout)}`,
      );
      error(`The plist was written to ${definitionPath}; load it manually or re-run install.`);
      return 1;
    }
    log(`Service installed: ${definitionPath} (label ${SERVICE_LABEL}). Logs: ${logPath}`);
    return 0;
  }

  writeFileSync(definitionPath, buildSystemdUnit({ nodePath, binPath }));
  const reload = await run("systemctl", ["--user", "daemon-reload"]);
  const enable =
    reload.exitCode === 0
      ? await run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT])
      : reload;
  if (enable.exitCode !== 0) {
    error(
      `systemctl --user failed (exit ${enable.exitCode}): ${firstLine(enable.stderr || enable.stdout)}`,
    );
    error(`The unit was written to ${definitionPath}; enable it manually or re-run install.`);
    return 1;
  }
  log(
    `Service installed: ${definitionPath}. It starts at login; for boot without login run \`loginctl enable-linger\`.`,
  );
  return 0;
}
