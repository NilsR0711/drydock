#!/usr/bin/env node

// Drydock terminal launcher (issue #12). Boots the bundled Next.js standalone
// server, applying SQLite migrations into a user data directory on first start,
// and optionally opens the dashboard in the browser. Plain ESM with no build
// step or TypeScript runtime so it works straight from the published tarball.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3737;

/**
 * Returns true when the given host address binds only to the local machine.
 * Loopback addresses (127.0.0.1, ::1, localhost) are safe because they are
 * unreachable from the network; all other values expand the attack surface.
 *
 * @param {string} host
 */
export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * Throws an informative Error when `host` is a non-loopback address and the
 * operator has not set DRYDOCK_ALLOW_REMOTE=1. This is the only gate between
 * the unauthenticated dashboard and the network.
 *
 * @param {string} host
 * @param {Record<string, string | undefined>} [env]
 */
export function assertSafeHost(host, env = process.env) {
  if (isLoopbackHost(host)) return;
  if (env.DRYDOCK_ALLOW_REMOTE) return;
  throw new Error(
    `Refusing to bind to "${host}": the Drydock dashboard has no authentication and ` +
      `would be reachable by anyone on the network.\n` +
      `To opt in and accept this risk, set DRYDOCK_ALLOW_REMOTE=1:\n` +
      `  DRYDOCK_ALLOW_REMOTE=1 drydock --host ${host}`,
  );
}
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Parse the launcher's CLI arguments into a directive. `--help`/`--version`
 * short-circuit; otherwise the result describes how to serve. Throws an Error
 * with a human-readable message on invalid input so the caller can print it.
 */
export function parseArgs(argv) {
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { mode: "help" };
    if (arg === "--version" || arg === "-v") return { mode: "version" };
  }

  if (argv[0] === "update") {
    if (argv.length > 1) throw new Error(`unexpected argument: ${argv[1]}`);
    return { mode: "update" };
  }

  // `drydock mcp` launches the bundled stdio MCP server for an MCP host
  // (issue #230). It takes no flags of its own; the host owns the transport.
  if (argv[0] === "mcp") {
    if (argv.length > 1) throw new Error(`unexpected argument: ${argv[1]}`);
    return { mode: "mcp" };
  }

  if (argv[0] === "backup") {
    if (argv.length > 2) throw new Error(`unexpected argument: ${argv[2]}`);
    return { mode: "backup", path: argv[1] };
  }

  if (argv[0] === "restore") {
    if (argv.length < 2) throw new Error("missing backup path: usage `drydock restore <path>`");
    if (argv.length > 2) throw new Error(`unexpected argument: ${argv[2]}`);
    return { mode: "restore", path: argv[1] };
  }

  if (argv[0] === "doctor") {
    if (argv.length > 1) throw new Error(`unexpected argument: ${argv[1]}`);
    return { mode: "doctor" };
  }

  if (argv[0] === "service") {
    const action = argv[1];
    if (action !== "install" && action !== "uninstall") {
      throw new Error(
        action
          ? `unknown service action: ${action} (expected install or uninstall)`
          : "missing service action: usage `drydock service install|uninstall`",
      );
    }
    if (argv.length > 2) throw new Error(`unexpected argument: ${argv[2]}`);
    return { mode: "service", action };
  }

  // Daemon lifecycle (issue #216). `start`/`restart` launch the background
  // server and accept the same host/port flags as `serve` (but not `--open`,
  // since a detached daemon has no terminal to open a browser from). `stop` and
  // `status` operate on the recorded daemon, so they take no flags.
  if (argv[0] === "start" || argv[0] === "restart") {
    const { host, port } = parseHostPort(argv.slice(1));
    return { mode: argv[0], host, port };
  }
  if (argv[0] === "stop" || argv[0] === "status") {
    if (argv.length > 1) throw new Error(`unexpected argument: ${argv[1]}`);
    return { mode: argv[0] };
  }

  // `drydock serve` is an explicit alias for the default mode so scripts and
  // service units can spell out what they launch.
  const flags = argv[0] === "serve" ? argv.slice(1) : argv;
  const { host, port, open } = parseHostPort(flags, { allowOpen: true });
  return { mode: "serve", host, port, open };
}

/**
 * Parse the shared `--host`/`--port` (and optionally `--open`) flags into a
 * directive fragment. Throws on unknown options or stray positional arguments so
 * each command surfaces the same error messages.
 *
 * @param {string[]} flags
 * @param {{ allowOpen?: boolean }} [opts]
 */
