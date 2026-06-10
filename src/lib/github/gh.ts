import { z } from "zod";
import { type CommandResult, type CommandRunner, spawnRunner } from "@/lib/exec/runner";
import { type EtagCache, sharedEtagCache } from "./etag-cache";
import { type IncludeResponse, parseIncludeResponse, parseNextLink } from "./gh-response";
import { currentPriority } from "./priority";
import {
  parseRateLimitHeaders,
  RateLimitError,
  type RateLimitGovernor,
  type RateResource,
  sharedGovernor,
} from "./rate-limit";

/**
 * REST `/issues` item (as returned by `gh api`). The REST endpoint includes
 * pull requests in the issue list (they carry a `pull_request` field), so the
 * transform flags them for the caller to filter out. Field names differ from
 * the CLI's `--json` output (`user`/`author_association` vs `author`).
 */
const ghRestIssueSchema = z
  .object({
    number: z.number(),
    title: z.string(),
    labels: z.array(z.object({ name: z.string() })).default([]),
    user: z.object({ login: z.string() }).nullish(),
    author_association: z.string().nullish(),
    pull_request: z.unknown().optional(),
  })
  .transform((d) => ({
    number: d.number,
    title: d.title,
    labels: d.labels,
    author: d.user?.login ?? null,
    authorAssociation: d.author_association ?? null,
    isPullRequest: d.pull_request !== undefined,
  }));

/** Rate-limit snapshot shape from the free `gh api rate_limit` endpoint. */
const rateLimitProbeSchema = z.object({
  resources: z.record(
    z.string(),
    z.object({ limit: z.number(), remaining: z.number(), reset: z.number() }),
  ),
});

/**
 * A listed issue. `author`/`authorAssociation` are optional because only some
 * code paths (and forges) populate them — auto-triage/processing read them for
 * the public-repo author gate, while the queue path leaves them undefined.
 */
export interface GhIssue {
  number: number;
  title: string;
  labels: { name: string }[];
  author?: string | null;
  authorAssociation?: string | null;
}

export const ghIssueDetailSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().default(""),
  state: z.string().default("open"),
  labels: z.array(z.object({ name: z.string() })).default([]),
  comments: z
    .array(
      z.object({
        author: z.object({ login: z.string() }).default({ login: "" }),
        body: z.string().default(""),
        createdAt: z.string().default(""),
      }),
    )
    .default([]),
});

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}
export interface IssueDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  comments: IssueComment[];
}

export const prCheckSchema = z.object({
  name: z.string(),
  state: z.string(),
  bucket: z.string().optional(),
});
export type PrCheck = z.infer<typeof prCheckSchema>;

/** A single comment within a PR review thread. */
export interface ReviewThreadComment {
  /** GraphQL node id (used as a reaction subject). */
  id: string;
  databaseId: number | null;
  author: string;
  body: string;
}

/** A PR review thread (issue #18): the unit Drydock tracks per feedback item. */
export interface ReviewThread {
  /** GraphQL node id (used to reply to / resolve the thread). */
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: ReviewThreadComment[];
}

/** A reaction Drydock may add to acknowledge a review comment. */
export type ReactionContent = "EYES" | "THUMBS_UP" | "ROCKET" | "CONFUSED";

const reviewThreadsSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z
        .object({
          reviewThreads: z.object({
            nodes: z.array(
              z.object({
                id: z.string(),
                isResolved: z.boolean().default(false),
                isOutdated: z.boolean().default(false),
                path: z.string().nullish(),
                line: z.number().nullish(),
                comments: z.object({
                  nodes: z.array(
                    z.object({
                      id: z.string(),
                      databaseId: z.number().nullish(),
                      body: z.string().default(""),
                      author: z.object({ login: z.string() }).nullish(),
                    }),
                  ),
                }),
              }),
            ),
          }),
        })
        .nullish(),
    }),
  }),
});

export class GhError extends Error {}

/**
 * Hard cap on the number of issue-list pages followed in a single fetch. At 100
 * issues per page this bounds a sweep at 10k open issues — far above any real
 * repo — so a misbehaving `Link` header can never spin the loop indefinitely.
 */
export const MAX_ISSUE_PAGES = 100;

/**
 * Join a flag and a user-controlled value as a single `--flag=value` token.
 * Using the `=` form prevents `gh`/cobra from interpreting a value that begins
 * with `-` (e.g. a title like "-rf") as another flag (argument injection).
 */
function flagEq(flag: string, value: string): string {
  return `${flag}=${value}`;
}

