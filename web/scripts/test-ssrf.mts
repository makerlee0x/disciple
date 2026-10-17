// Unit tests for the /api/img SSRF guards (W-2: lib/server/ipRanges + lib/server/safeFetch). Local only: DNS and fetch
// are injected, nothing goes over the network.   pnpm test:ssrf
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedIp, parseV6 } from "../lib/server/ipRanges";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { safeFetchImage, SafeFetchError, allowHostsFromEnv, pinnedAgent, pinnedLookup, type LookupFn } from "../lib/server/safeFetch";

test("blocked IPv4: private, loopback, link-local/metadata, CGNAT, multicast, reserved, docs, 0/8", () => {
  for (const ip of ["127.0.0.1", "127.1.2.3", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "169.254.0.1",
    "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "192.0.2.5", "198.18.0.1", "203.0.113.9", "192.0.0.8"])
    assert.equal(isBlockedIp(ip), true, ip);
});
test("public IPv4 allowed", () => {
  for (const ip of ["1.1.1.1", "8.8.8.8", "104.16.0.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.0", "169.253.255.255"])
    assert.equal(isBlockedIp(ip), false, ip);
});
test("blocked IPv6: loopback, unspecified, ULA, link-local, site-local, multicast, docs, 6to4/Teredo, IPv4-mapped private", () => {
  for (const ip of ["::1", "[::1]", "::", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "fec0::1", "ff02::1", "2001:db8::1", "2002:7f00:1::1", "2001::1",
    "::ffff:7f00:1", "[::ffff:7f00:1]", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "::127.0.0.1", "100::1"])
    assert.equal(isBlockedIp(ip), true, ip);
});
test("public IPv6 (and IPv4-mapped public) allowed; garbage blocked", () => {
  for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8", "::ffff:808:808"]) assert.equal(isBlockedIp(ip), false, ip);
  for (const ip of ["", "localhost", "example.com", "1.2.3", "1.2.3.256", ":::1", "1::2::3", "gggg::1"]) assert.equal(isBlockedIp(ip), true, ip);
  assert.equal(parseV6("::ffff:7f00:1"), parseV6("::ffff:127.0.0.1"));
});

const PUBLIC: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
const img = (bytes = 10, extra: Record<string, string> = {}) => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "image/png", ...extra } });
const err = async (p: Promise<unknown>, status: number) => { await assert.rejects(p, (e: unknown) => e instanceof SafeFetchError && e.status === status); };