function parseHostPort(flags, { allowOpen = false } = {}) {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let open = false;

  for (let i = 0; i < flags.length; i++) {
    const arg = flags[i];

    if (allowOpen && arg === "--open") {
      open = true;
      continue;
    }

    const value = (flag) => {
      const eq = `${flag}=`;
      if (arg.startsWith(eq)) return arg.slice(eq.length);
      const next = flags[i + 1];
      if (next === undefined) throw new Error(`missing value for ${flag}`);
      i++;
      return next;
    };

    if (arg === "--port" || arg === "-p" || arg.startsWith("--port=")) {
      port = parsePort(value("--port"));
      continue;
    }
    if (arg === "--host" || arg === "-H" || arg.startsWith("--host=")) {
      host = value("--host");
      continue;
    }

    if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    throw new Error(`unexpected argument: ${arg}`);
  }

  return { host, port, open };
}

function parsePort(raw) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: "${raw}" (expected an integer between 1 and 65535)`);
  }
  return port;
}

/**
 * Resolve the directory holding Drydock's database and local state. Defaults to
 * `~/.drydock` so a packaged install never writes inside its own (potentially
 * read-only) install location; overridable via DRYDOCK_DATA_DIR.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [opts]
 */
export function resolveDataDir({ env = process.env, home = homedir() } = {}) {
  const override = env.DRYDOCK_DATA_DIR?.trim();
  return override ? override : join(home, ".drydock");
}

/**
 * Resolve the SQLite database path; DRYDOCK_DB overrides the data dir entirely.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [opts]
 */
export function resolveDbPath({ env = process.env, home = homedir() } = {}) {
  const override = env.DRYDOCK_DB?.trim();
  return override ? override : join(resolveDataDir({ env, home }), "drydock.db");
}

const HELP = `drydock — autonomously turn GitHub issues into pull requests

Usage:
  drydock [options]      Start the server and dashboard (foreground)
  drydock serve          Same as running with no subcommand
  drydock start          Launch the server as a background daemon and return
  drydock stop           Gracefully stop the background daemon (drains in-flight jobs)
  drydock status         Report whether the daemon is running (pid, url, uptime)
  drydock restart        Stop the daemon if running, then start a fresh one
  drydock mcp            Start the local stdio MCP server for an MCP host
  drydock update         Update to the latest published version
  drydock backup [path]  Snapshot the database (WAL-safe, works while running);
                         default target: <data dir>/backups/drydock-<timestamp>.db
  drydock restore <path> Replace the database with a backup (server must be stopped)
  drydock doctor         Health checks: gh/claude/codex auth, GitLab tokens, disk
                         space, DB integrity, instance lock; exits non-zero on failure
  drydock service install|uninstall
                         Run the dock at login via launchd (macOS) / systemd (Linux)

Options:
  -p, --port <number>   Port to listen on (default: ${DEFAULT_PORT})
  -H, --host <host>     Host to bind to (default: ${DEFAULT_HOST})
      --open            Open the dashboard in your browser once it is ready
  -v, --version         Print the version and exit
  -h, --help            Show this help and exit

Data is stored in ~/.drydock (override with DRYDOCK_DATA_DIR); the database is
created and migrated automatically on first start.`;

/**
 * Classify how Drydock was installed from its package directory. Drives the
 * in-dashboard update notice (issue #58): a global install can self-update via
 * `drydock update`, whereas an npx run or a dev checkout cannot.
 *
 * @param {string} packageRoot Absolute path to the installed package directory.
 * @returns {"global" | "npx" | "local"}
 */
export function detectInstallKind(packageRoot) {
  const normalized = packageRoot.replace(/\\/g, "/");
  if (normalized.includes("/_npx/")) return "npx";
  if (normalized.includes("/node_modules/")) return "global";
  return "local";
}

/** The npm package name this CLI is published under. */
const PACKAGE_NAME = "@nilsr0711/drydock";

/** The command that updates a global install to the latest published version. */
export function updateCommand() {
  return { command: "npm", args: ["install", "--global", `${PACKAGE_NAME}@latest`] };
}

/**
 * Compare two `x.y.z` versions (a leading `v` is tolerated). Returns 1 if `a` is
 * newer, -1 if older, 0 if equal. Throws if either version is unparseable so
 * callers can fall back rather than silently mis-ordering.
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
    if (!m) throw new Error(`unparseable version: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/**
 * Decide what `drydock update` should do given the installed version and the
 * latest published version (which may be null/unparseable when the check fails).
 * Degrades gracefully: when the latest version can't be determined, still
 * attempts the install rather than blocking the user.
 *
 * @returns {{ action: "skip" | "install", reason: string, latestVersion?: string }}
 */
