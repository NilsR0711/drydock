/** A cached conditional-request entry: the ETag and the body it validated. */
export interface EtagEntry {
  etag: string;
  body: string;
}

/**
 * In-memory store of ETags and their last-seen bodies, keyed by a stable
 * request identifier. Lets list fetches send `If-None-Match` and reuse the
 * cached body on a 304 — an unchanged list then costs no rate-limit budget.
 *
 * Process-scoped and best-effort: a restart simply re-fetches once. Bounded
 * implicitly by the small, fixed set of request keys Drydock issues.
 */
export class EtagCache {
  private readonly entries = new Map<string, EtagEntry>();

  get(key: string): EtagEntry | undefined {
    return this.entries.get(key);
  }

  set(key: string, etag: string, body: string): void {
    this.entries.set(key, { etag, body });
  }
}

/** Process-wide ETag cache shared by every GitHub client. */
export const sharedEtagCache = new EtagCache();
