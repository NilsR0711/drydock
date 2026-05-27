import { z } from "zod";
import { type CommandRunner, spawnRunner } from "@/lib/exec/runner";
import { fetchHttp, type HttpClient, type HttpResponse } from "./http";
import {
  type ForgeClient,
  type ForgeConfig,
  ForgeError,
  type ForgeIssue,
  type IssueDetail,
  type PrCheck,
} from "./types";

const gitlabIssueSchema = z.object({
  iid: z.number(),
  title: z.string(),
  labels: z.array(z.string()).default([]),
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

const gitlabPipelineSchema = z.object({ id: z.number() });

interface ProjectRef {
  baseUrl: string;
  encodedPath: string;
}

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
  private projectRef?: Promise<ProjectRef>;

  constructor(
    private readonly config: ForgeConfig,
    deps: { http?: HttpClient; run?: CommandRunner } = {},
  ) {
    this.http = deps.http ?? fetchHttp;
    this.run = deps.run ?? spawnRunner;
  }

  private resolveProject(): Promise<ProjectRef> {
    if (!this.projectRef) {
      this.projectRef = (async () => {
        const res = await this.run("git", ["remote", "get-url", "origin"], this.config.cwd);
        if (res.exitCode !== 0 || !res.stdout.trim()) {
          throw new ForgeError(res.stderr || "could not resolve git remote 'origin'");
        }
        const { host, path } = parseRemote(res.stdout);
        const baseUrl = (this.config.baseUrl?.trim() || `https://${host}`).replace(/\/$/, "");
        return { baseUrl, encodedPath: encodeURIComponent(path) };
      })();
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
    if (!res.ok) throw new ForgeError(errorMessage(res) || `GitLab ${method} ${path} failed`);
    return res;
  }

  async listIssues(label: string): Promise<ForgeIssue[]> {
    const res = await this.mutate("GET", "/issues", {
      query: { state: "opened", labels: label, per_page: "100" },
    });
    return parseIssues(res.body);
  }

  async listAllIssues(): Promise<ForgeIssue[]> {
    const res = await this.mutate("GET", "/issues", {
      query: { state: "opened", per_page: "100" },
    });
    return parseIssues(res.body);
  }

  async viewIssue(issueNumber: number): Promise<IssueDetail> {
    const issueRes = await this.mutate("GET", `/issues/${issueNumber}`);
    const notesRes = await this.mutate("GET", `/issues/${issueNumber}/notes`, {
      query: { per_page: "100" },
    });
    const issue = gitlabIssueDetailSchema.parse(safeJson(issueRes.body, {}));
    const notes = z.array(gitlabNoteSchema).parse(safeJson(notesRes.body, []));
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
    const res = await this.mutate("GET", `/pipelines/${pipelineId}/jobs`, {
      query: { per_page: "100" },
    });
    const jobs = z.array(gitlabJobSchema).parse(safeJson(res.body, []));
    return jobs.map((j) => ({ name: j.name, state: mapJobStatus(j.status) }));
  }

  async failedRunLog(prNumber: number): Promise<string> {
    try {
      const pipelineId = await this.latestPipelineId(prNumber);
      if (pipelineId === null) return "";
      const jobsRes = await this.request("GET", `/pipelines/${pipelineId}/jobs`, {
        query: { per_page: "100" },
      });
      if (!jobsRes.ok) return "";
      const jobs = z.array(gitlabJobSchema).safeParse(safeJson(jobsRes.body, []));
      if (!jobs.success) return "";
      const failed = jobs.data.find((j) => j.status === "failed" && j.id !== undefined);
      if (!failed) return "";
      const traceRes = await this.request("GET", `/jobs/${failed.id}/trace`);
      if (!traceRes.ok) return "";
      return traceRes.body.slice(-8000);
    } catch {
      return "";
    }
  }

  async mergePr(prNumber: number): Promise<void> {
    await this.mutate("PUT", `/merge_requests/${prNumber}/merge`, {
      body: { squash: true, merge_when_pipeline_succeeds: true },
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

  /** Latest pipeline id for an MR, or null when none exists yet. */
  private async latestPipelineId(prNumber: number): Promise<number | null> {
    const res = await this.request("GET", `/merge_requests/${prNumber}/pipelines`);
    if (!res.ok) return null;
    const parsed = z.array(gitlabPipelineSchema).safeParse(safeJson(res.body, []));
    const latest = parsed.success ? parsed.data[0] : undefined;
    return latest ? latest.id : null;
  }
}

function parseIssues(body: string): ForgeIssue[] {
  const parsed = z.array(gitlabIssueSchema).safeParse(safeJson(body, []));
  if (!parsed.success) throw new ForgeError(`unexpected GitLab output: ${parsed.error.message}`);
  return parsed.data.map((i) => ({
    number: i.iid,
    title: i.title,
    labels: i.labels.map((name) => ({ name })),
  }));
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
