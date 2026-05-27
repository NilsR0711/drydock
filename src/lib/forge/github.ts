import type { CommandRunner } from "@/lib/exec/runner";
import { GhClient } from "@/lib/github/gh";
import type { ForgeClient, ForgeConfig } from "./types";

/**
 * GitHub forge implementation. Behaviour-preserving wrapper: the existing
 * `gh` CLI client (`GhClient`) already satisfies the `ForgeClient` contract, so
 * this is a thin factory that keeps the GitHub code path unchanged.
 */
export function createGithubForge(config: ForgeConfig, run?: CommandRunner): ForgeClient {
  return new GhClient(config.cwd, run);
}
