import { z } from "zod";
import { type CommandRunner, spawnRunner } from "@/lib/exec/runner";
import { logError } from "@/lib/log/logger";
import { fetchHttp, type HttpClient, type HttpResponse } from "./http";
import {
  type ForgeClient,
  type ForgeConfig,
  ForgeError,
  type ForgeIssue,
  type IssueDetail,
  type PrCheck,
} from "./types";
import { assertSafeForgeUrl, privateForgeAllowedFromEnv } from "./url-guard";

/** Fallback backoff window for a GitLab 429 with no usable reset header (ms). */
const DEFAULT_GITLAB_BACKOFF_MS = 60_000;

/** Maximum sleep duration for a single 429 backoff (5 minutes). */
const MAX_GITLAB_BACKOFF_MS = 300_000;

/**
 * Derive how long to back off after a GitLab 429 response. Prefers
 * `Retry-After` (seconds), then `RateLimit-Reset` (epoch seconds), then
 * falls back to {@link DEFAULT_GITLAB_BACKOFF_MS}.
 */
export function parseGitLabRetryAfterMs(headers?: Record<string, string>): number {
  if (headers) {
    const retryAfter = headers["retry-after"];
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.min(seconds * 1000, MAX_GITLAB_BACKOFF_MS);
      }
    }
    const reset = headers["ratelimit-reset"] ?? headers["x-ratelimit-reset"];
    if (reset) {
      const resetEpochSec = Number(reset);
      if (Number.isFinite(resetEpochSec)) {
        const waitMs = resetEpochSec * 1000 - Date.now();
        if (waitMs > 0) return Math.min(waitMs, MAX_GITLAB_BACKOFF_MS);
      }
    }
  }
  return DEFAULT_GITLAB_BACKOFF_MS;
}

const gitlabIssueSchema = z.object({
  iid: z.number(),
  title: z.string(),
  labels: z.array(z.string()).default([]),
  author: z.object({ username: z.string() }).nullish(),
});

const gitlabIssueDetailSchema = z.object({
  iid: z.number(),
  title: z.string(),
  description: z.string().nullable().default(""),
  state: z.string().default("opened"),
  labels: z.array(z.string()).default([]),
});

const gitlabNoteSchema = z.object({
  author: z.object({ username: z.string().default("") }).default({ username: "" }),
  body: z.string().default(""),
  created_at: z.string().default(""),
  system: z.boolean().default(false),
});

const gitlabJobSchema = z.object({
  id: z.number().optional(),
  name: z.string().default(""),
  status: z.string().default(""),
});

const gitlabMrHeadPipelineSchema = z.object({
  head_pipeline: z.object({ id: z.number() }).nullable().optional(),
});

const gitlabDiffSchema = z.object({
  old_path: z.string().default(""),
  new_path: z.string().default(""),
  diff: z.string().default(""),
});

interface ProjectRef {
  baseUrl: string;
  encodedPath: string;
}

/**
 * Hard cap on the number of issue-list pages followed in a single fetch. At 100
 * issues per page this bounds a sweep at 10k open issues — far above any real
 * project — so a misbehaving `X-Next-Page` header can never spin the loop
 * indefinitely.
 */
export const MAX_ISSUE_PAGES = 100;

/** Map a GitLab CI job status onto the uppercase state vocabulary the CI
 * babysitter's `classifyChecks` understands (FAILURE/pending/passed buckets). */
function mapJobStatus(status: string): string {
  switch (status) {
    case "success":
      return "SUCCESS";
    case "failed":
      return "FAILURE";
    case "canceled":
    case "cancelled":
      return "CANCELLED";
    case "running":
      return "IN_PROGRESS";
    case "pending":
    case "created":
    case "scheduled":
    case "preparing":
    case "waiting_for_resource":
      return "PENDING";
    case "manual":
      return "MANUAL";
    case "skipped":
      return "SKIPPED";
    default:
      return status.toUpperCase();
  }
}

/** Parse a git remote URL into its host and project path (sans `.git`). */
function parseRemote(remote: string): { host: string; path: string } {
  const r = remote.trim().replace(/\.git$/, "");
  const match =
    r.match(/^[\w.-]+@([^:]+):(.+)$/) ?? // git@host:group/proj
    r.match(/^ssh:\/\/[^@]+@([^/]+)\/(.+)$/) ?? // ssh://git@host/group/proj
    r.match(/^https?:\/\/([^/]+)\/(.+)$/); // https://host/group/proj
  if (!match?.[1] || !match[2]) throw new ForgeError(`unsupported git remote URL: ${remote}`);
  return { host: match[1], path: match[2] };
}

