#!/usr/bin/env node

// Drydock dev-server launcher (issue #204). `next dev` defaults to Turbopack,
// whose native (Rust) allocator grew without bound while compiling pages —
// ~108 GB RSS was observed before macOS killed the whole session. This wrapper:
//
//   1. pins the dev server to webpack (`--webpack`), the same compiler the
//      production build already uses (see next.config.ts), sidestepping the
//      Turbopack memory blowup entirely; and
//   2. caps the V8 old-space heap so a runaway dev server fails fast with a
//      recoverable Node OOM instead of taking the host down with it.
//
// Plain ESM with no build step, mirroring bin/drydock.mjs, so the pure helpers
// stay unit-testable.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3737;

/**
 * Default cap (in MiB) for the dev server's V8 old-space heap. 4 GiB is far more
 * than a healthy webpack dev compile needs, yet low enough that a runaway leak
 * trips a recoverable Node OOM long before it can exhaust the host's RAM.
 */
export const DEFAULT_DEV_HEAP_MB = 4096;

/**
 * Resolve the heap cap (in MiB) for the dev server. Operators can raise or lower
 * it via DRYDOCK_DEV_HEAP_MB; any non-positive or unparseable value falls back
 * to the safe default rather than disabling the guardrail.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function resolveDevHeapMb(env = process.env) {
  const parsed = Number.parseInt(env.DRYDOCK_DEV_HEAP_MB ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DEV_HEAP_MB;
}

/**
 * Build the child environment for `next dev`, adding the V8 heap cap to
 * NODE_OPTIONS. Any existing NODE_OPTIONS is preserved; an explicit
 * `--max-old-space-size` the operator already set is left untouched so they can
 * override the guardrail deliberately. The input env is never mutated.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, string | undefined>}
 */
export function buildDevEnv(env = process.env) {
  const flag = `--max-old-space-size=${resolveDevHeapMb(env)}`;
  const existing = env.NODE_OPTIONS?.trim();
  let nodeOptions;
  if (!existing) {
    nodeOptions = flag;
  } else if (existing.includes("--max-old-space-size")) {
    nodeOptions = existing;
  } else {
    nodeOptions = `${existing} ${flag}`;
  }
  return { ...env, NODE_OPTIONS: nodeOptions };
}

/**
 * Build the `next` CLI arguments for the dev server. Forces the webpack compiler
 * (never Turbopack) and binds to the loopback dashboard host/port by default.
 *
 * @param {{ host?: string, port?: number | string }} [opts]
 * @returns {string[]}
 */
export function buildDevArgs({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  return ["dev", "--webpack", "-H", host, "-p", String(port)];
}

/**
 * Decide whether this module is the program entry point. Resolving the invoked
 * entry path through symlinks (realpath) keeps the comparison correct even when
 * the script is reached via a link. Mirrors bin/drydock.mjs.
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
  const child = spawn("next", buildDevArgs(), {
    stdio: "inherit",
    env: buildDevEnv(),
    // On Windows the `next` binary is a `.cmd` shim that needs a shell to run.
    shell: process.platform === "win32",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    console.error(`Failed to start the dev server: ${err.message}`);
    process.exit(1);
  });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}
