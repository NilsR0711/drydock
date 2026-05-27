import type { GhIssue, IssueComment, IssueDetail, PrCheck } from "@/lib/github/gh";

/**
 * Platform-neutral aliases for the data shapes exchanged with a git forge.
 * The names are GitHub-flavoured for historical reasons; the forge abstraction
 * re-exports them under neutral names so call sites read platform-agnostically.
 */
export type ForgeIssue = GhIssue;
export type { IssueComment, IssueDetail, PrCheck };

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
  commentIssue(issueNumber: number, body: string): Promise<void>;
  createIssue(title: string, body: string): Promise<number>;
  failedRunLog(prNumber: number): Promise<string>;
  mergePr(prNumber: number): Promise<void>;
  createPr(input: { head: string; base: string; title: string; body: string }): Promise<number>;
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
