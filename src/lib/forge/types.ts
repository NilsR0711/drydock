import type {
  GhIssue,
  IssueComment,
  IssueDetail,
  PrCheck,
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
  IssueDetail,
  PrCheck,
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
  commentIssue(issueNumber: number, body: string): Promise<void>;
  createIssue(title: string, body: string): Promise<number>;
  failedRunLog(prNumber: number): Promise<string>;
  /** The PR/MR's unified diff, or an empty string on any failure (best-effort). */
  prDiff(prNumber: number): Promise<string>;
  mergePr(prNumber: number): Promise<void>;
  createPr(input: { head: string; base: string; title: string; body: string }): Promise<number>;
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
