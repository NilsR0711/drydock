import type { Repo } from "@/lib/db/schema";

/** A repo's automation knobs with the JSON label/author lists already parsed. */
export interface RepoAutomation {
  autoTriageEnabled: boolean;
  autoProcessEnabled: boolean;
  autoHealCi: boolean;
  autoReviewFeedback: boolean;
  mergeWithoutChecks: boolean;
  autoResolveMergeConflicts: boolean;
  includeProgressReplies: boolean;
  autoDecompose: boolean;
  planFirst: boolean;
  verifyPr: boolean;
  autoHealDeployments: boolean;
  releaseEnabled: boolean;
  deploymentPlatform: string | null;
  readyLabels: string[];
  blockingLabels: string[];
  autoLabelWhitelist: string[];
  priorityAuthors: string[];
  trustedReviewers: string[];
  trustedBots: string[];
  ignoredBots: string[];
  minAuthorAssociation: "approved" | "any";
  maxAttempts: number;
}

/** GitHub author associations that count as "approved" (owner/member/collaborator). */
const APPROVED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function parseStringArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Parse a repo row's JSON automation columns into typed arrays. */
export function repoAutomation(repo: Repo): RepoAutomation {
  return {
    autoTriageEnabled: repo.autoTriageEnabled,
    autoProcessEnabled: repo.autoProcessEnabled,
    autoHealCi: repo.autoHealCi,
    autoReviewFeedback: repo.autoReviewFeedback,
    mergeWithoutChecks: repo.mergeWithoutChecks,
    autoResolveMergeConflicts: repo.autoResolveMergeConflicts,
    includeProgressReplies: repo.includeProgressReplies,
    autoDecompose: repo.autoDecompose,
    planFirst: repo.planFirst,
    verifyPr: repo.verifyPr,
    autoHealDeployments: repo.autoHealDeployments,
    releaseEnabled: repo.releaseEnabled,
    deploymentPlatform: repo.deploymentPlatform,
    readyLabels: parseStringArray(repo.readyLabels),
    blockingLabels: parseStringArray(repo.blockingLabels),
    autoLabelWhitelist: parseStringArray(repo.autoLabelWhitelist),
    priorityAuthors: parseStringArray(repo.priorityAuthors),
    trustedReviewers: parseStringArray(repo.trustedReviewers),
    trustedBots: parseStringArray(repo.trustedBots),
    ignoredBots: parseStringArray(repo.ignoredBots),
    minAuthorAssociation: repo.minAuthorAssociation === "any" ? "any" : "approved",
    maxAttempts: repo.maxAttempts,
  };
}

/**
 * Whether an issue's author is allowed to drive automation for this repo.
 * With `minAuthorAssociation: "any"` everyone passes. Otherwise the author
 * must be an owner/member/collaborator; an unknown association (e.g. a forge
 * that doesn't report it) is treated conservatively as not approved.
 */
export function authorAllowed(
  cfg: Pick<RepoAutomation, "minAuthorAssociation">,
  association: string | null | undefined,
): boolean {
  if (cfg.minAuthorAssociation === "any") return true;
  return association != null && APPROVED_ASSOCIATIONS.has(association.toUpperCase());
}
