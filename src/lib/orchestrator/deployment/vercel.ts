import { join } from "node:path";
import {
  contextExists,
  type DeploymentContext,
  type DeploymentPlatformAdapter,
  type DeploymentStatus,
} from "./adapter";

/**
 * Map `vercel list` output to a normalised status. Vercel prints a status
 * token per deployment (`● Ready`, `● Error`, `● Building`, `● Queued`). The
 * caller scopes the list to the commit under watch via
 * `--meta githubCommitSha=<sha>` (the table itself carries no git SHAs), so
 * the first deployment line is the one that matters; output without any
 * deployment line means the commit's deployment has not appeared yet. A
 * non-zero exit (not logged in, no project) is `not_found`.
 */
export function parseVercelStatus(stdout: string, exitCode: number): DeploymentStatus {
  if (exitCode !== 0) return "not_found";
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // Status words can also appear inside the deployment URL (e.g.
  // https://ready-app.vercel.app), so classification must never read the URL:
  // strip URLs from the line before matching.
  const withoutUrls = (l: string) => l.replace(/https?:\/\/\S+/g, " ");
  const line = lines.find((l) =>
    /●|ready|error|building|queued|initializing/i.test(withoutUrls(l)),
  );
  if (!line) return "not_found";
  const hay = withoutUrls(line).toLowerCase();
  if (/\berror\b|\bfailed\b|canceled/.test(hay)) return "error";
  if (/\bready\b/.test(hay)) return "ready";
  if (/\bbuilding\b/.test(hay)) return "building";
  if (/\bqueued\b|initializing|deploying/.test(hay)) return "deploying";
  return "not_found";
}

/**
 * Extract the deployment URL from a (commit-scoped) `vercel list` table, so
 * logs can be fetched via `vercel inspect --logs <url>` — the inspect command
 * takes a deployment URL/id, never a git SHA.
 */
export function parseVercelDeploymentUrl(stdout: string): string | null {
  return stdout.match(/https?:\/\/\S+/)?.[0] ?? null;
}

/** Scope `vercel list` to the deployments of one commit. */
function listArgs(ref: string | null | undefined): string[] {
  return ref ? ["list", "--meta", `githubCommitSha=${ref}`] : ["list"];
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
    const res = await ctx.run("vercel", listArgs(ctx.ref), ctx.cwd);
    return parseVercelStatus(res.stdout, res.exitCode);
  }

  async getLogs(ctx: DeploymentContext): Promise<string> {
    // Resolve the commit's deployment URL first: `vercel inspect` rejects git
    // SHAs, so the previous `inspect --logs <gitSha>` could never succeed.
    let target: string | null = null;
    if (ctx.ref) {
      const list = await ctx.run("vercel", listArgs(ctx.ref), ctx.cwd);
      if (list.exitCode === 0) target = parseVercelDeploymentUrl(list.stdout);
    }
    const args = target ? ["inspect", "--logs", target] : ["logs"];
    const res = await ctx.run("vercel", args, ctx.cwd);
    return [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
  }
}
