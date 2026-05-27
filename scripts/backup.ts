import { resolve } from "node:path";
import { runBackup } from "../src/lib/backup/backup";

// Standalone backup runner: `pnpm backup` (e.g. via cron/launchd daily).
const dbPath = process.env.DRYDOCK_DB ?? resolve(process.cwd(), "data/drydock.db");
const backupDir = resolve(process.cwd(), "data/backups");
const dest = runBackup(dbPath, backupDir);
console.log(dest ? `backup written: ${dest}` : "no database to back up");
