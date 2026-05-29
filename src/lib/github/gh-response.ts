/** A parsed HTTP response from `gh api --include` output. */
export interface IncludeResponse {
  /** HTTP status code, or null when no status line was present. */
  status: number | null;
  /** Response headers with lower-cased names. */
  headers: Record<string, string>;
  /** Response body (everything after the final header block). */
  body: string;
}

/**
 * Parse the raw stdout of `gh api --include` into status, headers, and body.
 *
 * `gh` prints one or more header blocks (intermediate 1xx/3xx blocks may
 * precede the final response) followed by a blank line and the body. We take
 * the last `HTTP/` status block as authoritative and treat everything after
 * its first blank line as the body, so a JSON body containing blank lines is
 * preserved verbatim.
 */
export function parseIncludeResponse(raw: string): IncludeResponse {
  const text = raw.replace(/\r\n/g, "\n");

  // Locate the final status block: the last "HTTP/..." line in the stream.
  const lastStatusIdx = text.lastIndexOf("\nHTTP/");
  const start = lastStatusIdx >= 0 ? lastStatusIdx + 1 : text.startsWith("HTTP/") ? 0 : -1;
  if (start < 0) {
    return { status: null, headers: {}, body: raw };
  }

  const block = text.slice(start);
  const sep = block.indexOf("\n\n");
  const headerBlock = sep >= 0 ? block.slice(0, sep) : block;
  const body = sep >= 0 ? block.slice(sep + 2) : "";

  const lines = headerBlock.split("\n");
  const statusLine = lines.shift() ?? "";
  const statusMatch = statusLine.match(/^HTTP\/\S+\s+(\d+)/);
  const status = statusMatch ? Number(statusMatch[1]) : null;

  const headers: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    headers[name] = line.slice(idx + 1).trim();
  }

  return { status, headers, body };
}

/**
 * Extract the `rel="next"` URL from a GitHub `Link` header, or null when there
 * is no further page. The header lists comma-separated `<url>; rel="..."`
 * entries; only the `next` relation is followed when paginating a list.
 */
export function parseNextLink(link: string | undefined): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (match?.[1]) return match[1];
  }
  return null;
}