/** A 429 (or a primary-limit 403 with `remaining: 0`) is a hard rate-limit. */
function isRateLimitStatus(status: number | null, headers: Record<string, string>): boolean {
  return status === 429 || (status === 403 && headers["x-ratelimit-remaining"] === "0");
}

/** Parse one issue-list page body into its raw JSON array of REST rows. */
function parseRawIssueArray(body: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(body || "[]");
  } catch {
    throw new GhError("unexpected gh output: response body was not valid JSON");
  }
  if (!Array.isArray(value)) throw new GhError("unexpected gh output: expected a JSON array");
  return value;
}

/**
 * Thin wrapper around the `gh` CLI; runner is injectable for tests.
 *
 * Every request is metered by a shared {@link RateLimitGovernor}: it is gated
 * before spawning when the budget is tight (background work yields first, and
 * nothing drains the budget below the hard floor), the budget is refreshed from
 * observed response headers, and an actual 429 triggers a backoff. List fetches
 * additionally use conditional requests (ETag) so unchanged lists cost nothing.
 */
export class GhClient {
  constructor(
    private readonly cwd: string,
    private readonly run: CommandRunner = spawnRunner,
    private readonly governor: RateLimitGovernor = sharedGovernor,
    private readonly etags: EtagCache = sharedEtagCache,
  ) {}

  /** Throw if the governor gates a request of the current priority. */
  private gate(resource: RateResource = "core"): void {
    const decision = this.governor.decide(resource, currentPriority());
    if (!decision.allowed) {
      throw new RateLimitError(decision.reason, resource, decision.retryAfterMs);
    }
  }

  /**
   * Gate, run a `gh` command, and note a 429 reported on stderr. Used by every
   * non-list, non-probe call (list fetches use {@link conditionalList} so they
   * can also read rate-limit/ETag headers).
   */
  private async exec(args: string[], resource: RateResource = "core"): Promise<CommandResult> {
    this.gate(resource);
    const res = await this.run("gh", args, this.cwd);
    if (res.exitCode !== 0 && /rate limit|429 too many/i.test(res.stderr)) {
      this.governor.note429(resource);
    }
    return res;
  }

  /**
   * Refresh the governor from GitHub's `/rate_limit` endpoint, which does not
   * itself count against any budget. Best-effort: a failed probe is ignored so
   * a transient error never blocks a sweep. Never gated (it is what unblocks).
   */
  async refreshRateLimit(): Promise<void> {
    const res = await this.run("gh", ["api", "rate_limit"], this.cwd);
    if (res.exitCode !== 0) return;
    let parsed: z.infer<typeof rateLimitProbeSchema>;
    try {
      parsed = rateLimitProbeSchema.parse(JSON.parse(res.stdout || "{}"));
    } catch {
      return;
    }
    for (const resource of ["core", "graphql", "search"] as const) {
      const r = parsed.resources[resource];
      if (r) this.governor.observe(resource, r);
    }
  }

  /**
   * Conditional, paginated GET of an issues list via `gh api --include`.
   *
   * The first page sends the cached ETag as `If-None-Match`; on a 304 the cached
   * body — the full multi-page list captured on the prior fetch — is replayed
   * without spending budget. A fresh 200 starts the accumulation and the
   * `rel="next"` `Link` header is followed (bounded by {@link MAX_ISSUE_PAGES})
   * until the list is exhausted. The combined list is cached under the first
   * page's ETag so an unchanged first page replays every page. Rate-limit
   * headers are observed on every page, a 429 backs off, and pull requests are
   * filtered out.
   */
  private async conditionalList(cacheKey: string, query: string): Promise<GhIssue[]> {
    this.gate("core");
    const prior = this.etags.get(cacheKey);
    const args = ["api", `repos/{owner}/{repo}/issues?${query}`, "--include"];
    if (prior) args.push("-H", `If-None-Match: ${prior.etag}`);

    const res = await this.run("gh", args, this.cwd);
    const response = this.checkListResponse(res, parseIncludeResponse(res.stdout));

    if (response.status === 304 && prior) {
      return this.toGhIssues(parseRawIssueArray(prior.body)); // unchanged: no budget consumed
    }

    const raw: unknown[] = [...parseRawIssueArray(response.body)];
    let next = parseNextLink(response.headers.link);
    let pages = 1;
    while (next && pages < MAX_ISSUE_PAGES) {
      this.gate("core");
      const pageRes = await this.run("gh", ["api", next, "--include"], this.cwd);
      const page = this.checkListResponse(pageRes, parseIncludeResponse(pageRes.stdout));
      raw.push(...parseRawIssueArray(page.body));
      next = parseNextLink(page.headers.link);
      pages++;
    }

    // Cache the combined list under the first page's ETag so a later 304 (first
    // page unchanged) replays every page, not just the first.
    const etag = response.headers.etag;
    if (etag) this.etags.set(cacheKey, etag, JSON.stringify(raw));
    return this.toGhIssues(raw);
  }

