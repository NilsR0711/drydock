/**
 * Pure string utilities shared by the cross-job log search (issue #409). These
 * have no database or React dependency so both the query layer
 * (`queries.ts`, FTS/LIKE matching) and the client components (history snippet,
 * in-viewer find) can import them.
 *
 * Match highlighting is carried as sentinel-delimited text rather than HTML:
 * the SQLite `snippet()` call and the LIKE fallback wrap each hit in these two
 * control characters, and the UI splits on them into `<mark>` segments. Control
 * characters are used because agent output is JSON text where raw U+0001/U+0002
 * never appear (they serialize as a six-character `\uXXXX` escape), so the
 * sentinels can never collide with real payload content or inject markup.
 */
export const MATCH_START = String.fromCharCode(1);
export const MATCH_END = String.fromCharCode(2);

/**
 * Turn a user term into a safe FTS5 `MATCH` argument. The whole term is wrapped
 * in one double-quoted phrase (with embedded quotes doubled, per FTS5 escaping)
 * so query operators (`OR`, `NOT`, `*`, `:`, `-`, parentheses) are matched as
 * literal text instead of being parsed as syntax. A phrase still tokenizes
 * normally, so punctuation inside the term (`/`, `.`, `_`, `%`) becomes token
 * separators and the search behaves like a literal substring over tokens.
 */
export function escapeFtsMatch(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * Build a LIKE pattern for a case-insensitive substring match, escaping the
 * LIKE metacharacters (`%`, `_`, `\`) so a literal search for `100%` or
 * `re_name` matches only those characters. Pair with `ESCAPE '\'` in the query.
 * Mirrors the issue-title escaping already used by `listJobsPage`.
 */
export function escapeLikePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

const SNIPPET_WINDOW = 48;

/**
 * Build a highlighted excerpt of `payload` around the first case-insensitive
 * occurrence of `term`, used by the LIKE fallback where SQLite's `snippet()`
 * is unavailable. The match is wrapped in the sentinel markers and the excerpt
 * is bounded to a short window with `…` ellipses on truncated ends. When the
 * term is absent (e.g. it matched a sibling event, not this one) a leading slice
 * is returned so the row still shows some context.
 */
export function buildLikeSnippet(payload: string, term: string, window = SNIPPET_WINDOW): string {
  if (term.length === 0) return truncate(payload, window * 2);
  const idx = payload.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return truncate(payload, window * 2);

  const matchEnd = idx + term.length;
  const start = Math.max(0, idx - window);
  const end = Math.min(payload.length, matchEnd + window);
  const before = payload.slice(start, idx);
  const hit = payload.slice(idx, matchEnd);
  const after = payload.slice(matchEnd, end);
  const lead = start > 0 ? "…" : "";
  const trail = end < payload.length ? "…" : "";
  return `${lead}${before}${MATCH_START}${hit}${MATCH_END}${after}${trail}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Split sentinel-delimited snippet text into plain/matched segments for the UI
 * to render (matched segments become `<mark>`). Tolerant of a dangling start
 * marker with no end: the remainder is treated as a match rather than throwing.
 */
export function splitByMarkers(text: string): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(MATCH_START, i);
    if (start === -1) {
      pushPlain(segments, text.slice(i));
      break;
    }
    pushPlain(segments, text.slice(i, start));
    const end = text.indexOf(MATCH_END, start + 1);
    if (end === -1) {
      // Unbalanced start marker: keep the rest as a match, drop the marker.
      pushMatch(segments, text.slice(start + 1));
      break;
    }
    pushMatch(segments, text.slice(start + 1, end));
    i = end + 1;
  }
  return segments.length > 0 ? segments : [{ text: "", match: false }];
}

/**
 * Split `text` on every case-insensitive occurrence of `query` into
 * plain/matched segments, preserving the original casing of the text. An empty
 * query yields a single unmarked segment.
 */
export function splitByQuery(text: string, query: string): HighlightSegment[] {
  if (query.length === 0) return [{ text, match: false }];
  const segments: HighlightSegment[] = [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const hit = haystack.indexOf(needle, i);
    if (hit === -1) {
      pushPlain(segments, text.slice(i));
      break;
    }
    pushPlain(segments, text.slice(i, hit));
    pushMatch(segments, text.slice(hit, hit + query.length));
    i = hit + query.length;
  }
  return segments.length > 0 ? segments : [{ text: "", match: false }];
}

function pushPlain(segments: HighlightSegment[], text: string): void {
  if (text.length > 0) segments.push({ text, match: false });
}

function pushMatch(segments: HighlightSegment[], text: string): void {
  if (text.length > 0) segments.push({ text, match: true });
}
