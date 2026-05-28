import {
  type DeploymentContext,
  type DeploymentPlatformAdapter,
  type DeploymentPlatformId,
  isDeploymentPlatformId,
} from "./adapter";
import { RailwayAdapter } from "./railway";
import { VercelAdapter } from "./vercel";

export type { DeploymentPlatformId } from "./adapter";
export { DEPLOYMENT_PLATFORM_IDS, isDeploymentPlatformId } from "./adapter";

/**
 * The ordered list of concrete adapters. Detection tries them in order and
 * takes the first match, so a repo configured for two platforms resolves
 * deterministically. Adding a platform is a one-line edit here (ADR 021).
 */
const ADAPTERS: readonly DeploymentPlatformAdapter[] = [new VercelAdapter(), new RailwayAdapter()];

/** Construct the adapter for a platform id. */
export function getDeploymentAdapter(id: DeploymentPlatformId): DeploymentPlatformAdapter {
  const adapter = ADAPTERS.find((a) => a.id === id);
  if (!adapter) throw new Error(`unsupported deployment platform: ${id}`);
  return adapter;
}

/** UI-facing metadata for every supported deployment platform, in order. */
export function listDeploymentPlatforms(): { id: DeploymentPlatformId; label: string }[] {
  return ADAPTERS.map((a) => ({ id: a.id, label: a.label }));
}

/**
 * Resolve which platform deploys the repo. An explicit per-repo `override`
 * wins (no detection); otherwise each adapter's `detect` runs against the
 * checkout and the first match is returned. `null` means no platform was found
 * (the repo is simply not monitored).
 */
export async function detectDeploymentPlatform(
  ctx: DeploymentContext,
  override?: string | null,
): Promise<DeploymentPlatformAdapter | null> {
  if (override) {
    return isDeploymentPlatformId(override) ? getDeploymentAdapter(override) : null;
  }
  for (const adapter of ADAPTERS) {
    if (await adapter.detect(ctx)) return adapter;
  }
  return null;
}
