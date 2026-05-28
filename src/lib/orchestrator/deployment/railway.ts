import { join } from "node:path";
import {
  contextExists,
  type DeploymentContext,
  type DeploymentPlatformAdapter,
  type DeploymentStatus,
} from "./adapter";

/**
 * Map `railway status` output to a normalised status. Railway reports a
 * deployment state token (`SUCCESS`, `FAILED`/`CRASHED`, `BUILDING`,
 * `DEPLOYING`/`INITIALIZING`/`QUEUED`). A non-zero exit (not linked, not logged
 * in) is `not_found`.
 */
export function parseRailwayStatus(stdout: string, exitCode: number): DeploymentStatus {
  if (exitCode !== 0) return "not_found";
  const hay = stdout.toLowerCase();
  if (/\bfailed\b|\bcrashed\b|\berror\b/.test(hay)) return "error";
  if (/\bsuccess\b|\bdeployed\b|\bready\b/.test(hay)) return "ready";
  if (/\bbuilding\b/.test(hay)) return "building";
  if (/\bdeploying\b|\binitializing\b|\bqueued\b/.test(hay)) return "deploying";
  return "not_found";
}

/**
 * Railway adapter, driven by the `railway` CLI run in the repo checkout.
 * Detection keys on a committed `railway.json`/`railway.toml` or a linked
 * `.railway` directory.
 */
export class RailwayAdapter implements DeploymentPlatformAdapter {
  readonly id = "railway" as const;
  readonly label = "Railway";

  async detect(ctx: DeploymentContext): Promise<boolean> {
    const exists = contextExists(ctx);
    return (
      exists(join(ctx.cwd, "railway.json")) ||
      exists(join(ctx.cwd, "railway.toml")) ||
      exists(join(ctx.cwd, ".railway"))
    );
  }

  async getStatus(ctx: DeploymentContext): Promise<DeploymentStatus> {
    const res = await ctx.run("railway", ["status"], ctx.cwd);
    return parseRailwayStatus(res.stdout, res.exitCode);
  }

  async getLogs(ctx: DeploymentContext): Promise<string> {
    const res = await ctx.run("railway", ["logs"], ctx.cwd);
    return [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
  }
}
