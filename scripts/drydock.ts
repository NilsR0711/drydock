#!/usr/bin/env -S npx tsx

import { runCli } from "../src/lib/cli";

// Standalone Drydock CLI. `drydock mcp` (or `pnpm mcp`) starts the local stdio
// MCP server so any MCP host can drive Drydock (issue #21). Keep stdout clean
// for the MCP host — diagnostics go to stderr.
runCli(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
