import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack (Next 16 default) honours serverExternalPackages, keeping these
  // native modules out of the bundle so their runtime `require` resolves
  // normally — replacing the custom webpack externals we needed under Next 15.
  serverExternalPackages: ["better-sqlite3", "chokidar"],
};

export default nextConfig;
