#!/usr/bin/env node

// Standalone-server smoke test (issue #209). `next build` can emit a
// `.next/standalone` bundle that compiles cleanly yet crashes the moment you
// run `node server.js`, because the Next file tracer silently drops a runtime
// module it cannot follow (here `next/dist/lib/metadata/get-metadata-route`).
// Nothing in `next build`, typecheck, or the unit suite exercises a real boot,
// so a broken bundle shipped to npm undetected. This runner boots the actual
// bundle, waits for it to serve the homepage, and fails loudly otherwise — wired
// into CI and `prepublishOnly` so a non-booting bundle never reaches users.

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Default port for the smoke boot; high enough to avoid the dev/app default. */
export const DEFAULT_SMOKE_PORT = 3939;

/** How long to wait for the server to start serving before declaring failure. */
export const DEFAULT_SMOKE_TIMEOUT_MS = 60_000;

/** How often to re-probe the server while waiting for it to come up. */
const POLL_INTERVAL_MS = 300;

/**
 * Parse the smoke runner's CLI flags into a directive. Throws an Error with a
 * human-readable message on invalid input so the caller can print it and exit.
 *
 * @param {string[]} argv
 */
export function parseSmokeArgs(argv) {
  let port = DEFAULT_SMOKE_PORT;
  let readyTimeoutMs = DEFAULT_SMOKE_TIMEOUT_MS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    const value = (flag) => {
      const eq = `${flag}=`;
      if (arg.startsWith(eq)) return arg.slice(eq.length);
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`missing value for ${flag}`);
      i++;
      return next;
    };

    if (arg === "--port" || arg.startsWith("--port=")) {
      port = parsePort(value("--port"));
      continue;
    }
    if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      readyTimeoutMs = parsePositiveInt(value("--timeout"), "timeout");
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return { host: "127.0.0.1", port, path: "/", readyTimeoutMs };
}

function parsePort(raw) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: "${raw}" (expected an integer between 1 and 65535)`);
  }
  return port;
}

function parsePositiveInt(raw, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`invalid ${label}: "${raw}" (expected a positive integer of milliseconds)`);
  }
  return value;
}

/**
 * True when captured server output carries a Node module-resolution crash — the
 * exact signature of issue #209's missing traced module. Lets the runner fail
 * fast with a precise diagnosis instead of waiting out the full timeout.
 *
 * @param {string} text
 */
export function isFatalServerError(text) {
  return /Cannot find module|MODULE_NOT_FOUND/.test(text);
}

/**
 * Build the child environment that boots the standalone server against an
 * isolated, throwaway database so the smoke run never touches real state.
 *
 * @param {{ host: string, port: number, dbPath: string, migrationsDir: string,
 *   baseEnv?: Record<string, string | undefined> }} opts
 */
export function buildSmokeEnv({ host, port, dbPath, migrationsDir, baseEnv = process.env }) {
  return {
    ...baseEnv,
    NODE_ENV: "production",
    HOSTNAME: host,
    PORT: String(port),
    DRYDOCK_DB: dbPath,
    DRYDOCK_MIGRATIONS: migrationsDir,
  };
}

/**
 * Decide whether this module is the program entry point. This runner is only
 * ever invoked directly (`node scripts/smoke-standalone.mjs` / `pnpm smoke`),
 * never through a bin symlink, so a direct path compare is sufficient. Guards
 * the side effect: importing this module in tests must not spawn a server.
 *
 * @param {string} modulePath Absolute path to this module (from import.meta.url).
 * @param {string | undefined} entryPath The invoked entry path (process.argv[1]).
 */
export function isMainModule(modulePath, entryPath) {
  return Boolean(entryPath) && modulePath === entryPath;
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Poll the URL until it answers with HTTP 200, the server crashes, or we time
 * out. A non-200 is treated as "not ready yet" and re-probed — the server can
 * briefly answer with a transient status while warming up — so the runner never
 * fails on a first flaky probe. On timeout it reports the last status seen (or
 * "timeout" if the server never answered at all). The clock, sleep, and fetch
 * are injectable so the polling contract can be unit-tested deterministically.
 *
 * @param {string} url
 * @param {{ readyTimeoutMs: number, isAlive: () => boolean, hasCrashed: () => boolean,
 *   pollIntervalMs?: number, fetchImpl?: (url: string) => Promise<{ status: number }>,
 *   now?: () => number, sleep?: (ms: number) => Promise<void> }} opts
 */
export async function waitUntilServed(
  url,
  {
    readyTimeoutMs,
    isAlive,
    hasCrashed,
    pollIntervalMs = POLL_INTERVAL_MS,
    fetchImpl = fetch,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  },
) {
  const deadline = now() + readyTimeoutMs;
  let lastStatusReason;
  while (now() < deadline) {
    if (hasCrashed()) return { ok: false, reason: "crash" };
    if (!isAlive()) return { ok: false, reason: "exited" };
    try {
      const res = await fetchImpl(url);
      if (res.status === 200) return { ok: true };
      lastStatusReason = `status ${res.status}`;
    } catch {
      // Server not accepting connections yet — keep waiting.
    }
    await sleep(pollIntervalMs);
  }
  return { ok: false, reason: lastStatusReason ?? "timeout" };
}

async function main(argv) {
  let directive;
  try {
    directive = parseSmokeArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  const serverEntry = join(PACKAGE_ROOT, ".next", "standalone", "server.js");
  if (!existsSync(serverEntry)) {
    console.error(
      `Standalone bundle not found at ${serverEntry}. Run \`pnpm build\` before the smoke test.`,
    );
    process.exit(1);
  }

  const dbPath = join(tmpdir(), `drydock-smoke-${process.pid}.db`);
  const env = buildSmokeEnv({
    host: directive.host,
    port: directive.port,
    dbPath,
    migrationsDir: join(PACKAGE_ROOT, "drizzle"),
  });

  const url = `http://${directive.host}:${directive.port}${directive.path}`;
  console.error(`Smoke-booting standalone server on ${url} …`);

  let output = "";
  let crashed = false;
  let exited = false;
  const server = spawn(process.execPath, [serverEntry], {
    cwd: dirname(serverEntry),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk) => {
    const text = chunk.toString();
    output += text;
    if (isFatalServerError(output)) crashed = true;
  };
  server.stdout.on("data", capture);
  server.stderr.on("data", capture);
  server.on("exit", () => {
    exited = true;
  });

  const cleanup = () => {
    server.kill("SIGTERM");
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  };

  const result = await waitUntilServed(url, {
    readyTimeoutMs: directive.readyTimeoutMs,
    isAlive: () => !exited,
    hasCrashed: () => crashed,
  });
  cleanup();

  if (result.ok) {
    console.error(`✓ Standalone server booted and served ${url} (HTTP 200).`);
    process.exit(0);
  }

  console.error(`✗ Standalone smoke test failed (${result.reason}).`);
  if (output.trim()) console.error(`--- server output ---\n${output.trim()}`);
  process.exit(1);
}

if (isMainModule(fileURLToPath(import.meta.url), process.argv[1])) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
