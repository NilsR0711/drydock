import type {
  GhIssue,
  IssueComment,
  IssueCommentRef,
  IssueDetail,
  PrCheck,
  PrInfo,
  PrMergeState,
  ReactionContent,
  ReviewThread,
  ReviewThreadComment,
} from "@/lib/github/gh";

/**
 * Platform-neutral aliases for the data shapes exchanged with a git forge.
 * The names are GitHub-flavoured for historical reasons; the forge abstraction
 * re-exports them under neutral names so call sites read platform-agnostically.
 */
export type ForgeIssue = GhIssue;
export type {
  IssueComment,
  IssueCommentRef,
  IssueDetail,
  PrCheck,
  PrInfo,
  PrMergeState,
  ReactionContent,
  ReviewThread,
  ReviewThreadComment,
};

/** Supported git forge platforms. */
export type ForgeId = "github" | "gitlab";

export const FORGE_IDS = ["github", "gitlab"] as const satisfies readonly ForgeId[];
export const DEFAULT_FORGE: ForgeId = "github";

export function isForgeId(value: unknown): value is ForgeId {
  return value === "github" || value === "gitlab";
}

/**
 * The platform-independent operations Drydock performs against a forge. Both
 * the GitHub (`gh` CLI) and GitLab (REST API) implementations satisfy this
 * contract, so the orchestrator never depends on a concrete platform.
 *
 * Terminology note: `prNumber` / `pr*` map to a GitLab **Merge Request** iid,
 * and `prChecks` maps to GitLab **pipeline jobs**. Issue/MR numbers are the
 * project-internal numbers users see (GitHub issue number, GitLab `iid`).
 */
export interface ForgeClient {
  listIssues(label: string): Promise<ForgeIssue[]>;
  listAllIssues(): Promise<ForgeIssue[]>;
  viewIssue(issueNumber: number): Promise<IssueDetail>;
  editIssue(issueNumber: number, patch: { title?: string; body?: string }): Promise<void>;
  ensureLabel(name: string, opts?: { color?: string; description?: string }): Promise<void>;
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  removeLabels(issueNumber: number, labels: string[]): Promise<void>;
  closeIssue(issueNumber: number): Promise<void>;
  reopenIssue(issueNumber: number): Promise<void>;
  prChecks(prNumber: number): Promise<PrCheck[]>;
  /** Current head commit SHA of the PR/MR (binds CI auto-heal sessions). */
  prHeadSha(prNumber: number): Promise<string>;
  /**
   * Resolve a PR/MR's coordinates for URL-tracked babysitting (issue #293):
   * state, head branch + SHA, fork flag, and head/base repo slugs. Optional —
   * the tracked-PR feature is gated on a forge implementing it.
   */
  prInfo?(prNumber: number): Promise<PrInfo>;
  /**
   * The commit a merged PR/MR landed as on the target branch, or null when the
   * PR is not merged (or the forge reports none). PRs are squash-merged, so
   * this differs from the head SHA — anything monitoring the default branch
   * (deployment healing) must use this, not `prHeadSha`.
   */
  prMergeCommitSha?(prNumber: number): Promise<string | null>;
  commentIssue(issueNumber: number, body: string): Promise<void>;
  // --- PR-audit comment upsert (issue #168) -------------------------------
  // Optional: forges without them degrade to plain commentIssue posts.
  /** List an issue's comments with stable ids (idempotent comment upsert). */
  listIssueComments?(issueNumber: number): Promise<IssueCommentRef[]>;
  /** Edit one of our prior issue comments in place (idempotent upsert). */
  updateIssueComment?(issueNumber: number, commentId: string, body: string): Promise<void>;
  /** Post a comment on the PR/MR itself (the canonical audit thread, #317). */
  commentPr?(prNumber: number, body: string): Promise<void>;
  /** List a PR/MR's comments with stable ids (idempotent PR comment upsert). */
  listPrComments?(prNumber: number): Promise<IssueCommentRef[]>;
  /** Edit one of our prior PR/MR comments in place (idempotent upsert). */
  updatePrComment?(prNumber: number, commentId: string, body: string): Promise<void>;
  createIssue(title: string, body: string): Promise<number>;
  failedRunLog(prNumber: number): Promise<string>;
  /** The PR/MR's unified diff, or an empty string on any failure (best-effort). */
  prDiff(prNumber: number): Promise<string>;
  mergePr(prNumber: number): Promise<void>;
  createPr(input: { head: string; base: string; title: string; body: string }): Promise<number>;
  /**
   * Re-run the failed jobs of the PR's most recent failed CI run (the CI
   * auto-heal `rerun` action for flaky checks, issue #16). Optional and
   * best-effort: only forges that can re-trigger runs (currently GitHub)
   * implement it. Returns whether a re-run was actually triggered.
   */
  reRunFailedChecks?(prNumber: number): Promise<boolean>;
  /**
   * Refresh rate-limit accounting before a background sweep. Optional and
   * best-effort: only the GitHub forge meters a shared API budget (see the
   * rate-limit governor); other forges omit it.
   */
  refreshRateLimit?(): Promise<void>;

