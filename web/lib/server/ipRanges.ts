/**
 * Blocked address ranges for server-side fetches of user-supplied URLs (W-2 SSRF, /api/img). Checked on the RESOLVED
 * IP, not the hostname. Pure (no server-only): unit-tested by scripts/test-ssrf.mts.
 */
import { isIP } from "net";

const v4 = (s: string): number | null => {
  const p = s.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) { if (!/^\d{1,3}$/.test(x) || Number(x) > 255) return null; n = n * 256 + Number(x); }
  return n;
};
const cidr4 = (base: string, bits: number) => ({ net: v4(base)!, mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0 });
/** Private, loopback, link-local (incl. 169.254.169.254 metadata), CGNAT, multicast, reserved, documentation, benchmarking. */
const BLOCKED_V4 = [
  cidr4("0.0.0.0", 8), cidr4("10.0.0.0", 8), cidr4("100.64.0.0", 10), cidr4("127.0.0.0", 8), cidr4("169.254.0.0", 16),
  cidr4("172.16.0.0", 12), cidr4("192.0.0.0", 24), cidr4("192.0.2.0", 24), cidr4("192.88.99.0", 24), cidr4("192.168.0.0", 16),
  cidr4("198.18.0.0", 15), cidr4("198.51.100.0", 24), cidr4("203.0.113.0", 24), cidr4("224.0.0.0", 4), cidr4("240.0.0.0", 4),
];
export function isBlockedV4(ip: string): boolean {
  const n = v4(ip);
  if (n === null) return true;
  return BLOCKED_V4.some((c) => ((n & c.mask) >>> 0) === c.net);
}

/** IPv6 text → 128-bit bigint (supports :: and a trailing dotted IPv4). null if malformed. */
export function parseV6(s: string): bigint | null {
  let str = s.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const m = str.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) { const n = v4(m[2]); if (n === null) return null; str = `${m[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`; }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [], tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  let n = BigInt(0);
  for (const g of groups) { if (!/^[0-9a-f]{1,4}$/.test(g)) return null; n = (n << BigInt(16)) | BigInt(parseInt(g, 16)); }
  return n;
}
const in6 = (n: bigint, base: string, bits: number) => (n >> BigInt(128 - bits)) === (parseV6(base)! >> BigInt(128 - bits));
const embeddedV4 = (n: bigint) => { const x = Number(n & BigInt(0xffffffff)); return `${x >>> 24}.${(x >>> 16) & 255}.${(x >>> 8) & 255}.${x & 255}`; };

export function isBlockedV6(ip: string): boolean {
  const n = parseV6(ip);
  if (n === null) return true;
  // IPv4-mapped (::ffff:a.b.c.d, e.g. [::ffff:7f00:1] = 127.0.0.1), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::/96): judge the IPv4
  if (in6(n, "::ffff:0:0", 96) || in6(n, "64:ff9b::", 96)) return isBlockedV4(embeddedV4(n));
  if (in6(n, "::", 96)) return true;          // ::, ::1, IPv4-compatible (deprecated)
  if (!in6(n, "2000::", 3)) return true;      // only global unicast: blocks fc00::/7 ULA, fe80::/10 link-local, fec0::/10, ff00::/8 multicast, 100::/64 …
  return in6(n, "2001::", 23) || in6(n, "2001:db8::", 32) || in6(n, "2002::", 16);   // IETF/Teredo, documentation, 6to4
}
/** true if `ip` must not be fetched. Anything that isn't a valid IP literal is blocked. */
export function isBlockedIp(ip: string): boolean {
  const s = ip.replace(/^\[|\]$/g, "");
  const kind = isIP(s.split("%")[0]);
  if (kind === 4) return isBlockedV4(s);
  if (kind === 6) return isBlockedV6(s);
  return true;
}
