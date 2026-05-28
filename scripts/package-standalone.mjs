#!/usr/bin/env node

// Finish the Next.js standalone build for distribution (issue #12). Next traces
// the server runtime into `.next/standalone` but, by design, does NOT copy the
// static assets (`.next/static`) or `public/` — the server expects them beside
// the traced output. We copy them in so `npx drydock` serves a complete app.
// Idempotent: safe to re-run after every `next build`.

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standalone = join(root, ".next", "standalone");

if (!existsSync(standalone)) {
  console.error(
    '`.next/standalone` not found — run `next build` with `output: "standalone"` first.',
  );
  process.exit(1);
}

cpSync(join(root, ".next", "static"), join(standalone, ".next", "static"), { recursive: true });

const publicDir = join(root, "public");
if (existsSync(publicDir)) {
  cpSync(publicDir, join(standalone, "public"), { recursive: true });
}

// Hard guarantee: the file tracer can over-copy the project root into the
// bundle (it cannot follow our dynamic `process.cwd()` reads). Delete anything
// that must never ship — especially the local `data/` DB (holds GitHub tokens)
// and `.git` — plus dev-only files that bloat the tarball. The published runtime
// loads from `.next/server`, never from these. Idempotent.
const PRUNE = [
  ".git",
  "data",
  "tests",
  "docs",
  "src",
  "coverage",
  "scripts",
  ".env",
  "CLAUDE.md",
  "DRYDOCK_SPEC.md",
  "biome.json",
  "vitest.config.ts",
  "drizzle.config.ts",
  "release-please-config.json",
  "tsconfig.json",
  "tsconfig.tsbuildinfo",
  "postcss.config.mjs",
  "next.config.ts",
  "pnpm-lock.yaml",
];
for (const entry of PRUNE) {
  rmSync(join(standalone, entry), { recursive: true, force: true });
}

console.log("Packaged standalone server: copied static assets and pruned non-runtime files");
