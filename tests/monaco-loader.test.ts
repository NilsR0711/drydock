import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configureMonaco, type MonacoWorkerHost } from "@/lib/monaco/configure";

// Issue #429: `@monaco-editor/react` fetches `monaco-editor` from cdn.jsdelivr.net
// at runtime unless the loader is pointed at the locally bundled package. These
// tests pin the two guarantees that make the /prompts editor work offline:
//   1. the loader is handed the bundled monaco instance, and its workers run
//      through a bundled factory (no CDN); verified on the pure, injectable core.
//   2. no source module ever imports the editor without applying that config,
//      which would silently re-enable the CDN default.

describe("configureMonaco (issue #429)", () => {
  it("hands the loader the bundled monaco instance instead of the CDN default", () => {
    const config = vi.fn();
    const monaco = { marker: "local-bundled-monaco" };
    const host: MonacoWorkerHost = {};

    configureMonaco({ config }, monaco, () => ({}) as Worker, host);

    expect(config).toHaveBeenCalledTimes(1);
    expect(config).toHaveBeenCalledWith({ monaco });
  });

  it("routes Monaco's web workers through the injected bundled factory", () => {
    const worker = {} as Worker;
    const createWorker = vi.fn(() => worker);
    const host: {
      MonacoEnvironment?: { getWorker?: (workerId: string, label: string) => Worker };
    } = {};

    configureMonaco({ config: vi.fn() }, {}, createWorker, host);

    expect(host.MonacoEnvironment?.getWorker).toBeTypeOf("function");
    // The worker must be created lazily — only when Monaco actually asks for one.
    expect(createWorker).not.toHaveBeenCalled();

    const produced = host.MonacoEnvironment?.getWorker?.("1", "editorWorkerService");
    expect(produced).toBe(worker);
    expect(createWorker).toHaveBeenCalledTimes(1);
  });
});

describe("Monaco is served from the bundle, never the jsdelivr CDN (issue #429)", () => {
  function collectSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...collectSourceFiles(full));
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  it("every module that imports @monaco-editor/react applies the local loader config", () => {
    const srcRoot = join(process.cwd(), "src");
    // A value import (not `import type`) of the editor pulls in the loader, whose
    // default resolves monaco from cdn.jsdelivr.net. Such a module must call
    // configureMonaco(...) or the CDN sneaks back in.
    const valueImport = /^\s*import(?!\s+type\b)[^\n]*from\s+["']@monaco-editor\/react["']/m;
    const offenders = collectSourceFiles(srcRoot).filter((file) => {
      const text = readFileSync(file, "utf8");
      return valueImport.test(text) && !text.includes("configureMonaco(");
    });

    expect(offenders).toEqual([]);
  });
});