  /**
   * Observe rate-limit headers and turn a non-2xx (other than a 304 with a prior
   * ETag) into the right error: a 429/limited status backs off and throws, any
   * other non-200 throws. Returns the parsed response for the caller to use.
   */
  private checkListResponse(res: CommandResult, response: IncludeResponse): IncludeResponse {
    const rl = parseRateLimitHeaders(response.headers);
    if (rl) this.governor.observe(rl.resource, rl.snapshot);
    if (response.status === 304) return response;
    if (isRateLimitStatus(response.status, response.headers)) {
      const reset = Number(response.headers["x-ratelimit-reset"]);
      this.governor.note429("core", Number.isFinite(reset) ? reset : undefined);
      throw new GhError(`gh api rate limited (status ${response.status})`);
    }
    if (response.status !== 200) {
      throw new GhError(res.stderr || `gh api failed (status ${response.status ?? "unknown"})`);
    }
    return response;
  }

  /** Validate accumulated REST issue rows and drop pull requests. */
  private toGhIssues(raw: unknown[]): GhIssue[] {
    const parsed = z.array(ghRestIssueSchema).safeParse(raw);
    if (!parsed.success) throw new GhError(`unexpected gh output: ${parsed.error.message}`);
    return parsed.data
      .filter((i) => !i.isPullRequest)
      .map(({ isPullRequest: _pr, ...rest }) => rest);
  }

  async listIssues(label: string): Promise<GhIssue[]> {
    const query = `state=open&per_page=100&labels=${encodeURIComponent(label)}`;
    return this.conditionalList(`${this.cwd}::label:${label}`, query);
  }

  async listAllIssues(): Promise<GhIssue[]> {
    return this.conditionalList(`${this.cwd}::all`, "state=open&per_page=100");
  }

  async viewIssue(issueNumber: number): Promise<IssueDetail> {
    const res = await this.exec([
      "issue",
      "view",
      String(issueNumber),
      "--json",
      "number,title,body,state,labels,comments",
    ]);
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue view failed");
    const parsed = ghIssueDetailSchema.safeParse(JSON.parse(res.stdout || "{}"));
    if (!parsed.success) throw new GhError(`unexpected gh output: ${parsed.error.message}`);
    const d = parsed.data;
    return {
      number: d.number,
      title: d.title,
      body: d.body,
      state: d.state,
      labels: d.labels.map((l) => l.name),
      comments: d.comments.map((c) => ({
        author: c.author.login,
        body: c.body,
        createdAt: c.createdAt,
      })),
    };
  }

  async editIssue(issueNumber: number, patch: { title?: string; body?: string }): Promise<void> {
    const args = ["issue", "edit", String(issueNumber)];
    if (patch.title !== undefined) args.push(flagEq("--title", patch.title));
    if (patch.body !== undefined) args.push(flagEq("--body", patch.body));
    // Nothing to change: avoid a malformed `gh issue edit <n>` call that errors.
    if (args.length === 3) return;
    const res = await this.exec(args);
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue edit failed");
  }

  /**
   * Ensure a label exists in the repo before it's applied to an issue. Looks it
   * up first so an existing label (with its own color/description) is left
   * untouched, and only creates it when missing. Tolerates a concurrent create.
   */
  async ensureLabel(
    name: string,
    opts: { color?: string; description?: string } = {},
  ): Promise<void> {
    const list = await this.exec(["label", "list", "--json", "name", "--limit", "200"]);
    const text = list.stdout.trim();
    if (list.exitCode === 0 && text) {
      try {
        const parsed = z.array(z.object({ name: z.string() })).safeParse(JSON.parse(text));
        if (parsed.success && parsed.data.some((l) => l.name === name)) return;
      } catch {
        // unparseable output: fall through and try to create the label
      }
    }
    const args = ["label", "create", name];
    if (opts.color) args.push("--color", opts.color);
    if (opts.description) args.push("--description", opts.description);
    const res = await this.exec(args);
    // A concurrent create can win the race; treat "already exists" as success.
    if (res.exitCode !== 0 && !/already exists/i.test(res.stderr)) {
      throw new GhError(res.stderr || "gh label create failed");
    }
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    const res = await this.exec([
      "issue",
      "edit",
      String(issueNumber),
      flagEq("--add-label", labels.join(",")),
    ]);
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue edit failed");
  }