test("URL literal hosts: [::ffff:7f00:1], 127.0.0.1, 169.254.169.254, decimal/hex forms are refused before fetch", async () => {
  let fetched = 0; const fetchImpl = (async () => { fetched++; return img(); }) as unknown as typeof fetch;
  for (const u of ["http://[::ffff:7f00:1]/a.png", "http://[::ffff:127.0.0.1]/a.png", "http://127.0.0.1/a.png", "http://169.254.169.254/latest/meta-data/", "http://2130706433/", "http://0x7f000001/", "http://[::1]/", "http://[fd00::1]/"])
    await err(safeFetchImage(u, { lookup: PUBLIC, fetchImpl }), 403);
  assert.equal(fetched, 0);
});
test("scheme, port and credentials", async () => {
  const fetchImpl = (async () => img()) as unknown as typeof fetch;
  for (const u of ["file:///etc/passwd", "ftp://x.com/a.png", "gopher://x.com/", "https://x.com:8443/a.png", "https://u:p@x.com/a.png"]) await err(safeFetchImage(u, { lookup: PUBLIC, fetchImpl }), 403);
  await err(safeFetchImage("not a url", { lookup: PUBLIC, fetchImpl }), 400);
});
test("hostname resolving to a private IP (any of several answers) is refused", async () => {
  const fetchImpl = (async () => img()) as unknown as typeof fetch;
  await err(safeFetchImage("https://evil.example/a.png", { lookup: async () => [{ address: "10.0.0.5", family: 4 }], fetchImpl }), 403);
  await err(safeFetchImage("https://evil.example/a.png", { lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "::ffff:7f00:1", family: 6 }], fetchImpl }), 403);
});
test("every redirect hop is re-validated; >3 redirects refused; fetch uses redirect:manual", async () => {
  const calls: string[] = [];
  const toPrivate = (async (u: URL, init: RequestInit) => { calls.push(String(u)); assert.equal(init.redirect, "manual"); return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }); }) as unknown as typeof fetch;
  await err(safeFetchImage("https://cdn.example/a.png", { lookup: PUBLIC, fetchImpl: toPrivate }), 403);
  assert.equal(calls.length, 1);
  let n = 0; const loop = (async () => { n++; return new Response(null, { status: 301, headers: { location: `/r${n}` } }); }) as unknown as typeof fetch;
  await err(safeFetchImage("https://cdn.example/a.png", { lookup: PUBLIC, fetchImpl: loop }), 508);
  assert.equal(n, 4);
  let m = 0; const ok = (async () => (++m < 3 ? new Response(null, { status: 302, headers: { location: "https://cdn2.example/b.png" } }) : img(4))) as unknown as typeof fetch;
  const r = await safeFetchImage("https://cdn.example/a.png", { lookup: PUBLIC, fetchImpl: ok });
  assert.equal(r.buf.byteLength, 4); assert.equal(r.finalUrl, "https://cdn2.example/b.png");
});
test("content-type must be image/* (not SVG); content-length and streamed bytes capped", async () => {
  await err(safeFetchImage("https://cdn.example/a", { lookup: PUBLIC, fetchImpl: (async () => new Response("hi", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch }), 415);
  await err(safeFetchImage("https://cdn.example/a", { lookup: PUBLIC, fetchImpl: (async () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })) as unknown as typeof fetch }), 415);
  await err(safeFetchImage("https://cdn.example/a", { lookup: PUBLIC, maxBytes: 100, fetchImpl: (async () => img(10, { "content-length": "1000" })) as unknown as typeof fetch }), 413);
  // lying / missing content-length: the stream is cut at the cap and the request aborted
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(64)); } });
  await err(safeFetchImage("https://cdn.example/a", { lookup: PUBLIC, maxBytes: 1000, fetchImpl: (async () => new Response(endless, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch }), 413);
  assert.ok(pulled < 40, `stopped early (${pulled} chunks)`);
  const r = await safeFetchImage("https://cdn.example/a", { lookup: PUBLIC, maxBytes: 100, fetchImpl: (async () => img(100)) as unknown as typeof fetch });
  assert.equal(r.buf.byteLength, 100); assert.equal(r.contentType, "image/png");
});
test("IMG_PROXY_ALLOW_HOSTS: enforced in addition to IP checks (subdomains match)", async () => {
  const allow = allowHostsFromEnv("cdn.dexscreener.com, *.example.org");
  assert.deepEqual(allow, ["cdn.dexscreener.com", "example.org"]);
  const fetchImpl = (async () => img()) as unknown as typeof fetch;
  await err(safeFetchImage("https://other.com/a.png", { lookup: PUBLIC, fetchImpl, allowHosts: allow }), 403);
  assert.ok(await safeFetchImage("https://cdn.dexscreener.com/a.png", { lookup: PUBLIC, fetchImpl, allowHosts: allow }));
  assert.ok(await safeFetchImage("https://img.example.org/a.png", { lookup: PUBLIC, fetchImpl, allowHosts: allow }));
  await err(safeFetchImage("https://cdn.dexscreener.com/a.png", { lookup: async () => [{ address: "127.0.0.1", family: 4 }], fetchImpl, allowHosts: allow }), 403);
  await err(safeFetchImage("https://evilexample.org/a.png", { lookup: PUBLIC, fetchImpl, allowHosts: allow }), 403);
});