/** Forge client backed by the GitLab REST API (v4); works against gitlab.com
 * and self-hosted instances via a configurable base URL + access token. */
export class GitlabForge implements ForgeClient {
  private readonly http: HttpClient;
  private readonly run: CommandRunner;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly allowPrivateHost: boolean;
  private projectRef?: Promise<ProjectRef>;

  constructor(
    private readonly config: ForgeConfig,
    deps: {
      http?: HttpClient;
      run?: CommandRunner;
      sleep?: (ms: number) => Promise<void>;
      allowPrivateHost?: boolean;
    } = {},
  ) {
    this.http = deps.http ?? fetchHttp;
    this.run = deps.run ?? spawnRunner;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.allowPrivateHost = deps.allowPrivateHost ?? privateForgeAllowedFromEnv();
  }

  private resolveProject(): Promise<ProjectRef> {
    if (!this.projectRef) {
      const lookup = (async () => {
        const res = await this.run("git", ["remote", "get-url", "origin"], this.config.cwd);
        if (res.exitCode !== 0 || !res.stdout.trim()) {
          throw new ForgeError(res.stderr || "could not resolve git remote 'origin'");
        }
        const { host, path } = parseRemote(res.stdout);
        const baseUrl = (this.config.baseUrl?.trim() || `https://${host}`).replace(/\/$/, "");
        return { baseUrl, encodedPath: encodeURIComponent(path) };
      })();
      // Memoize only success: a transient git failure must not poison the
      // client for its whole lifetime (one instance spans a job's entire CI
      // poll loop), so a rejected lookup is cleared and retried next call.
      lookup.catch(() => {
        if (this.projectRef === lookup) this.projectRef = undefined;
      });
      this.projectRef = lookup;
    }
    return this.projectRef;
  }

  private async request(
    method: string,
    path: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<HttpResponse> {
    const { baseUrl, encodedPath } = await this.resolveProject();
    let url = `${baseUrl}/api/v4/projects/${encodedPath}${path}`;
    if (opts.query) {
      const qs = new URLSearchParams(opts.query).toString();
      if (qs) url += `?${qs}`;
    }
    // Refuse to attach the token to a private/loopback/metadata target unless
    // the operator opted in for a self-hosted instance (issue #110 SSRF guard).
    assertSafeForgeUrl(url, { allowPrivate: this.allowPrivateHost });
    const headers: Record<string, string> = {};
    if (this.config.token) headers["PRIVATE-TOKEN"] = this.config.token;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    return this.http(url, { method, headers, body });
  }

  /** Run a request that must succeed, throwing ForgeError otherwise. */
  private async mutate(
    method: string,
    path: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<HttpResponse> {
    const res = await this.request(method, path, opts);
    if (res.status === 429) {
      await this.sleep(parseGitLabRetryAfterMs(res.headers));
      throw new ForgeError(
        `GitLab rate-limited: ${errorMessage(res) || `${method} ${path} returned 429`}`,
      );
    }
    if (!res.ok) throw new ForgeError(errorMessage(res) || `GitLab ${method} ${path} failed`);
    return res;
  }

  async listIssues(label: string): Promise<ForgeIssue[]> {
    return this.listIssuesPaginated({ state: "opened", labels: label });
  }

  async listAllIssues(): Promise<ForgeIssue[]> {
    return this.listIssuesPaginated({ state: "opened" });
  }

  /**
   * Fetch every page of an issues list, following GitLab's `X-Next-Page`
   * response header (empty when no further page exists), bounded by
   * {@link MAX_ISSUE_PAGES} so a misbehaving header cannot loop forever.
   */
  private async listIssuesPaginated(query: Record<string, string>): Promise<ForgeIssue[]> {
    return this.listPaginated("/issues", query, parseIssues);
  }

  /**
   * Fetch every page of a project list endpoint, following GitLab's
   * `X-Next-Page` response header (empty when no further page exists), bounded
   * by {@link MAX_ISSUE_PAGES} so a misbehaving header cannot loop forever.
   * Used for issues, pipeline jobs, MR diffs and issue notes alike — a failing
   * CI job beyond the first 100 must not be silently dropped (it would
   * misclassify a red pipeline as passed). Throws ForgeError on a non-ok page.
   */
  private async listPaginated<T>(
    path: string,
    query: Record<string, string>,
    parsePage: (body: string) => T[],
  ): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    for (let i = 0; i < MAX_ISSUE_PAGES; i++) {
      const res = await this.mutate("GET", path, {
        query: { ...query, per_page: "100", page: String(page) },
      });
      all.push(...parsePage(res.body));
      const next = res.headers?.["x-next-page"];
      if (!next) break;
      const nextPage = Number(next);
      if (!Number.isInteger(nextPage) || nextPage <= page) break;
      page = nextPage;
    }
    return all;
  }

  async viewIssue(issueNumber: number): Promise<IssueDetail> {
    const issueRes = await this.mutate("GET", `/issues/${issueNumber}`);
    const notes = await this.listPaginated(`/issues/${issueNumber}/notes`, {}, parseNotes);
    const issue = gitlabIssueDetailSchema.parse(safeJson(issueRes.body, {}));
    return {
      number: issue.iid,
      title: issue.title,
      body: issue.description ?? "",
      state: issue.state === "opened" ? "open" : issue.state,
      labels: issue.labels,
      comments: notes
        .filter((n) => !n.system)
        .map((n) => ({ author: n.author.username, body: n.body, createdAt: n.created_at })),
    };
  }

  async editIssue(issueNumber: number, patch: { title?: string; body?: string }): Promise<void> {
    const body: Record<string, string> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.body !== undefined) body.description = patch.body;
    if (Object.keys(body).length === 0) return;
    await this.mutate("PUT", `/issues/${issueNumber}`, { body });
  }

