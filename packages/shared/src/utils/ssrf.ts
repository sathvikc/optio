import * as dns from "node:dns/promises";

/**
 * SSRF protection utilities.
 *
 * Two layers of defence:
 *  1. `isSsrfSafeUrl` — synchronous, checks the URL string for obvious
 *     private/internal hostnames and IP literals.  Use in Zod schemas.
 *  2. `assertSsrfSafe` — async, resolves the hostname via DNS and verifies
 *     the resulting IP is not private.  Call immediately before every `fetch`.
 */

// ── Private / reserved IP helpers ────────────────────────────────────────────

function ipToLong(ip: string): number {
  const parts = ip.split(".").map(Number);

  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isInCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split("/");
  const mask = ~((1 << (32 - Number(bits))) - 1) >>> 0;
  return (ipToLong(ip) & mask) === (ipToLong(base) & mask);
}

const BLOCKED_CIDRS = [
  "10.0.0.0/8", // RFC 1918
  "172.16.0.0/12", // RFC 1918
  "192.168.0.0/16", // RFC 1918
  "127.0.0.0/8", // Loopback
  "169.254.0.0/16", // Link-local (AWS/GCP metadata)
  "0.0.0.0/8", // "This" network
];

function isPrivateIPv4(ip: string): boolean {
  return BLOCKED_CIDRS.some((cidr) => isInCidr(ip, cidr));
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // ::1 loopback
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  // fe80::/10 link-local
  if (lower.startsWith("fe80:")) return true;
  // fc00::/7 unique-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // :: unspecified
  if (lower === "::") return true;
  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const v4Mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPrivateIPv4(v4Mapped[1]);
  return false;
}

// ── Hostname checks (synchronous) ───────────────────────────────────────────

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /\.local$/i, // mDNS / .local TLD
  /\.svc\.cluster\.local$/i, // K8s internal
  /\.internal$/i, // common internal TLD
];

/**
 * Quick IPv4 literal regex — does NOT validate range, just shape.
 */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isBlockedHostname(hostname: string): boolean {
  // Check patterns
  if (BLOCKED_HOST_PATTERNS.some((re) => re.test(hostname))) return true;

  // If the hostname is an IPv4 literal, check the CIDR ranges
  if (IPV4_RE.test(hostname) && isPrivateIPv4(hostname)) return true;

  // Bracket-stripped IPv6 literal
  const v6 = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (v6.includes(":") && isPrivateIPv6(v6)) return true;

  return false;
}

// ── Public API ──────────────────────────────────────────────────────────────

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/**
 * Synchronous URL-string check.  Returns `true` if the URL appears safe
 * (no obviously private/internal hostname).  Returns `false` otherwise.
 *
 * Designed for Zod `.refine()` — does NOT resolve DNS.
 */
export function isSsrfSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Only allow http(s)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

    return !isBlockedHostname(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Synchronous hostname check for bare hostnames (not full URLs).
 * Constructs a URL with https:// prefix and validates.
 *
 * Designed for Zod `.refine()` on hostname-only fields like GitLab `host`.
 */
export function isSsrfSafeHost(host: string): boolean {
  return isSsrfSafeUrl(`https://${host}/`);
}

/**
 * Async guard that resolves the hostname and verifies the IP is not private.
 * Throws `SsrfError` if the URL targets an internal address.
 *
 * Call immediately before every outbound `fetch()`.
 */
export async function assertSsrfSafe(url: string): Promise<void> {
  // Re-run the cheap synchronous check first
  if (!isSsrfSafeUrl(url)) {
    throw new SsrfError(`URL targets a blocked address: ${url}`);
  }

  const parsed = new URL(url);
  const hostname = parsed.hostname;

  // Skip DNS resolution for IP literals — already checked above
  if (IPV4_RE.test(hostname)) return;
  const v6 = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (v6.includes(":")) return;

  // Resolve hostname and check resulting IPs (catches DNS rebinding)
  try {
    const { address, family } = await dns.lookup(hostname);
    if (family === 4 && isPrivateIPv4(address)) {
      throw new SsrfError(`DNS resolved ${hostname} to private address ${address}`);
    }
    if (family === 6 && isPrivateIPv6(address)) {
      throw new SsrfError(`DNS resolved ${hostname} to private address ${address}`);
    }
  } catch (err) {
    if (err instanceof SsrfError) throw err;
    // DNS resolution failure — allow the fetch to fail naturally
    // (e.g. NXDOMAIN will cause fetch to error anyway)
  }
}
