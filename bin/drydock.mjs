#!/usr/bin/env node

// Drydock terminal launcher (issue #12). Boots the bundled Next.js standalone
// server, applying SQLite migrations into a user data directory on first start,
// and optionally opens the dashboard in the browser. Plain ESM with no build
// step or TypeScript runtime so it works straight from the published tarball.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3737;
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

  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let open = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--open") {
      open = true;
      continue;
    }

    const value = (flag) => {
      const eq = `${flag}=`;
      if (arg.startsWith(eq)) return arg.slice(eq.length);
      const next = argv[i + 1];
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

  return { mode: "serve", host, port, open };
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
  drydock [options]

Options:
  -p, --port <number>   Port to listen on (default: ${DEFAULT_PORT})
  -H, --host <host>     Host to bind to (default: ${DEFAULT_HOST})
      --open            Open the dashboard in your browser once it is ready
  -v, --version         Print the version and exit
  -h, --help            Show this help and exit

Data is stored in ~/.drydock (override with DRYDOCK_DATA_DIR); the database is
created and migrated automatically on first start.`;

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

async function serve({ host, port, open }) {
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
    default:
      await serve(directive);
  }
}

// Only run when executed directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
