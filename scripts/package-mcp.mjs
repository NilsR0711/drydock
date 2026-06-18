#!/usr/bin/env node

// Bundle the stdio MCP server into the npm distribution (issue #230). The MCP
// modules (`src/lib/mcp/*`, `src/lib/cli.ts`, `scripts/drydock.ts`) are not part
// of the Next.js app graph, so `next build` never traces them into
// `.next/standalone`. Without this step `drydock mcp` has nothing to launch and
// `pnpm mcp` only works from a dev checkout (via tsx). We esbuild the dev MCP
// entry into a single self-contained CommonJS file beside the standalone runtime
// so the published package can spawn it with plain `node`, no TypeScript runtime.
//
// Native modules (`better-sqlite3`, optional `fsevents`) cannot be bundled and
// `zod` must stay external — esbuild mis-orders zod v4's internal class init when
// it is bundled, crashing the server on boot. All three are app dependencies
// already traced into `.next/standalone/node_modules`, so the bundle resolves
// them at runtime from there. Run after `next build` + `package-standalone.mjs`.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Modules left external because they are native or break when bundled (issue #230). */
const EXTERNAL = ["better-sqlite3", "fsevents", "zod"];

/**
 * Build the esbuild options for the MCP server bundle. Pure (no IO) so the
 * contract — entry, output location, format, externals — is unit-testable.
 *
 * @param {{ root: string }} opts Absolute path to the repository root.
 */
export function mcpBuildOptions({ root }) {
  return {
    entryPoints: [join(root, "scripts", "drydock.ts")],
    outfile: join(root, ".next", "standalone", "mcp-server.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: EXTERNAL,
    // Resolve the `@/*` path aliases the MCP modules import through.
    tsconfig: join(root, "tsconfig.json"),
    logLevel: "warning",
  };
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Decide whether this module is the program entry point. Invoked only directly
 * (`node scripts/package-mcp.mjs` / `pnpm build`), never via a bin symlink, so a
 * direct path compare is sufficient. Guards the side effect so importing this
 * module in tests never runs esbuild.
 *
 * @param {string} modulePath Absolute path to this module (from import.meta.url).
 * @param {string | undefined} entryPath The invoked entry path (process.argv[1]).
 */
export function isMainModule(modulePath, entryPath) {
  return Boolean(entryPath) && modulePath === entryPath;
}

async function main() {
  const standalone = join(PACKAGE_ROOT, ".next", "standalone");
  if (!existsSync(standalone)) {
    console.error(
      "`.next/standalone` not found — run `next build` and `package-standalone.mjs` first.",
    );
    process.exit(1);
  }

  const options = mcpBuildOptions({ root: PACKAGE_ROOT });
  await build(options);
  console.log(`Bundled MCP server: ${options.outfile}`);
}

if (isMainModule(fileURLToPath(import.meta.url), process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