  // --- PR review-feedback lifecycle (issue #18) ---------------------------
  // Optional: only forges that support review threads (currently GitHub)
  // implement these, and the feature is gated on their presence.
  /** List the PR's review threads with their comments and resolution state. */
  listReviewThreads?(prNumber: number): Promise<ReviewThread[]>;
  /** Post a reply on a review thread. */
  replyToReviewThread?(threadId: string, body: string): Promise<void>;
  /** Edit one of our prior replies in place (idempotent status updates). */
  updateReviewComment?(commentId: string, body: string): Promise<void>;
  /** Mark a review thread as resolved. */
  resolveReviewThread?(threadId: string): Promise<void>;
  /** Acknowledge a review comment with a reaction. */
  reactToReviewComment?(commentId: string, content: ReactionContent): Promise<void>;

  // --- Release management (issue #59) -------------------------------------
  // Optional: only forges that support releases (currently GitHub) implement
  // these, and the feature is gated on their presence.
  /** List the repo's published releases (for the latest tag + idempotency). */
  listReleases?(): Promise<ReleaseSummary[]>;
  /** List recently merged pull requests, newest first. */
  listMergedPrs?(limit?: number): Promise<ForgeMergedPr[]>;
  /** Publish a release at a specific commit. */
  createRelease?(input: CreateReleaseInput): Promise<void>;

  // --- Branch & PR janitor (issue #181) ------------------------------------
  // Optional: forges without them skip the corresponding janitor step.
  /** Delete a remote branch. Idempotent: an already-deleted branch succeeds. */
  deleteBranch?(branch: string): Promise<void>;
  /** The PR/MR's merge readiness relative to its base branch. */
  prMergeState?(prNumber: number): Promise<PrMergeState>;
  /** Update the PR/MR branch with its base (GitHub update-branch, GitLab rebase). */
  updatePrBranch?(prNumber: number): Promise<void>;
}

/** A published release as listed from the forge (issue #59). */
export interface ReleaseSummary {
  tagName: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/** A merged pull request considered for inclusion in a release (issue #59). */
export interface ForgeMergedPr {
  number: number;
  title: string;
  /** ISO-8601 merge timestamp. */
  mergedAt: string;
  labels: string[];
}

/** Input to publish a release at a specific commit (issue #59). */
export interface CreateReleaseInput {
  tag: string;
  title: string;
  notes: string;
  /** The commit-ish the tag points at (a merge SHA or the default branch). */
  target: string;
}

/** Connection settings needed to construct a forge client for a repo. */
export interface ForgeConfig {
  /** Absolute path to the local git checkout (cwd for CLI / remote lookup). */
  cwd: string;
  /** Self-hosted API base URL (e.g. https://gitlab.example.com). */
  baseUrl?: string | null;
  /** Personal/project access token for the instance. */
  token?: string | null;
}

/** UI-facing metadata for a forge platform. */
export interface ForgeMeta {
  id: ForgeId;
  label: string;
  /** Whether this forge needs an explicit base URL + token (self-hosted). */
  needsConnection: boolean;
}

const FORGE_META: Record<ForgeId, ForgeMeta> = {
  github: { id: "github", label: "GitHub", needsConnection: false },
  gitlab: { id: "gitlab", label: "GitLab", needsConnection: true },
};

/** UI metadata for every supported forge, in display order. Client-safe: this
 * module imports no Node-only code, so it is importable from React components. */
export function listForges(): ForgeMeta[] {
  return FORGE_IDS.map((id) => FORGE_META[id]);
}

export class ForgeError extends Error {}
