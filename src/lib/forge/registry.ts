import { createGithubForge } from "./github";
import { GitlabForge } from "./gitlab";
import { DEFAULT_FORGE, type ForgeClient, isForgeId } from "./types";

// Re-export the client-safe metadata so server code can import everything forge
// from one place; React components import these directly from ./types.
export { DEFAULT_FORGE, FORGE_IDS, isForgeId, listForges } from "./types";

/** The repo fields a forge client is built from (subset of the `repos` row). */
export interface ForgeRepo {
  path: string;
  platform?: string | null;
  apiBaseUrl?: string | null;
  apiToken?: string | null;
}

export type ForgeFactory = (repo: ForgeRepo) => ForgeClient;

const defaultFactory: ForgeFactory = (repo) => {
  const platform = isForgeId(repo.platform) ? repo.platform : DEFAULT_FORGE;
  if (platform === "gitlab") {
    return new GitlabForge({ cwd: repo.path, baseUrl: repo.apiBaseUrl, token: repo.apiToken });
  }
  return createGithubForge({ cwd: repo.path });
};

let factory: ForgeFactory = defaultFactory;

/** Construct the forge client for a repo, dispatching on its platform. */
export function getForge(repo: ForgeRepo): ForgeClient {
  return factory(repo);
}

/** Test seam: override (or, with `null`, reset) how forge clients are built. */
export function __setForgeFactory(override: ForgeFactory | null): void {
  factory = override ?? defaultFactory;
}
