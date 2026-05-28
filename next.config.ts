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
  // Turbopack (Next 16 default) honours serverExternalPackages, keeping these
  // native modules out of the bundle so their runtime `require` resolves
  // normally — replacing the custom webpack externals we needed under Next 15.
  serverExternalPackages: ["better-sqlite3", "chokidar"],
};

export default nextConfig;
