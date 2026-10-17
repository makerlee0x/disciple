/**
 * SSRF-safe image fetch for /api/img (W-2).
 *  - http/https only, default ports only, no credentials in the URL
 *  - every hop is re-validated: fetch with redirect:"manual", at most MAX_REDIRECTS redirects
 *  - DNS resolved (dns.promises.lookup, all: true) and EVERY resolved address checked against lib/server/ipRanges
 *    (private, loopback, link-local + 169.254.169.254 metadata, CGNAT, multicast, reserved, IPv6 ULA/link-local,
 *    IPv4-mapped IPv6); IP-literal hosts are checked directly
 *  - optional allowlist IMG_PROXY_ALLOW_HOSTS (comma-separated hosts; subdomains match): when set it is enforced IN
 *    ADDITION to the IP checks (it skips nothing)
 *  - image/* content-type required (SVG refused: it would be script on our origin); content-length checked; body
 *    streamed with a hard byte cap, aborting the request beyond it
 * TOCTOU limit: Vercel's fetch can't be pinned to the IP we validated, so a hostile DNS server could answer a public IP
 * to our lookup and a private one to fetch's own lookup (DNS rebinding). Short of a pinned-socket client, the residual
 * risk is bounded by: no response body is returned unless it is an image/* under the cap, redirects are re-checked,
 * and IMG_PROXY_ALLOW_HOSTS can restrict fetches to known CDNs. Pure node (no server-only): scripts/test-ssrf.mts.
 */
import { promises as dns } from "dns";
import { isIP } from "net";
import { isBlockedIp } from "./ipRanges";

export const IMG_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
export class SafeFetchError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;
export type SafeFetchOpts = {
  maxBytes?: number; maxRedirects?: number; timeoutMs?: number; allowHosts?: string[];
  lookup?: LookupFn; fetchImpl?: typeof fetch;
};
const defaultLookup: LookupFn = (h) => dns.lookup(h, { all: true, verbatim: true });

export const allowHostsFromEnv = (v = process.env.IMG_PROXY_ALLOW_HOSTS) =>
  (v || "").split(/[\s,]+/).map((h) => h.trim().toLowerCase().replace(/^\*\./, "")).filter(Boolean);
export const hostAllowed = (host: string, allow: string[]) => !allow.length || allow.some((a) => host === a || host.endsWith("." + a));

/** Validates one URL (scheme, port, credentials, allowlist, resolved IPs). Throws SafeFetchError. */
export async function checkUrl(u: URL, o: SafeFetchOpts = {}): Promise<void> {
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new SafeFetchError(403, "scheme not allowed");
  if (u.username || u.password) throw new SafeFetchError(403, "credentials not allowed");
  if (u.port && u.port !== "80" && u.port !== "443") throw new SafeFetchError(403, "port not allowed");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) throw new SafeFetchError(400, "no host");
  if (!hostAllowed(host, o.allowHosts ?? [])) throw new SafeFetchError(403, "host not in IMG_PROXY_ALLOW_HOSTS");
  if (isIP(host)) { if (isBlockedIp(host)) throw new SafeFetchError(403, "address not allowed"); return; }
  let addrs: { address: string }[];
  try { addrs = await (o.lookup ?? defaultLookup)(host); } catch { throw new SafeFetchError(502, "dns lookup failed"); }
  if (!addrs.length) throw new SafeFetchError(502, "dns lookup failed");
  if (addrs.some((a) => isBlockedIp(a.address))) throw new SafeFetchError(403, "address not allowed");
}

export async function safeFetchImage(raw: string, o: SafeFetchOpts = {}): Promise<{ buf: Buffer; contentType: string; finalUrl: string }> {
  const max = o.maxBytes ?? IMG_MAX_BYTES, hops = o.maxRedirects ?? MAX_REDIRECTS, f = o.fetchImpl ?? fetch;
  let u: URL;
  try { u = new URL(raw); } catch { throw new SafeFetchError(400, "bad url"); }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 5000);
  try {
    for (let hop = 0; ; hop++) {
      await checkUrl(u, o);
      let r: Response;
      try { r = await f(u, { redirect: "manual", signal: ac.signal, headers: { "user-agent": "Mozilla/5.0 DISCIPLE-icon-proxy", accept: "image/*" } }); }
      catch { throw new SafeFetchError(502, "upstream failed"); }
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        await r.body?.cancel().catch(() => undefined);
        if (!loc) throw new SafeFetchError(502, "redirect without location");
        if (hop >= hops) throw new SafeFetchError(508, "too many redirects");
        try { u = new URL(loc, u); } catch { throw new SafeFetchError(502, "bad redirect"); }
        continue;
      }
      const ct = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!r.ok || !ct.startsWith("image/") || ct.includes("svg")) { await r.body?.cancel().catch(() => undefined); throw new SafeFetchError(415, "not an image"); }
      const len = Number(r.headers.get("content-length") || "0");
      if (len > max) { await r.body?.cancel().catch(() => undefined); throw new SafeFetchError(413, "too large"); }
      if (!r.body) throw new SafeFetchError(502, "empty body");
      const reader = r.body.getReader(), chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) { ac.abort(); await reader.cancel().catch(() => undefined); throw new SafeFetchError(413, "too large"); }
        chunks.push(value);
      }
      return { buf: Buffer.concat(chunks), contentType: ct, finalUrl: u.toString() };
    }
  } catch (e) {
    if (e instanceof SafeFetchError) throw e;
    throw new SafeFetchError(ac.signal.aborted ? 504 : 502, "upstream failed");
  } finally { clearTimeout(timer); }
}