/* ---- DNS-rebinding TOCTOU: the connection is pinned to the validated IP (undici Agent with a connect lookup) ---- */
test("each hop is fetched with a pinned dispatcher; DNS is resolved once per hop (no second lookup to rebind)", async () => {
  let lookups = 0; const seen: unknown[] = [];
  const rebinding: LookupFn = async () => (++lookups === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
  const fetchImpl = (async (_u: URL, init: RequestInit & { dispatcher?: unknown }) => { seen.push(init.dispatcher); return img(4); }) as unknown as typeof fetch;
  await safeFetchImage("https://cdn.example/a.png", { lookup: rebinding, fetchImpl });
  assert.equal(lookups, 1, "only our validated lookup ran");
  assert.ok(seen[0] instanceof Agent, "fetch got a pinned undici Agent");
  // IP-literal host: nothing to resolve, no dispatcher needed
  seen.length = 0; await safeFetchImage("https://93.184.216.34/a.png", { lookup: rebinding, fetchImpl });
  assert.equal(seen[0], undefined);
  // redirect: the second hop is re-resolved, re-validated and re-pinned (here the rebinding answer is refused)
  let n = 0; const redir = (async () => (++n === 1 ? new Response(null, { status: 302, headers: { location: "https://cdn.example/b.png" } }) : img(4))) as unknown as typeof fetch;
  lookups = 0; await err(safeFetchImage("https://cdn.example/a.png", { lookup: rebinding, fetchImpl: redir }), 403);
  assert.equal(n, 1);
});

const lk = (fn: ReturnType<typeof pinnedLookup>, host: string, opts: object) => new Promise<{ err: NodeJS.ErrnoException | null; a?: unknown; f?: number }>((res) => fn(host, opts as never, (err, a, f) => res({ err, a, f })));
test("pinnedLookup answers only the validated host with only the validated addresses", async () => {
  const fn = pinnedLookup("cdn.example", [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::1", family: 6 }]);
  assert.deepEqual(await lk(fn, "cdn.example", {}), { err: null, a: "93.184.216.34", f: 4 });
  assert.deepEqual(await lk(fn, "CDN.example.", { family: 6 }), { err: null, a: "2606:2800:220:1::1", f: 6 });
  assert.deepEqual((await lk(fn, "cdn.example", { all: true })).a, [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::1", family: 6 }]);
  assert.equal((await lk(fn, "evil.example", {})).err?.code, "ENOTFOUND");
  assert.equal((await lk(pinnedLookup("cdn.example", [{ address: "93.184.216.34", family: 4 }]), "cdn.example", { family: 6 })).err?.code, "ENOTFOUND");
});

async function listen(srv: ReturnType<typeof createServer>) { await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r)); return (srv.address() as AddressInfo).port; }
test("pinned Agent (real undici socket, local only): connects to the pinned IP, never to what DNS says; Host stays the hostname", async () => {
  const hosts: string[] = [];
  const srv = createServer((req: IncomingMessage, res) => { hosts.push(String(req.headers.host)); res.writeHead(200, { "content-type": "image/png" }); res.end("png"); });
  const port = await listen(srv);
  try {
    // a name that does not exist in DNS: only the pin can make it reach 127.0.0.1
    const a = pinnedAgent("img.rebind.invalid", [{ address: "127.0.0.1", family: 4 }]);
    const r = await undiciFetch(`http://img.rebind.invalid:${port}/x.png`, { dispatcher: a });
    assert.equal(await r.text(), "png");
    assert.equal(hosts[0], `img.rebind.invalid:${port}`);
    await a.destroy();
    // "localhost" really resolves to 127.0.0.1 (the server), but the pin says 127.0.0.2 (nothing listens): refused
    const b = pinnedAgent("localhost", [{ address: "127.0.0.2", family: 4 }]);
    await assert.rejects(undiciFetch(`http://localhost:${port}/x.png`, { dispatcher: b }));
    assert.equal(hosts.length, 1, "the rebinding target was never contacted");
    await b.destroy();
  } finally { srv.close(); }
});

test("pinned Agent over TLS: SNI is the original hostname, not the pinned IP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ssrf-tls-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=img.rebind.invalid", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1"], { stdio: "ignore" });
    const snis: (string | undefined)[] = [];
    const srv = createTlsServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (req, res) => { snis.push((req.socket as unknown as { servername?: string }).servername); res.writeHead(200, { "content-type": "image/png" }); res.end("ok"); });
    const port = await listen(srv as unknown as ReturnType<typeof createServer>);
    try {
      // same pinned lookup as pinnedAgent, plus trust for the throwaway self-signed cert (test only)
      const a = new Agent({ connect: { lookup: pinnedLookup("img.rebind.invalid", [{ address: "127.0.0.1", family: 4 }]) as never, ca: readFileSync(join(dir, "c.pem")) } });
      const r = await undiciFetch(`https://img.rebind.invalid:${port}/x.png`, { dispatcher: a });
      assert.equal(await r.text(), "ok");
      assert.equal(snis[0], "img.rebind.invalid");
      await a.destroy();
    } finally { srv.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
