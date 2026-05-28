/**
 * Cached, rate-friendly "is a newer Drydock published?" checker (issue #58).
 *
 * Queries the GitHub Releases API for the upstream repository, picks the latest
 * stable release (skipping drafts and prereleases), and compares its semver tag
 * against the running version. The result is cached for a TTL and concurrent
 * checks collapse onto a single in-flight request, so a burst of dashboard
 * renders costs at most one upstream call per hour.
 *
 * Every failure path — network error, non-200, malformed body, missing tag —
 * resolves to "no update available". A passive notice must never turn a
 * transient upstream hiccup into a false alarm.
 */

import { fetchHttp, type HttpClient } from "@/lib/forge/http";
import { getCurrentVersion } from "@/lib/version/current";
import { isNewerVersion, parseSemver } from "@/lib/version/semver";

/** The upstream repository whose releases are checked. */
export const UPDATE_REPO = "NilsR0711/drydock";

/** Default cache lifetime: one hour. */
export const DEFAULT_TTL_MS = 60 * 60 * 1000;

export interface UpdateStatus {
  /** True only when a strictly newer stable release exists upstream. */
  updateAvailable: boolean;
  /** The version Drydock is currently running. */
  currentVersion: string;
  /** The latest stable release version, or null when unknown. */
  latestVersion: string | null;
  /** A link to the latest release / changelog, or null when unknown. */
  releaseUrl: string | null;
}

export interface UpdateCheckOptions {
  /** HTTP seam; defaults to the real `fetch`-backed client. */
  http?: HttpClient;
  /** The running version; defaults to {@link getCurrentVersion}. */
  currentVersion?: string;
  /** Clock seam for cache expiry; defaults to `Date.now`. */
  now?: () => number;
  /** Cache lifetime in milliseconds; defaults to {@link DEFAULT_TTL_MS}. */
  ttlMs?: number;
  /** Repository slug to query; defaults to {@link UPDATE_REPO}. */
  repo?: string;
}

interface GithubRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  html_url?: unknown;
}

interface CacheEntry {
  status: UpdateStatus;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<UpdateStatus> | null = null;

/** Clear the process-wide cache. Test seam only. */
export function resetUpdateCheckCache(): void {
  cache = null;
  inFlight = null;
}

/**
 * Resolve the update status, honouring the cache, TTL, and in-flight dedupe.
 * Always resolves — never rejects — so callers can render the result directly.
 */
export function checkForUpdate(opts: UpdateCheckOptions = {}): Promise<UpdateStatus> {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  if (cache && now() - cache.fetchedAt < ttlMs) {
    return Promise.resolve(cache.status);
  }
  if (inFlight) return inFlight;

  inFlight = fetchStatus(opts)
    .then((status) => {
      cache = { status, fetchedAt: now() };
      return status;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Synchronously read the current update status for server-side rendering. Never
 * blocks on the network: returns the cached status (or a no-update default when
 * the cache is cold) and kicks off a background refresh when the cache is stale
 * and no check is already running. The notice then appears on a later render.
 */
export function peekUpdateStatus(opts: UpdateCheckOptions = {}): UpdateStatus {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  const fresh = cache !== null && now() - cache.fetchedAt < ttlMs;
  if (!fresh && !inFlight) {
    void checkForUpdate(opts).catch(() => {});
  }

  if (cache) return cache.status;
  return {
    updateAvailable: false,
    currentVersion: opts.currentVersion ?? getCurrentVersion(),
    latestVersion: null,
    releaseUrl: null,
  };
}

async function fetchStatus(opts: UpdateCheckOptions): Promise<UpdateStatus> {
  const http = opts.http ?? fetchHttp;
  const repo = opts.repo ?? UPDATE_REPO;
  const currentVersion = opts.currentVersion ?? getCurrentVersion();

  const noUpdate: UpdateStatus = {
    updateAvailable: false,
    currentVersion,
    latestVersion: null,
    releaseUrl: null,
  };

  try {
    const res = await http(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "drydock-update-check",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return noUpdate;

    const latest = pickLatestStable(JSON.parse(res.body));
    if (!latest) return noUpdate;

    return {
      updateAvailable: isNewerVersion(latest.version, currentVersion),
      currentVersion,
      latestVersion: latest.version,
      releaseUrl: latest.url,
    };
  } catch {
    return noUpdate;
  }
}

/** Pick the highest-semver stable release from a releases payload. */
function pickLatestStable(payload: unknown): { version: string; url: string | null } | null {
  if (!Array.isArray(payload)) return null;

  let best: { version: string; url: string | null } | null = null;
  for (const entry of payload as GithubRelease[]) {
    if (entry.draft === true || entry.prerelease === true) continue;
    if (typeof entry.tag_name !== "string") continue;
    const parsed = parseSemver(entry.tag_name);
    if (!parsed || parsed.prerelease !== null) continue;

    const version = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
    if (!best || isNewerVersion(version, best.version)) {
      best = { version, url: typeof entry.html_url === "string" ? entry.html_url : null };
    }
  }
  return best;
}