export function planUpdate(currentVersion, latestVersion) {
  if (!latestVersion) return { action: "install", reason: "unknown-latest" };
  let cmp;
  try {
    cmp = compareVersions(latestVersion, currentVersion);
  } catch {
    return { action: "install", reason: "unknown-latest" };
  }
  if (cmp <= 0) return { action: "skip", reason: "up-to-date" };
  return { action: "install", reason: "update-available", latestVersion };
}

/**
 * Resolve the latest published version from the npm registry's `latest`
 * dist-tag. Never throws: returns null on any network/HTTP/parse failure so the
 * caller can fall back to a blind install.
 *
 * @param {string} pkg The (possibly scoped) package name.
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<string | null>}
 */
export async function resolveLatestVersion(pkg, { fetchImpl = fetch } = {}) {
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`;
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "drydock-update" },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

/** Run the self-update, inheriting stdio so npm's progress is visible. */
async function runUpdate() {
  const current = readVersion();
  console.error(`Current version: drydock v${current}`);

  const latest = await resolveLatestVersion(PACKAGE_NAME);
  const plan = planUpdate(current, latest);

  if (plan.action === "skip") {
    console.error(`drydock is already up to date (v${current}).`);
    process.exit(0);
  }

  if (plan.reason === "unknown-latest") {
    console.error("Could not determine the latest version; attempting update anyway…");
  } else {
    console.error(`Updating drydock ${current} → ${plan.latestVersion} …`);
  }

  const { command, args } = updateCommand();
  const child = spawn(command, args, {
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    if (code === 0 && plan.reason === "update-available") {
      console.error(`Updated to drydock v${plan.latestVersion}.`);
    }
    process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    console.error(`Update failed: ${err.message}`);
    process.exit(1);
  });
}

/** Read the package version without an import assertion (keeps ESM warning-free). */
function readVersion() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
}

/** Spawn the platform browser-opener for `url`, detached and best-effort. */
function openBrowser(url) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const child = spawn(command, [url], {
    shell: process.platform === "win32",
    stdio: "ignore",
    detached: true,
  });
  child.on("error", () => {
    console.error(`Could not open a browser automatically. Visit ${url}`);
  });
  child.unref();
}

/** Poll the server until it accepts connections, then resolve. */
async function waitForServer(url, { attempts = 100, intervalMs = 100 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fetch(url);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return false;
}

/**
 * Resolve the bundled stdio MCP server entry shipped beside the standalone
 * runtime (issue #230). The MCP modules are not part of the Next.js app graph,
 * so they ship as a standalone esbuild bundle rather than inside `server.js`.
 * Exported so the path contract is unit-testable without spawning a process.
 *
 * @param {string} packageRoot Absolute path to the installed package directory.
 */
export function resolveMcpEntry(packageRoot) {
  return join(packageRoot, ".next", "standalone", "mcp-server.cjs");
}

/**
 * Launch the bundled stdio MCP server (issue #230). It runs as its own process —
 * pointed at the same data dir and migrations as `serve` — with stdio inherited
 * so the MCP host owns the child's stdin/stdout/stderr. stdout therefore stays
 * clean for the protocol; the launcher prints nothing to it.
 */
async function runMcp() {
  const entry = resolveMcpEntry(PACKAGE_ROOT);
  if (!existsSync(entry)) {
    throw new Error(
      "MCP server bundle not found. Run `pnpm build` first (the published package ships it prebuilt).",
    );
  }

  const dataDir = resolveDataDir();
  mkdirSync(dataDir, { recursive: true });

  const env = {
    ...process.env,
    NODE_ENV: "production",
    DRYDOCK_DB: resolveDbPath(),
    DRYDOCK_MIGRATIONS: join(PACKAGE_ROOT, "drizzle"),
  };

  const child = spawn(process.execPath, [entry, "mcp"], {
    cwd: dirname(entry),
    env,
    stdio: "inherit",
  });

  child.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

async function serve({ host, port, open }) {
  assertSafeHost(host);

  const serverEntry = join(PACKAGE_ROOT, ".next", "standalone", "server.js");
  if (!existsSync(serverEntry)) {
    throw new Error(
      "Standalone server bundle not found. Run `pnpm build` first (the published package ships it prebuilt).",
    );
  }

  const dataDir = resolveDataDir();
  mkdirSync(dataDir, { recursive: true });

  const env = {
    ...process.env,
    NODE_ENV: "production",
    HOSTNAME: host,
    PORT: String(port),
    DRYDOCK_DB: resolveDbPath(),
    DRYDOCK_MIGRATIONS: join(PACKAGE_ROOT, "drizzle"),
    // Surface the running version and install kind to the dashboard so it can
    // show an "update available" notice without bundling package.json (#58).
    DRYDOCK_VERSION: readVersion(),
    DRYDOCK_INSTALL_KIND: detectInstallKind(PACKAGE_ROOT),
  };

  const url = `http://${host}:${port}`;
  console.error(`Drydock starting on ${url} (data: ${dataDir})`);

  const server = spawn(process.execPath, [serverEntry], {
    cwd: dirname(serverEntry),
    env,
    stdio: "inherit",
  });

  server.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", () => server.kill("SIGINT"));
  process.on("SIGTERM", () => server.kill("SIGTERM"));

  if (open) {
    waitForServer(url).then((ready) => {
      if (ready) openBrowser(url);
    });
  }
}

