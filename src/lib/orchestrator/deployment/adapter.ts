import { existsSync } from "node:fs";
import type { CommandRunner } from "@/lib/exec/runner";

/**
 * Post-merge deployment healing (issue #20). A pluggable adapter speaks to one
 * hosting platform's CLI to answer three questions about the deployment of a
 * merged commit: does this platform deploy this repo, what is the deployment's
 * status, and what do its logs say. Adding a platform means implementing one
 * adapter and registering it — the orchestrator never depends on a concrete
 * platform (see ADR 021).
 */

/** Normalised deployment lifecycle states, platform-independent. */
export const DEPLOYMENT_STATUSES = [
  "building",
  "deploying",
  "ready",
  "error",
  "not_found",
] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/** Platforms with a concrete adapter. Netlify/Fly/Render can be added here. */
export const DEPLOYMENT_PLATFORM_IDS = ["vercel", "railway"] as const;

export type DeploymentPlatformId = (typeof DEPLOYMENT_PLATFORM_IDS)[number];

export function isDeploymentPlatformId(value: unknown): value is DeploymentPlatformId {
  return (DEPLOYMENT_PLATFORM_IDS as readonly unknown[]).includes(value);
}

/**
 * Everything an adapter needs to act, all injectable so adapters are testable
 * without touching the real filesystem or spawning a CLI:
 * - `cwd`: the repo checkout (CLIs are run here; files are probed relative to it)
 * - `ref`: the merged commit SHA whose deployment we're asking about
 * - `run`: command runner (production = spawnRunner; tests inject a fake)
 * - `exists`: file-existence probe used by `detect` (defaults to fs.existsSync)
 */
export interface DeploymentContext {
  cwd: string;
  ref?: string | null;
  run: CommandRunner;
  exists?: (path: string) => boolean;
}

export interface DeploymentPlatformAdapter {
  readonly id: DeploymentPlatformId;
  readonly label: string;
  /** Whether this platform deploys the repo at `ctx.cwd`. */
  detect(ctx: DeploymentContext): Promise<boolean>;
  /** Current status of the deployment for `ctx.ref` (or the latest). */
  getStatus(ctx: DeploymentContext): Promise<DeploymentStatus>;
  /** Recent deployment logs (build/runtime), best-effort and possibly empty. */
  getLogs(ctx: DeploymentContext): Promise<string>;
}

/** The file-existence probe for an adapter's `detect`, defaulting to fs. */
export function contextExists(ctx: DeploymentContext): (path: string) => boolean {
  return ctx.exists ?? existsSync;
}