  async removeLabels(issueNumber: number, labels: string[]): Promise<void> {
    const res = await this.exec([
      "issue",
      "edit",
      String(issueNumber),
      flagEq("--remove-label", labels.join(",")),
    ]);
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue edit failed");
  }

  async closeIssue(issueNumber: number): Promise<void> {
    const res = await this.exec(["issue", "close", String(issueNumber)]);
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue close failed");
  }

  async reopenIssue(issueNumber: number): Promise<void> {
    const res = await this.exec(["issue", "reopen", String(issueNumber)]);
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue reopen failed");
  }

  async prChecks(prNumber: number): Promise<PrCheck[]> {
    const res = await this.exec(["pr", "checks", String(prNumber), "--json", "name,state,bucket"]);
    // `gh pr checks` exits non-zero when checks fail; still emits JSON.
    const text = res.stdout.trim();
    if (!text) {
      if (res.exitCode !== 0) throw new GhError(res.stderr || "gh pr checks failed");
      return [];
    }
    const parsed = z.array(prCheckSchema).safeParse(JSON.parse(text));
    if (!parsed.success) throw new GhError(`unexpected gh output: ${parsed.error.message}`);
    return parsed.data;
  }

  async prHeadSha(prNumber: number): Promise<string> {
    const res = await this.exec(["pr", "view", String(prNumber), "--json", "headRefOid"]);
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh pr view failed");
    const parsed = z.object({ headRefOid: z.string() }).safeParse(JSON.parse(res.stdout || "{}"));
    if (!parsed.success) throw new GhError(`unexpected gh output: ${parsed.error.message}`);
    return parsed.data.headRefOid;
  }

  async commentIssue(issueNumber: number, body: string): Promise<void> {
    const res = await this.exec(["issue", "comment", String(issueNumber), flagEq("--body", body)]);
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue comment failed");
  }

  async createIssue(title: string, body: string): Promise<number> {
    const res = await this.exec([
      "issue",
      "create",
      flagEq("--title", title),
      flagEq("--body", body),
    ]);
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue create failed");
    const match = res.stdout.match(/\/issues\/(\d+)/);
    if (!match?.[1]) throw new GhError(`could not parse issue number from: ${res.stdout}`);
    return Number(match[1]);
  }

  /**
   * Resolve the most recent failed CI run on a PR's head branch. `gh run` is
   * keyed by run id, not PR, so we (1) resolve the PR's head branch and
   * (2) find the newest run on that branch that concluded `failure`.
   * Best-effort and never-throwing: returns `null` when nothing resolves.
   */
  private async latestFailedRunId(prNumber: number): Promise<number | null> {
    // 1. Resolve the PR head branch.
    const prRes = await this.run(
      "gh",
      ["pr", "view", String(prNumber), "--json", "headRefName"],
      this.cwd,
    );
    if (prRes.exitCode !== 0) return null;
    let branch: string;
    try {
      branch = z
        .object({ headRefName: z.string() })
        .parse(JSON.parse(prRes.stdout || "{}")).headRefName;
    } catch {
      return null;
    }
    if (!branch) return null;

    // 2. Find the most recent failed run on that branch.
    const listRes = await this.run(
      "gh",
      ["run", "list", "--branch", branch, "--json", "databaseId,conclusion", "--limit", "20"],
      this.cwd,
    );
    if (listRes.exitCode !== 0) return null;
    let runs: { databaseId: number; conclusion: string }[];
    try {
      runs = z
        .array(z.object({ databaseId: z.number(), conclusion: z.string().default("") }))
        .parse(JSON.parse(listRes.stdout || "[]"));
    } catch {
      return null;
    }
    return runs.find((r) => r.conclusion === "failure")?.databaseId ?? null;
  }

  /**
   * Fetch the failed-step log of the CI run for a PR: resolve the most recent
   * failed run on the PR's head branch, then read its `--log-failed` output.
   * Returns an empty string (never garbage) when no failed run can be found.
   */
  async failedRunLog(prNumber: number): Promise<string> {
    // Best-effort and never-throwing: when the budget is gated, skip silently
    // rather than raise — the caller treats an empty log as "no detail yet".
    if (!this.governor.decide("core", currentPriority()).allowed) return "";

    const runId = await this.latestFailedRunId(prNumber);
    if (runId === null) return "";

    const logRes = await this.run("gh", ["run", "view", String(runId), "--log-failed"], this.cwd);
    if (logRes.exitCode !== 0) return "";
    return logRes.stdout.slice(-8000);
  }

