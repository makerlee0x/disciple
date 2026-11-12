// Client read transport (lib/rpc/readTransport): direct public RPC → /api/rpc failover, sticky proxy-first, labels.
// Real viem http() against local flaky servers. pnpm test:read-transport
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import { RouteState, readTransport, labelRead, readFailure, shouldFailover, browserProxyUrl, type RpcAttempt } from "../lib/rpc/readTransport";
import { flooredTransport, ReadFloor } from "../lib/trade/readFloor";
import { tradeNetworkError } from "../lib/protocol-viem";
import { NETWORK_MSG } from "../lib/aa/relayOp";

type Mode = "ok" | "cors400" | "503" | "429" | "drop" | "hang" | "revert" | "behind";
function rpcServer(name: string) {
  const st = { mode: "ok" as Mode, hits: 0, methods: [] as string[], batches: [] as number[] };
  const srv: Server = createServer((rq, rs) => {
    let b = ""; rq.on("data", (c) => (b += c)); rq.on("end", () => {
      st.hits++;
      const parsed = JSON.parse(b), isBatch = Array.isArray(parsed), j = isBatch ? parsed[0] : parsed;
      if (isBatch) st.batches.push(parsed.length);
      for (const x of isBatch ? parsed : [parsed]) st.methods.push(x.method);
      const send = (status: number, v: unknown, h: Record<string, string> = {}) => { rs.writeHead(status, { "content-type": "application/json", ...h }); rs.end(typeof v === "string" ? v : JSON.stringify(v)); };
      switch (st.mode) {
        case "ok": {
          const one = (x: { id: unknown; method: string }) => ({ jsonrpc: "2.0", id: x.id, result: x.method === "eth_chainId" ? "0xb626" : "0x" + "00".repeat(31) + "2a" });
          return send(200, isBatch ? parsed.map(one) : one(j));
        }
        case "cors400": return send(400, "<html>400 Bad Request</html>", { "content-type": "text/html", "access-control-allow-origin": "*,*" });
        case "503": return send(503, "upstream", { "content-type": "text/plain" });
        case "429": return send(429, { error: "rate limited" });
        case "drop": return rq.socket.destroy();
        case "hang": return;   // never answers
        case "revert": return send(200, { jsonrpc: "2.0", id: j.id, error: { code: 3, message: "execution reverted", data: "0x" } });
        case "behind": return send(200, { jsonrpc: "2.0", id: j.id, error: { code: -32000, message: "unsupported block number 12345" } });
      }
    });
  });
  return new Promise<{ url: string; st: typeof st; srv: Server; name: string }>((res) => srv.listen(0, "127.0.0.1", () => res({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, st, srv, name })));
}
const pub = await rpcServer("public"), prox = await rpcServer("proxy");
after(() => { pub.srv.closeAllConnections(); prox.srv.closeAllConnections(); pub.srv.close(); prox.srv.close(); });
const reset = () => { for (const s of [pub, prox]) { s.st.mode = "ok"; s.st.hits = 0; s.st.methods = []; s.st.batches = []; } };
const logs: unknown[] = [];
let now = 1_000_000;
function client(state = new RouteState(() => now)) {
  return createPublicClient({ transport: readTransport({ directUrl: pub.url, proxyUrl: prox.url, directTimeoutMs: 300, proxyTimeoutMs: 2000, proxyRetryCount: 1, state, log: (m, d) => logs.push([m, d]), clock: () => now }) }) as PublicClient;
}
const ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const read = (pc: PublicClient) => pc.readContract({ address: "0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D", abi: ABI, functionName: "balanceOf", args: ["0x0000000000000000000000000000000000000001"] });

test("healthy: reads go direct only (0 proxy calls, 0 extra hops)", async () => {
  reset();
  const pc = client();
  assert.equal(await read(pc), 42n);
  assert.equal(await pc.getBalance({ address: "0x0000000000000000000000000000000000000001" }), 42n);
  assert.equal(pub.st.hits, 2); assert.equal(prox.st.hits, 0);
});

for (const mode of ["cors400", "503", "429", "drop", "hang"] as Mode[]) {
  test(`public RPC ${mode}: the OLD client (plain http) fails; the new one answers via the proxy, then sticks to it`, async () => {
    reset(); pub.st.mode = mode;
    const old = createPublicClient({ transport: http(pub.url, { retryCount: 0, timeout: 300 }) });
    await assert.rejects(read(old as PublicClient), (e: Error) => /HTTP request failed|took too long|fetch failed|socket|other side closed/i.test(String(e.message)));
    pub.st.hits = 0;
    const st = new RouteState(() => now), pc = client(st);
    assert.equal(await read(pc), 42n);
    assert.equal(pub.st.hits, 1); assert.equal(prox.st.hits, 1);
    assert.ok(st.proxyFirst());
    // sticky: the next read skips the broken direct path
    assert.equal(await read(pc), 42n);
    assert.equal(pub.st.hits, 1); assert.equal(prox.st.hits, 2);
    // after the window, direct is tried first again (and, healthy, clears the window)
    pub.st.mode = "ok"; now += 31_000;
    assert.equal(await read(pc), 42n);
    assert.equal(pub.st.hits, 2); assert.equal(prox.st.hits, 2); assert.ok(!st.proxyFirst());
  });
}

