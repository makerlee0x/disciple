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
 *  - DNS-rebinding TOCTOU closed: each hop is fetched through a fresh undici Agent whose connect `lookup` returns ONLY the
 *    addresses validated above (pinnedLookup), so the socket goes to the checked IP and no second DNS query happens.
 *    The URL keeps the hostname, so the Host header and TLS SNI / certificate check use the original name.
 *    Requires the Node.js runtime (app/api/img/route.ts: runtime = "nodejs"; undici is a server external package).
 * Pure node (no server-only): scripts/test-ssrf.mts.
 */
import { promises as dns } from "dns";
import { isIP } from "net";
import type { LookupAddress, LookupOptions } from "dns";
import { Agent, fetch as undiciFetch } from "undici";
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

type Addr = { address: string; family: number };
const normHost = (h: string) => h.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;
/**
 * net/tls `lookup` that never queries DNS: it answers only for the validated host, only with the validated addresses
 * (honouring options.family / options.all as Node's happy-eyeballs connect may ask for either form).
 */
export function pinnedLookup(host: string, addrs: Addr[]) {
  const want = normHost(host);
  return (hostname: string, options: LookupOptions | LookupCb, cb?: LookupCb) => {
    if (typeof options === "function") { cb = options; options = {}; }
    const fail = (m: string) => cb!(Object.assign(new Error(m), { code: "ENOTFOUND" }));
    if (normHost(hostname) !== want) return fail("pinned lookup: unexpected host");
    const fam = options.family === 4 || options.family === "IPv4" ? 4 : options.family === 6 || options.family === "IPv6" ? 6 : 0;
    const list = fam ? addrs.filter((a) => a.family === fam) : addrs;
    if (!list.length) return fail("pinned lookup: no validated address for this family");
    if (options.all) cb!(null, list.map((a) => ({ address: a.address, family: a.family })));
    else cb!(null, list[0].address, list[0].family);
  };
}
/** undici dispatcher whose connections can only reach the pre-validated addresses of `host` (SNI/Host stay `host`). */
export const pinnedAgent = (host: string, addrs: Addr[]) =>
  new Agent({ connect: { lookup: pinnedLookup(host, addrs) as never }, connections: 2, pipelining: 0 });

/**
 * Validates one URL (scheme, port, credentials, allowlist, resolved IPs). Throws SafeFetchError. Returns the
 * normalised host and the validated addresses the fetch must be pinned to (empty for an IP-literal host: no lookup).
 */
export async function checkUrl(u: URL, o: SafeFetchOpts = {}): Promise<{ host: string; addrs: Addr[] }> {
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new SafeFetchError(403, "scheme not allowed");
  if (u.username || u.password) throw new SafeFetchError(403, "credentials not allowed");
  if (u.port && u.port !== "80" && u.port !== "443") throw new SafeFetchError(403, "port not allowed");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) throw new SafeFetchError(400, "no host");
  if (!hostAllowed(host, o.allowHosts ?? [])) throw new SafeFetchError(403, "host not in IMG_PROXY_ALLOW_HOSTS");
  if (isIP(host)) { if (isBlockedIp(host)) throw new SafeFetchError(403, "address not allowed"); return { host, addrs: [] }; }
  let addrs: Addr[];
  try { addrs = await (o.lookup ?? defaultLookup)(host); } catch { throw new SafeFetchError(502, "dns lookup failed"); }
  if (!addrs.length) throw new SafeFetchError(502, "dns lookup failed");
  if (addrs.some((a) => isBlockedIp(a.address))) throw new SafeFetchError(403, "address not allowed");
  return { host, addrs: addrs.map((a) => ({ address: a.address, family: a.family === 6 || isIP(a.address) === 6 ? 6 : 4 })) };
}

export async function safeFetchImage(raw: string, o: SafeFetchOpts = {}): Promise<{ buf: Buffer; contentType: string; finalUrl: string }> {
  // undici's own fetch (not Next's patched global): it honours `dispatcher`, so the pinned Agent is really used
  const max = o.maxBytes ?? IMG_MAX_BYTES, hops = o.maxRedirects ?? MAX_REDIRECTS, f = o.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
  const agents: Agent[] = [];
  let u: URL;
  try { u = new URL(raw); } catch { throw new SafeFetchError(400, "bad url"); }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 5000);
  try {
    for (let hop = 0; ; hop++) {
      const { host, addrs } = await checkUrl(u, o);
      const dispatcher = addrs.length ? pinnedAgent(host, addrs) : undefined; // IP literal: connect needs no lookup
      if (dispatcher) agents.push(dispatcher);
      let r: Response;
      try { r = await f(u, { redirect: "manual", signal: ac.signal, headers: { "user-agent": "Mozilla/5.0 DISCIPLE-icon-proxy", accept: "image/*" }, ...(dispatcher ? { dispatcher } : {}) } as RequestInit); }
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
  } finally { clearTimeout(timer); for (const a of agents) void a.destroy().catch(() => undefined); }
}