  async ensureLabel(
    name: string,
    opts: { color?: string; description?: string } = {},
  ): Promise<void> {
    const listRes = await this.request("GET", "/labels", { query: { per_page: "100" } });
    if (listRes.ok) {
      const parsed = z.array(z.object({ name: z.string() })).safeParse(safeJson(listRes.body, []));
      if (parsed.success && parsed.data.some((l) => l.name === name)) return;
    }
    const color = normalizeColor(opts.color ?? "#808080");
    const body: Record<string, string> = { name, color };
    if (opts.description) body.description = opts.description;
    const res = await this.request("POST", "/labels", { body });
    // A concurrent create can win the race; treat "already exists" as success.
    if (!res.ok && res.status !== 409 && !/already exists/i.test(res.body)) {
      throw new ForgeError(errorMessage(res) || "GitLab label create failed");
    }
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    await this.mutate("PUT", `/issues/${issueNumber}`, { body: { add_labels: labels.join(",") } });
  }

  async removeLabels(issueNumber: number, labels: string[]): Promise<void> {
    await this.mutate("PUT", `/issues/${issueNumber}`, {
      body: { remove_labels: labels.join(",") },
    });
  }

  async closeIssue(issueNumber: number): Promise<void> {
    await this.mutate("PUT", `/issues/${issueNumber}`, { body: { state_event: "close" } });
  }

  async reopenIssue(issueNumber: number): Promise<void> {
    await this.mutate("PUT", `/issues/${issueNumber}`, { body: { state_event: "reopen" } });
  }

  async commentIssue(issueNumber: number, body: string): Promise<void> {
    await this.mutate("POST", `/issues/${issueNumber}/notes`, { body: { body } });
  }

  async createIssue(title: string, body: string): Promise<number> {
    const res = await this.mutate("POST", "/issues", { body: { title, description: body } });
    return z.object({ iid: z.number() }).parse(safeJson(res.body, {})).iid;
  }

  async prChecks(prNumber: number): Promise<PrCheck[]> {
    const pipelineId = await this.latestPipelineId(prNumber);
    if (pipelineId === null) return [];
    const jobs = await this.listPaginated(`/pipelines/${pipelineId}/jobs`, {}, parseJobs);
    return jobs.map((j) => ({ name: j.name, state: mapJobStatus(j.status) }));
  }

  async prHeadSha(prNumber: number): Promise<string> {
    const res = await this.mutate("GET", `/merge_requests/${prNumber}`);
    return z.object({ sha: z.string() }).parse(safeJson(res.body, {})).sha;
  }