async function main(argv) {
  let directive;
  try {
    directive = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(`\nRun \`drydock --help\` for usage.`);
    process.exit(2);
  }

  switch (directive.mode) {
    case "help":
      console.log(HELP);
      return;
    case "version":
      console.log(readVersion());
      return;
    case "update":
      await runUpdate();
      return;
    case "mcp":
      await runMcp();
      return;
    case "backup": {
      const { runBackupCommand } = await import("./ops.mjs");
      process.exit(
        await runBackupCommand(directive.path, {
          dbPath: resolveDbPath(),
          dataDir: resolveDataDir(),
        }),
      );
      return;
    }
    case "restore": {
      const { resolveLockPath, runRestoreCommand } = await import("./ops.mjs");
      process.exit(
        await runRestoreCommand(directive.path, {
          dbPath: resolveDbPath(),
          lockPath: resolveLockPath(),
        }),
      );
      return;
    }
    case "doctor": {
      const { resolveLockPath, runDoctorCommand } = await import("./ops.mjs");
      process.exit(
        await runDoctorCommand({
          dbPath: resolveDbPath(),
          dataDir: resolveDataDir(),
          lockPath: resolveLockPath(),
        }),
      );
      return;
    }
    case "service": {
      const { runServiceCommand } = await import("./ops.mjs");
      process.exit(
        await runServiceCommand(directive.action, {
          platform: process.platform,
          home: homedir(),
          nodePath: process.execPath,
          binPath: fileURLToPath(import.meta.url),
          dataDir: resolveDataDir(),
        }),
      );
      return;
    }
    case "start": {
      const { runStartCommand } = await import("./daemon.mjs");
      process.exit(runStartCommand(directive, await daemonDeps()));
      return;
    }
    case "stop": {
      const { runStopCommand } = await import("./daemon.mjs");
      process.exit(await runStopCommand(directive, await daemonDeps()));
      return;
    }
    case "status": {
      const { runStatusCommand } = await import("./daemon.mjs");
      process.exit(runStatusCommand(directive, await daemonDeps()));
      return;
    }
    case "restart": {
      const { runRestartCommand } = await import("./daemon.mjs");
      process.exit(await runRestartCommand(directive, await daemonDeps()));
      return;
    }
    default:
      await serve(directive);
  }
}

/**
 * Concrete dependencies for the daemon lifecycle commands, resolved against this
 * install's data dir and package root. Bundled here (rather than inside
 * daemon.mjs) so the daemon module stays free of process-level state and fully
 * injectable in tests.
 */
async function daemonDeps() {
  const { resolveDaemonLogPath, resolveDaemonStatePath } = await import("./daemon.mjs");
  const { resolveLockPath } = await import("./ops.mjs");
  return {
    statePath: resolveDaemonStatePath(),
    logPath: resolveDaemonLogPath(),
    lockPath: resolveLockPath(),
    dataDir: resolveDataDir(),
    packageRoot: PACKAGE_ROOT,
  };
}

/**
 * Decide whether this module is the program entry point. A plain string compare
 * against `process.argv[1]` breaks for global/npx installs, where the bin is a
 * symlink in a bin directory and argv[1] is that link rather than the real file.
 * Resolving the entry path through symlinks (realpath) makes the two comparable,
 * so `drydock`, `drydock --version`, etc. actually run when installed.
 *
 * @param {string} modulePath Absolute path to this module (resolved import.meta.url).
 * @param {string | undefined} entryPath The invoked entry path (process.argv[1]).
 */
export function isMainModule(modulePath, entryPath) {
  if (!entryPath) return false;
  try {
    return modulePath === realpathSync(entryPath);
  } catch {
    return false;
  }
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(fileURLToPath(import.meta.url), process.argv[1])) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
