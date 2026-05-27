import { readFileSync } from "node:fs";
import { join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { registerAdr } from "./service";

/**
 * Watch each repo's `docs/adr/` for new markdown ADRs and register them as
 * pending_review (SPEC §6.5). Returns watchers so the orchestrator can close
 * them on shutdown.
 */
export function watchAdrDirs(repos: Array<{ path: string }>): FSWatcher[] {
  return repos.map((repo) => {
    const dir = join(repo.path, "docs/adr");
    // chokidar v4 dropped glob support: watch the dir, filter `.md` here.
    const watcher = chokidar.watch(dir, { ignoreInitial: true, depth: 0 });
    watcher.on("add", (filePath: string) => {
      if (!filePath.endsWith(".md")) return;
      try {
        const content = readFileSync(filePath, "utf8");
        registerAdr({ filePath, content });
      } catch {
        // file vanished between event and read; ignore
      }
    });
    return watcher;
  });
}