  async failedRunLog(prNumber: number): Promise<string> {
    try {
      const pipelineId = await this.latestPipelineId(prNumber);
      if (pipelineId === null) return "";
      const jobs = await this.listPaginated(`/pipelines/${pipelineId}/jobs`, {}, parseJobs);
      const failed = jobs.find((j) => j.status === "failed" && j.id !== undefined);
      if (!failed) return "";
      const traceRes = await this.request("GET", `/jobs/${failed.id}/trace`);
      if (!traceRes.ok) {
        logError(`GitLab failedRunLog: job ${failed.id} trace request failed (${traceRes.status})`);
        return "";
      }
      return traceRes.body.slice(-8000);
    } catch (err) {
      logError("GitLab failedRunLog error:", err);
      return "";
    }
  }

  async prDiff(prNumber: number): Promise<string> {
    try {
      const diffs = await this.listPaginated(`/merge_requests/${prNumber}/diffs`, {}, parseDiffs);
      return diffs.map((d) => `--- a/${d.old_path}\n+++ b/${d.new_path}\n${d.diff}`).join("\n");
    } catch (err) {
      logError("GitLab prDiff error:", err);
      return "";
    }
  }

  async mergePr(prNumber: number): Promise<void> {
    await this.mutate("PUT", `/merge_requests/${prNumber}/merge`, {
      body: { squash: true },
    });
  }

  async createPr(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<number> {
    const res = await this.mutate("POST", "/merge_requests", {
      body: {
        source_branch: input.head,
        target_branch: input.base,
        title: input.title,
        description: input.body,
      },
    });
    return z.object({ iid: z.number() }).parse(safeJson(res.body, {})).iid;
  }

  /** Latest pipeline id for an MR via `head_pipeline`, or null when none exists yet. */
  private async latestPipelineId(prNumber: number): Promise<number | null> {
    const res = await this.request("GET", `/merge_requests/${prNumber}`);
    if (!res.ok) return null;
    const parsed = gitlabMrHeadPipelineSchema.safeParse(safeJson(res.body, {}));
    const hp = parsed.success ? (parsed.data.head_pipeline ?? null) : null;
    return hp ? hp.id : null;
  }
}

function parseIssues(body: string): ForgeIssue[] {
  const parsed = z.array(gitlabIssueSchema).safeParse(safeJson(body, []));
  if (!parsed.success) throw new ForgeError(`unexpected GitLab output: ${parsed.error.message}`);
  return parsed.data.map((i) => ({
    number: i.iid,
    title: i.title,
    labels: i.labels.map((name) => ({ name })),
    author: i.author?.username ?? null,
    // GitLab's issue payload carries no GitHub-style author association; the
    // author gate treats this as unknown (use minAuthorAssociation "any" to
    // act on public participants). See ADR 016.
    authorAssociation: null,
  }));
}

function parseJobs(body: string): z.infer<typeof gitlabJobSchema>[] {
  const parsed = z.array(gitlabJobSchema).safeParse(safeJson(body, []));
  if (!parsed.success) throw new ForgeError(`unexpected GitLab output: ${parsed.error.message}`);
  return parsed.data;
}

function parseDiffs(body: string): z.infer<typeof gitlabDiffSchema>[] {
  const parsed = z.array(gitlabDiffSchema).safeParse(safeJson(body, []));
  if (!parsed.success) throw new ForgeError(`unexpected GitLab output: ${parsed.error.message}`);
  return parsed.data;
}

function parseNotes(body: string): z.infer<typeof gitlabNoteSchema>[] {
  const parsed = z.array(gitlabNoteSchema).safeParse(safeJson(body, []));
  if (!parsed.success) throw new ForgeError(`unexpected GitLab output: ${parsed.error.message}`);
  return parsed.data;
}

function normalizeColor(color: string): string {
  return color.startsWith("#") ? color : `#${color}`;
}

function safeJson(text: string, fallback: unknown): unknown {
  try {
    return JSON.parse(text || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function errorMessage(res: HttpResponse): string {
  const parsed = z
    .object({ message: z.unknown(), error: z.unknown() })
    .partial()
    .safeParse(safeJson(res.body, {}));
  if (parsed.success) {
    const m = parsed.data.message ?? parsed.data.error;
    if (typeof m === "string") return m;
    if (m) return JSON.stringify(m);
  }
  return res.body.slice(0, 300);
}