  /**
   * Re-run only the failed jobs of the PR's most recent failed CI run (the CI
   * auto-heal `rerun` action for flaky checks, issue #16). Best-effort and
   * never-throwing: returns whether a re-run was actually triggered, so the
   * caller can escalate instead of pretending a heal attempt happened.
   */
  async reRunFailedChecks(prNumber: number): Promise<boolean> {
    if (!this.governor.decide("core", currentPriority()).allowed) return false;

    const runId = await this.latestFailedRunId(prNumber);
    if (runId === null) return false;

    const res = await this.run("gh", ["run", "rerun", String(runId), "--failed"], this.cwd);
    return res.exitCode === 0;
  }

  /**
   * The PR's unified diff via `gh pr diff`. Best-effort and never-throwing: a
   * gated budget or a non-zero exit yields an empty string, which the caller
   * (the post-PR verification pass, issue #54) treats as "no diff to verify".
   */
  async prDiff(prNumber: number): Promise<string> {
    if (!this.governor.decide("core", currentPriority()).allowed) return "";
    const res = await this.run("gh", ["pr", "diff", String(prNumber)], this.cwd);
    if (res.exitCode !== 0) return "";
    return res.stdout;
  }

  async mergePr(prNumber: number): Promise<void> {
    const res = await this.exec(["pr", "merge", String(prNumber), "--squash", "--auto"]);
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh pr merge failed");
  }

