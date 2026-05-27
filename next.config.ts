import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // instrumentation.ts is loaded by default in Next 15; the orchestrator singleton starts there.
  serverExternalPackages: ["better-sqlite3", "chokidar"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Keep native/`bindings`-based modules out of the webpack graph so their
      // `require('fs')` resolves at runtime instead of being bundled.
      const externals = ["better-sqlite3", "bindings", "chokidar"];
      config.externals = Array.isArray(config.externals)
        ? [...config.externals, ...externals]
        : [config.externals, ...externals];
    }
    return config;
  },
};

export default nextConfig;
