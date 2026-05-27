import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // instrumentation.ts is loaded by default in Next 15; the orchestrator singleton starts there.
  serverExternalPackages: ["better-sqlite3", "chokidar"],
};

export default nextConfig;
