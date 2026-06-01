/**
 * SSRF / token-replay guards for forge HTTP calls (issue #110). A repo's API
 * base URL is operator-supplied; before we attach a `PRIVATE-TOKEN`/`Bearer`
 * credential and fetch server-side, validate the scheme and refuse private,
 * loopback, link-local and cloud-metadata targets unless the operator has
 * explicitly opted in for a self-hosted instance.
 */
import { ForgeError } from "./types";

/** True when `value` is an absolute `http`/`https` URL (scheme allowlist). */
export function isValidForgeBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

function ipv4Octets(host: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  const parts = host.split(".").map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

function isPrivateIpv4(host: string): boolean {
  const o = ipv4Octets(host);
  if (!o) return false;
  const [a, b] = o as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) — reuse the v4 rules on the embedded address.
  const mapped = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  if (h.startsWith("fe80")) return true; // link-local
  // Unique local addresses fc00::/7 (fc.. and fd..).
  if (/^f[cd]/.test(h)) return true;
  return false;
}

/**
 * True for hosts that must not receive a forge token without an explicit
 * opt-in. IP literals are classified by range; bare DNS names are not resolved
 * here (DNS-rebinding is out of scope for this defense-in-depth control).
 */
export function isPrivateOrReservedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.includes(":")) return isPrivateIpv6(host);
  if (ipv4Octets(host)) return isPrivateIpv4(host);
  return false;
}

/**
 * Throw a {@link ForgeError} unless `url` is a safe target for a token-bearing
 * request: an `http(s)` URL whose host is public, or private with
 * `allowPrivate` set (self-hosted opt-in).
 */
export function assertSafeForgeUrl(url: string, opts: { allowPrivate?: boolean } = {}): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ForgeError(`invalid forge URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ForgeError(`forge URL must use http(s): ${parsed.protocol}`);
  }
  if (!opts.allowPrivate && isPrivateOrReservedHost(parsed.hostname)) {
    throw new ForgeError(
      `refusing to send forge token to private/loopback address ${parsed.hostname}; ` +
        "set DRYDOCK_ALLOW_PRIVATE_FORGE=1 to allow a self-hosted instance",
    );
  }
}

/** Whether the operator has opted in to private/self-hosted forge targets. */
export function privateForgeAllowedFromEnv(): boolean {
  const v = process.env.DRYDOCK_ALLOW_PRIVATE_FORGE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