test("proxy path batches same-tick reads into ONE request (one function invocation)", async () => {
  reset();
  const st = new RouteState(() => now); st.directFailed(30_000);
  const pc = client(st);
  const [a, b, c] = await Promise.all([read(pc), pc.getBalance({ address: "0x0000000000000000000000000000000000000001" }), read(pc)]);
  assert.deepEqual([a, b, c], [42n, 42n, 42n]);
  assert.equal(prox.st.hits, 1); assert.deepEqual(prox.st.batches, [3]); assert.equal(pub.st.hits, 0);
});

test("proxy-first, proxy broken: falls back to direct", async () => {
  reset();
  const st = new RouteState(() => now); st.directFailed(30_000);
  prox.st.mode = "503";
  assert.equal(await read(client(st)), 42n);
  assert.ok(prox.st.hits >= 1); assert.equal(pub.st.hits, 1);
});

test("node answers never fail over: revert and 'unsupported block number' (read floor's job)", async () => {
  for (const mode of ["revert", "behind"] as Mode[]) {
    reset(); pub.st.mode = mode;
    await assert.rejects(read(client()));
    assert.equal(pub.st.hits, 1, mode); assert.equal(prox.st.hits, 0, mode);
  }
});

test("non-read methods stay direct-only (never sent to the proxy)", async () => {
  reset(); pub.st.mode = "503";
  await assert.rejects(client().request({ method: "eth_getLogs" as never, params: [{}] as never }));
  await assert.rejects(client().request({ method: "eth_sendRawTransaction" as never, params: ["0x00"] as never }));
  assert.equal(prox.st.hits, 0);
});

test("both paths down: one labeled error with every attempt; tradeNetworkError logs read + url, copy unchanged", async () => {
  reset(); pub.st.mode = "cors400"; prox.st.mode = "503";
  const err = await labelRead("quote", read(client())).catch((e) => e);
  const f = readFailure(err);
  assert.equal(f.read, "quote");
  const at = f.attempts as RpcAttempt[];
  assert.deepEqual(at.map((a) => a.via), ["direct", "proxy"]);
  assert.equal(at[0].url, pub.url); assert.equal(at[0].status, 400); assert.equal(at[1].url, prox.url); assert.equal(at[1].status, 503);
  assert.equal(prox.st.hits, 2);   // proxy path: 1 viem retry
  const w = console.warn, seen: unknown[][] = []; console.warn = (...a: unknown[]) => seen.push(a);
  try {
    const pe = tradeNetworkError(err)!;
    assert.equal(pe.code, "Network"); assert.equal(pe.message, NETWORK_MSG);
  } finally { console.warn = w; }
  const line = seen.find((a) => String(a[0]).includes("trade failed before sending (network)"))!;
  const d = line[1] as { read: string; url: string; attempts: RpcAttempt[] };
  assert.equal(d.read, "quote"); assert.ok(d.url.startsWith(prox.url)); assert.equal(d.attempts.length, 2);
});

test("first label wins (inner read labeled before the outer wrapper)", async () => {
  const e = await labelRead("outer", labelRead("balance", Promise.reject(new Error("x")))).catch((x) => x);
  assert.equal(readFailure(e).read, "balance");
});

test("works under the read floor (flooredTransport), outer retries off", async () => {
  reset(); pub.st.mode = "drop";
  const st = new RouteState(() => now);
  const pc = createPublicClient({ transport: flooredTransport(readTransport({ directUrl: pub.url, proxyUrl: prox.url, state: st, log: () => {}, clock: () => now }), new ReadFloor(), { retryCount: 0 }) }) as PublicClient;
  assert.equal(await read(pc), 42n);
  assert.equal(pub.st.hits, 1); assert.equal(prox.st.hits, 1);
});

test("shouldFailover / browserProxyUrl", () => {
  assert.ok(shouldFailover(new TypeError("Failed to fetch")));
  assert.ok(shouldFailover({ code: -32005, message: "limit" }));
  assert.ok(!shouldFailover({ code: 3, message: "execution reverted" }));
  assert.ok(!shouldFailover({ code: -32000, message: "unsupported block number" }));
  assert.ok(!shouldFailover(new Error("insufficient funds")));
  assert.equal(browserProxyUrl({ location: { origin: "https://disciple-pearl.vercel.app" } }), "https://disciple-pearl.vercel.app/api/rpc");
  assert.equal(browserProxyUrl({}), null);
  assert.ok(logs.length > 0);
});
