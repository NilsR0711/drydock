import { resolve } from "node:path";
import { createDb } from "./client";

// Standalone migration runner: `pnpm db:migrate`.
const path = process.env.DRYDOCK_DB ?? resolve(process.cwd(), "data/drydock.db");
createDb(path);
console.log(`migrations applied to ${path}`);
