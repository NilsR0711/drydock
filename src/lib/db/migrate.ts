import { resolve } from "node:path";
import { createDb } from "./client";

// Standalone migration runner: `pnpm db:migrate`.
const path = process.env.AUTOCLAUDE_DB ?? resolve(process.cwd(), "data/autoclaude.db");
createDb(path);
console.log(`migrations applied to ${path}`);
