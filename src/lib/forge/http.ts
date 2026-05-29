export interface HttpResponse {
  status: number;
  ok: boolean;
  body: string;
  /**
   * Response headers with lower-cased names. Optional so test fakes need only
   * populate what they assert on; pagination reads `x-next-page` from here.
   */
  headers?: Record<string, string>;
}

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Abstraction over `fetch` for forge REST calls. Production uses `fetchHttp`;
 * tests inject a fake so no real network request is made (mirrors the
 * `CommandRunner` seam used for CLI-based clients).
 *
 * Self-signed certificates / corporate proxies are handled at the Node runtime
 * level (NODE_EXTRA_CA_CERTS, HTTPS_PROXY, NODE_TLS_REJECT_UNAUTHORIZED), not
 * here — see docs/adr/015-gitlab-forge-support.md.
 */
export type HttpClient = (url: string, init?: HttpRequest) => Promise<HttpResponse>;

export const fetchHttp: HttpClient = async (url, init) => {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.headers,
    body: init?.body,
  });
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: res.status, ok: res.ok, body, headers };
};
