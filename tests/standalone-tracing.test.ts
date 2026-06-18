import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

// Guards the fix for issue #209. Next 16.2.x's file tracer drops
// `next/dist/lib/metadata/get-metadata-route` (and its siblings) from the
// `output: "standalone"` bundle even though `router-utils/filesystem.js`
// statically requires it, so `node .next/standalone/server.js` crashed on boot
// with MODULE_NOT_FOUND. We force the metadata runtime into the trace via
// outputFileTracingIncludes; if this regresses the standalone server stops
// booting. The CI/prepublish smoke test is the behavioural backstop.

describe("standalone file tracing (issue #209)", () => {
  it("force-includes the metadata runtime the tracer otherwise drops", () => {
    const includes = nextConfig.outputFileTracingIncludes;
    expect(includes).toBeDefined();
    const globs = includes?.["*"] ?? [];
    expect(globs.some((glob) => /next\/dist\/lib\/metadata\//.test(glob))).toBe(true);
  });
});
