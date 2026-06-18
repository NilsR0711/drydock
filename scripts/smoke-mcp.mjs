#!/usr/bin/env node

// MCP-server smoke test (issue #230). `next build` + `package-mcp.mjs` emit a
// `.next/standalone/mcp-server.cjs` bundle that can compile cleanly yet crash on
// boot — a mis-bundled dependency (zod's class init), or an externalized runtime
// module that fails to resolve from the published layout. Nothing in the unit
// suite boots the real bundle over real stdio, so a broken MCP distribution
// could ship undetected — exactly the gap issue #230 describes (the previous
// release rejected `drydock mcp` outright). This runner spawns the bundle the
// way `drydock mcp` does, completes a real MCP initialize + tools/list handshake
// against a throwaway database, and fails loudly otherwise. Wired into CI and
// `prepublishOnly` so a non-launching MCP server never reaches users.

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** How long to wait for the boot + handshake before declaring failure. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 60_000;

/**
 * Tools the registry must expose. A representative subset (one per area) is
 * enough to prove the server booted and wired its registry — the exhaustive
 * list is asserted by the unit suite (tests/mcp-server.test.ts).
 */
export const REQUIRED_TOOLS = ["list_repos", "list_jobs", "get_settings"];

/**
 * Assert every required tool name is present in the listed set. Throws naming
 * the missing tools so the runner fails with a precise diagnosis. Pure, so the
 * contract is unit-testable without a real server.
 *
 * @param {string[]} listed Tool names the server advertised.
 * @param {string[]} [required] Names that must be present.
 */
export function assertToolsPresent(listed, required = REQUIRED_TOOLS) {
  const have = new Set(listed);
  const missing = required.filter((name) => !have.has(name));
  if (missing.length > 0) {
    throw new Error(`MCP server is missing tools: ${missing.join(", ")}`);
  }
}

/**
 * Reject if `promise` does not settle within `ms`, so a server that boots but
 * never answers (e.g. a polluted stdout) fails fast instead of hanging CI.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Resolve the bundled MCP server emitted by `package-mcp.mjs`. */
export function resolveMcpEntry(root) {
  return join(root, ".next", "standalone", "mcp-server.cjs");
}

/**
 * Decide whether this module is the program entry point. Invoked only directly
 * (`node scripts/smoke-mcp.mjs` / `pnpm smoke:mcp`), never via a bin symlink, so
 * a direct path compare is sufficient. Guards the side effect so importing this
 * module in tests never spawns a server.
 *
 * @param {string} modulePath Absolute path to this module (from import.meta.url).
 * @param {string | undefined} entryPath The invoked entry path (process.argv[1]).
 */
export function isMainModule(modulePath, entryPath) {
  return Boolean(entryPath) && modulePath === entryPath;
}

async function main() {
  const entry = resolveMcpEntry(PACKAGE_ROOT);
  if (!existsSync(entry)) {
    console.error(`MCP bundle not found at ${entry}. Run \`pnpm build\` before the smoke test.`);
    process.exit(1);
  }

  const dbPath = join(tmpdir(), `drydock-mcp-smoke-${process.pid}.db`);
  const cleanup = () => {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  };

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "mcp"],
    cwd: dirname(entry),
    env: {
      ...process.env,
      NODE_ENV: "production",
      DRYDOCK_DB: dbPath,
      DRYDOCK_MIGRATIONS: join(PACKAGE_ROOT, "drizzle"),
    },
    stderr: "inherit",
  });
  const client = new Client({ name: "drydock-mcp-smoke", version: "1.0.0" });

  console.error(`Smoke-booting MCP server (${entry}) …`);
  try {
    await withTimeout(
      (async () => {
        await client.connect(transport);
        const { tools } = await client.listTools();
        assertToolsPresent(tools.map((t) => t.name));
        console.error(`✓ MCP server booted and listed ${tools.length} tools over stdio.`);
      })(),
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
      "MCP handshake",
    );
  } catch (err) {
    console.error(`✗ MCP smoke test failed: ${err instanceof Error ? err.message : String(err)}`);
    await client.close().catch(() => {});
    cleanup();
    process.exit(1);
  }

  await client.close().catch(() => {});
  cleanup();
  process.exit(0);
}

if (isMainModule(fileURLToPath(import.meta.url), process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
