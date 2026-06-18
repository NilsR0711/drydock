import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Self-contained server bundle for `npx drydock`: traces the minimal runtime
  // into `.next/standalone` so the published package ships without node_modules
  // ballast (issue #12). Static assets are copied in afterwards by
  // scripts/package-standalone.mjs.
  output: "standalone",
  // Pin the file-tracing root to this project so the standalone output lands at
  // `.next/standalone/server.js`. Without it Next infers an ancestor directory
  // (it found an outer lockfile) and nests the bundle under a subfolder.
  outputFileTracingRoot: projectRoot,
  // Runtime DB/migration reads use dynamic `process.cwd()` paths that the file
  // tracer cannot follow, so it conservatively copies the whole project root
  // into the standalone bundle — including dev-only dirs and, critically, the
  // local `data/` DB (which holds tokens) and `.git`. Exclude them from the
  // traced output; scripts/package-standalone.mjs prunes any survivors as a
  // hard guarantee before publish (issue #12).
  outputFileTracingExcludes: {
    "*": [
      ".git/**",
      "data/**",
      "tests/**",
      "docs/**",
      "src/**",
      "coverage/**",
      "*.test.*",
    ],
  },
  // Keep these native modules external (not bundled) so their runtime `require`
  // resolves the real addon. NOTE: the production build runs `next build
  // --webpack` (see package.json), NOT Turbopack — Turbopack references an
  // external like better-sqlite3 by a hashed module id (`better-sqlite3-<hash>`)
  // that is unresolvable in the published standalone bundle, while webpack emits
  // a plain `require("better-sqlite3")` that resolves from the traced
  // node_modules. Dev runs on webpack too — via `scripts/dev.mjs`, which also
  // caps the heap — because Turbopack's dev server grew its memory without
  // bound and could crash the host (issue #204).
  serverExternalPackages: ["better-sqlite3", "chokidar"],
};

export default nextConfig;
