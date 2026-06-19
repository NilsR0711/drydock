import { type DB, getDb } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import type { Repo, TrackedPr } from "@/lib/db/schema";
import { parsePrUrl } from "@/lib/forge/pr-url";
import { getForge } from "@/lib/forge/registry";
import type { ForgeClient } from "@/lib/forge/types";
import { trackPr, updateTrackedPr } from "./service";

/**
 * Resolve an operator-pasted PR URL into a tracked-PR record (issue #293). The
 * URL is parsed for its `{slug, prNumber}`, validated against the repo's actual
 * PR via the forge (so a wrong repo/URL pairing is rejected up front rather than
 * silently tracking the wrong PR number), and the record is pre-populated with
 * the live head/fork/ownership state so the dashboard is correct immediately.
 */
export interface AddTrackedPrDeps {
  db?: DB;
  forgeFor?: (repo: Repo) => ForgeClient;
}

export async function addTrackedPrByUrl(
  input: { repoId: number; url: string; autoMerge?: boolean },
  deps: AddTrackedPrDeps = {},
): Promise<TrackedPr> {
  const db = deps.db ?? getDb();
  const repo = getRepo(input.repoId, db);
  if (!repo) throw new Error(`repo ${input.repoId} not found`);

  const parsed = parsePrUrl(input.url);
  if (!parsed) throw new Error(`not a valid pull-request URL: ${input.url}`);
  if (parsed.platform !== repo.platform) {
    throw new Error(
      `PR URL is a ${parsed.platform} link but repo ${repo.name} is a ${repo.platform} repo`,
    );
  }

  const forge = deps.forgeFor?.(repo) ?? getForge(repo);
  if (!forge.prInfo) {
    throw new Error(`the ${repo.platform} forge does not support tracking PRs by URL`);
  }
  const info = await forge.prInfo(parsed.prNumber);
  if (info.baseSlug.toLowerCase() !== parsed.slug.toLowerCase()) {
    throw new Error(
      `PR #${parsed.prNumber} belongs to ${info.baseSlug}, not ${parsed.slug} (repo ${repo.name})`,
    );
  }

  const tracked = trackPr(
    {
      repoId: repo.id,
      prNumber: parsed.prNumber,
      url: input.url,
      platform: parsed.platform,
      autoMerge: input.autoMerge,
    },
    db,
  );
  // Pre-populate the live coordinates so the record is accurate before the
  // first sweep runs.
  return updateTrackedPr(
    tracked.id,
    {
      branch: info.headRefName,
      headSlug: info.headSlug,
      baseSlug: info.baseSlug,
      isFork: info.isCrossRepository,
      owned: !info.isCrossRepository,
      headSha: info.headSha,
      title: info.title,
      author: info.author,
    },
    db,
  );
}
