import { join } from "node:path";
import {
  contextExists,
  type DeploymentContext,
  type DeploymentPlatformAdapter,
  type DeploymentStatus,
} from "./adapter";

/**
 * Map a `vercel list` line (or whole output) to a normalised status. Vercel
 * prints a status token per deployment (`● Ready`, `● Error`, `● Building`,
 * `● Queued`). A non-zero exit (not logged in, no project) is `not_found`.
 */
export function parseVercelStatus(
  stdout: string,
  exitCode: number,
  ref?: string | null,
): DeploymentStatus {
  if (exitCode !== 0) return "not_found";
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const short = ref ? ref.slice(0, 7) : null;
  // When a ref is given we only trust the line for that commit; if no line
  // mentions it, the deployment for this commit hasn't appeared yet.
  let line: string | undefined;
  if (short) {
    line = lines.find((l) => l.includes(short));
    if (!line) return "not_found";
  } else {
    line = lines.find((l) => /●|ready|error|building|queued|initializing/i.test(l));
  }
  const hay = (line ?? stdout).toLowerCase();
  if (/\berror\b|\bfailed\b|canceled/.test(hay)) return "error";
  if (/\bready\b/.test(hay)) return "ready";
  if (/\bbuilding\b/.test(hay)) return "building";
  if (/\bqueued\b|initializing|deploying/.test(hay)) return "deploying";
  return "not_found";
}

/**
 * Vercel adapter, driven by the `vercel` CLI run in the repo checkout. Detection
 * keys on a committed `vercel.json` or a linked `.vercel` project directory.
 */
export class VercelAdapter implements DeploymentPlatformAdapter {
  readonly id = "vercel" as const;
  readonly label = "Vercel";

  async detect(ctx: DeploymentContext): Promise<boolean> {
    const exists = contextExists(ctx);
    return exists(join(ctx.cwd, "vercel.json")) || exists(join(ctx.cwd, ".vercel"));
  }

  async getStatus(ctx: DeploymentContext): Promise<DeploymentStatus> {
    const res = await ctx.run("vercel", ["list"], ctx.cwd);
    return parseVercelStatus(res.stdout, res.exitCode, ctx.ref);
  }

  async getLogs(ctx: DeploymentContext): Promise<string> {
    const args = ctx.ref ? ["inspect", "--logs", ctx.ref] : ["logs"];
    const res = await ctx.run("vercel", args, ctx.cwd);
    return [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
  }
}