  async createPr(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<number> {
    const res = await this.exec([
      "pr",
      "create",
      flagEq("--head", input.head),
      flagEq("--base", input.base),
      flagEq("--title", input.title),
      flagEq("--body", input.body),
    ]);
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh pr create failed");
    const match = res.stdout.match(/\/pull\/(\d+)/);
    if (!match?.[1]) throw new GhError(`could not parse PR number from: ${res.stdout}`);
    return Number(match[1]);
  }

  /**
   * List the repo's published releases (issue #59), newest first. Used to find
   * the latest release tag (and its date, to scope unreleased PRs) and to detect
   * an already-existing release for idempotency.
   */
  async listReleases(): Promise<{ tagName: string; createdAt: string }[]> {
    const res = await this.exec([
      "release",
      "list",
      "--json",
      "tagName,createdAt",
      "--limit",
      "100",
    ]);
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh release list failed");
    const parsed = z
      .array(z.object({ tagName: z.string(), createdAt: z.string().default("") }))
      .safeParse(JSON.parse(res.stdout || "[]"));
    if (!parsed.success) throw new GhError(`unexpected gh output: ${parsed.error.message}`);
    return parsed.data;
  }

  /**
   * List recently merged pull requests (issue #59), newest first, flattening the
   * GitHub label objects to plain names. The release manager filters these down
   * to the ones merged since the last release.
   */
  async listMergedPrs(
    limit = 100,
  ): Promise<{ number: number; title: string; mergedAt: string; labels: string[] }[]> {
    const res = await this.exec([
      "pr",
      "list",
      "--state",
      "merged",
      "--json",
      "number,title,mergedAt,labels",
      "--limit",
      String(limit),
    ]);
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh pr list failed");
    const parsed = z
      .array(
        z.object({
          number: z.number(),
          title: z.string().default(""),
          mergedAt: z.string().default(""),
          labels: z.array(z.object({ name: z.string() })).default([]),
        }),
      )
      .safeParse(JSON.parse(res.stdout || "[]"));
    if (!parsed.success) throw new GhError(`unexpected gh output: ${parsed.error.message}`);
    return parsed.data.map((p) => ({
      number: p.number,
      title: p.title,
      mergedAt: p.mergedAt,
      labels: p.labels.map((l) => l.name),
    }));
  }

  /**
   * Publish a release at `target` (issue #59). Title, notes, and target are
   * passed in the `--flag=value` form so a value beginning with `-` can never be
   * read as another flag.
   */
  async createRelease(input: {
    tag: string;
    title: string;
    notes: string;
    target: string;
  }): Promise<void> {
    const res = await this.exec([
      "release",
      "create",
      input.tag,
      flagEq("--title", input.title),
      flagEq("--notes", input.notes),
      flagEq("--target", input.target),
    ]);
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh release create failed");
  }

  /**
   * Resolve the repo's `owner` and `name`, cached for the client's lifetime.
   * GraphQL queries (review threads) need these explicitly — unlike REST, `gh
   * api graphql` does not substitute the `{owner}/{repo}` placeholders.
   */
  private slug: { owner: string; name: string } | undefined;
  private async repoSlug(): Promise<{ owner: string; name: string }> {
    if (this.slug) return this.slug;
    const res = await this.exec(["repo", "view", "--json", "nameWithOwner"]);
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh repo view failed");
    const parsed = z
      .object({ nameWithOwner: z.string() })
      .safeParse(JSON.parse(res.stdout || "{}"));
    if (!parsed.success) throw new GhError(`unexpected gh output: ${parsed.error.message}`);
    const [owner, name] = parsed.data.nameWithOwner.split("/");
    if (!owner || !name) throw new GhError(`unexpected repo slug: ${parsed.data.nameWithOwner}`);
    this.slug = { owner, name };
    return this.slug;
  }

  /**
   * List the PR's review threads (issue #18) via GraphQL: their resolution
   * state, node ids (for reply/resolve), and comments (for the trusted-reviewer
   * gate and idempotency marker scan).
   */
  async listReviewThreads(prNumber: number): Promise<ReviewThread[]> {
    const { owner, name } = await this.repoSlug();
    const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:100){nodes{id databaseId body author{login}}}}}}}}`;
    const res = await this.exec(
      [
        "api",
        "graphql",
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${prNumber}`,
        "-f",
        `query=${query}`,
      ],
      "graphql",
    );
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh api graphql failed");
    const parsed = reviewThreadsSchema.safeParse(JSON.parse(res.stdout || "{}"));
    if (!parsed.success) throw new GhError(`unexpected gh output: ${parsed.error.message}`);
    const nodes = parsed.data.data.repository.pullRequest?.reviewThreads.nodes ?? [];
    return nodes.map((t) => ({
      id: t.id,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      path: t.path ?? null,
      line: t.line ?? null,
      comments: t.comments.nodes.map((c) => ({
        id: c.id,
        databaseId: c.databaseId ?? null,
        author: c.author?.login ?? "",
        body: c.body,
      })),
    }));
  }

  /** Post a reply on a review thread (GraphQL thread-reply mutation). */
  async replyToReviewThread(threadId: string, body: string): Promise<void> {
    const query = `mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}}}`;
    const res = await this.exec(
      [
        "api",
        "graphql",
        "-F",
        `threadId=${threadId}`,
        "-f",
        `body=${body}`,
        "-f",
        `query=${query}`,
      ],
      "graphql",
    );
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh review reply failed");
  }

  /**
   * Edit one of our existing review-thread replies in place (GraphQL
   * `updatePullRequestReviewComment`). Lets the feedback loop update a prior
   * status reply instead of posting a duplicate.
   */
  async updateReviewComment(commentId: string, body: string): Promise<void> {
    const query = `mutation($id:ID!,$body:String!){updatePullRequestReviewComment(input:{pullRequestReviewCommentId:$id,body:$body}){pullRequestReviewComment{id}}}`;
    const res = await this.exec(
      ["api", "graphql", "-F", `id=${commentId}`, "-f", `body=${body}`, "-f", `query=${query}`],
      "graphql",
    );
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh update review comment failed");
  }

  /** Mark a review thread as resolved (GraphQL `resolveReviewThread`). */
  async resolveReviewThread(threadId: string): Promise<void> {
    const query = `mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}`;
    const res = await this.exec(
      ["api", "graphql", "-F", `threadId=${threadId}`, "-f", `query=${query}`],
      "graphql",
    );
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh resolve thread failed");
  }

  /**
   * Acknowledge a review comment with a reaction. A repeated reaction is a
   * no-op on GitHub's side ("already has this reaction"), so that is tolerated.
   */
  async reactToReviewComment(commentId: string, content: ReactionContent): Promise<void> {
    const query = `mutation($subjectId:ID!,$content:ReactionContent!){addReaction(input:{subjectId:$subjectId,content:$content}){reaction{content}}}`;
    const res = await this.exec(
      [
        "api",
        "graphql",
        "-F",
        `subjectId=${commentId}`,
        "-F",
        `content=${content}`,
        "-f",
        `query=${query}`,
      ],
      "graphql",
    );
    if (res.exitCode !== 0 && !/already has this reaction/i.test(res.stderr)) {
      throw new GhError(res.stderr || "gh add reaction failed");
    }
  }
}
