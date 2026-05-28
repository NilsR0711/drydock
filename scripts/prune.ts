import { resolve } from "node:path";
import { createDb } from "../src/lib/db/client";
import { parsePruneArgs, pruneOldData } from "../src/lib/db/prune";

// Standalone prune runner: `pnpm db:prune [--days <n>] [--no-vacuum]`
// (e.g. via cron/launchd). Deletes verbose job_events past the retention
// window and VACUUMs the SQLite database to reclaim space (issue #24).
const { days, vacuum } = parsePruneArgs(process.argv.slice(2));
const dbPath = process.env.DRYDOCK_DB ?? resolve(process.cwd(), "data/drydock.db");
const db = createDb(dbPath);
const result = pruneOldData(db, { days, vacuum });
console.log(
  `pruned ${result.jobEventsDeleted} job event(s) older than the retention window` +
    `${result.vacuumed ? "; database vacuumed" : ""}`,
);
