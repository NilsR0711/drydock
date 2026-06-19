/**
 * Parse a pull-request / merge-request web URL into its repo coordinates
 * (issue #293). Drydock lets an operator add an existing PR by URL to babysit
 * it; this turns the operator-pasted link into the `{slug, prNumber}` the forge
 * layer and tracking record need. The platform is inferred from the URL *shape*
 * (`/pull/` vs `/merge_requests/`), not the host, so GitHub Enterprise and
 * self-hosted GitLab instances parse correctly.
 */
export interface ParsedPrUrl {
  platform: "github" | "gitlab";
  /** The forge host, e.g. `github.com` or `gitlab.example.com`. */
  host: string;
  /** Namespace/owner; may contain slashes for nested GitLab subgroups. */
  owner: string;
  /** Repository / project name (without any `.git` suffix). */
  repo: string;
  /** Full project path `${owner}/${repo}` — matches a forge `nameWithOwner`. */
  slug: string;
  /** The PR (GitHub) / MR iid (GitLab) number; always a positive integer. */
  prNumber: number;
}

/** Strip a trailing `.git` a user may have copied from a clone URL. */
function stripGitSuffix(segment: string): string {
  return segment.endsWith(".git") ? segment.slice(0, -4) : segment;
}

function toPrNumber(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return n > 0 ? n : null;
}

/**
 * Parse a GitHub PR or GitLab MR URL. Returns `null` for anything that is not a
 * well-formed http(s) PR/MR link (issue URLs, repo roots, bad schemes, garbage).
 */
export function parsePrUrl(input: string): ParsedPrUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const segments = url.pathname.split("/").filter((s) => s.length > 0);

  // GitHub: <owner>/<repo>/pull/<number>. Use the LAST occurrence so a repo or
  // namespace segment literally named "pull" can't shadow the real PR token.
  const pullIdx = segments.lastIndexOf("pull");
  if (pullIdx >= 2) {
    const prNumber = toPrNumber(segments[pullIdx + 1]);
    const owner = segments.slice(0, pullIdx - 1).join("/");
    const repo = stripGitSuffix(segments[pullIdx - 1] as string);
    if (prNumber === null || owner === "" || repo === "") return null;
    return {
      platform: "github",
      host: url.hostname,
      owner,
      repo,
      slug: `${owner}/${repo}`,
      prNumber,
    };
  }

  // GitLab: <namespace…>/<project>(/-)?/merge_requests/<iid>. Last occurrence,
  // so a subgroup named "merge_requests" can't shadow the real MR token.
  const mrIdx = segments.lastIndexOf("merge_requests");
  if (mrIdx >= 2) {
    const prNumber = toPrNumber(segments[mrIdx + 1]);
    // The `/-/` separator (when present) sits directly before `merge_requests`.
    const projectEnd = segments[mrIdx - 1] === "-" ? mrIdx - 1 : mrIdx;
    const owner = segments.slice(0, projectEnd - 1).join("/");
    const repo = stripGitSuffix(segments[projectEnd - 1] as string);
    if (prNumber === null || owner === "" || repo === "") return null;
    return {
      platform: "gitlab",
      host: url.hostname,
      owner,
      repo,
      slug: `${owner}/${repo}`,
      prNumber,
    };
  }

  return null;
}
