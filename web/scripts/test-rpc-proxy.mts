// /api/rpc read proxy (lib/server/rpcProxy): allowlist, sends refused, batch, guards, upstream retry/timeout. pnpm test:rpc-proxy (pure)
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRpcProxy, proxyUpstreams, RPC_PROXY_LIMITS, type ProxyDeps } from "../lib/server/rpcProxy";
import { READ_METHODS } from "../lib/rpc/readMethods";

const UP = "https://rpc.example";
const ok = (id: unknown, result: unknown = "0x1") => ({ jsonrpc: "2.0", id, result });
const body = (v: unknown) => JSON.stringify(v);
type Call = { url: string; body: unknown };
/** fetch stub: each call takes the next scripted reply (Response | Error | "hang") */
function stubFetch(replies: (Response | Error | "hang" | ((b: unknown) => Response))[]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    calls.push({ url, body: b });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r === "hang") return new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "TimeoutError" }))));
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(b) : r.clone();
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const echo = (b: unknown) => json(Array.isArray(b) ? b.map((x: { id: unknown }) => ok(x.id)) : ok((b as { id: unknown }).id));
const deps = (f: typeof fetch, x: Partial<ProxyDeps> = {}): ProxyDeps => ({ upstreams: [UP], fetch: f, sleep: async () => {}, log: () => {}, ...x });
const req = (b: unknown, x: Record<string, string> = {}) => ({ body: typeof b === "string" ? b : body(b), ip: "1.2.3.4", ...x });

test("allowlisted reads are forwarded and the upstream answer passed through", async () => {
  for (const method of ["eth_call", "eth_getBalance", "eth_blockNumber", "eth_chainId", "eth_getCode", "eth_getTransactionCount", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas"]) {
    assert.ok(READ_METHODS.has(method), method);
    const s = stubFetch([echo]);
    const r = await handleRpcProxy(req({ jsonrpc: "2.0", id: 7, method, params: [] }), deps(s.f));
    assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.body), ok(7)); assert.equal(s.calls.length, 1);
    assert.equal((s.calls[0].body as { method: string }).method, method);
    assert.equal(r.headers["cache-control"], "no-store");
  }
});

test("send / sign / debug methods are refused and NEVER forwarded", async () => {
  for (const method of ["eth_sendRawTransaction", "eth_sendRawTransactionSync", "eth_sendTransaction", "eth_sign", "personal_sign", "eth_signTypedData_v4", "eth_sendUserOperation", "debug_traceCall", "eth_getLogs", "anvil_setBalance", "__proto__"]) {
    const s = stubFetch([echo]);
    const r = await handleRpcProxy(req({ jsonrpc: "2.0", id: 1, method, params: ["0xdead"] }), deps(s.f));
    assert.equal(s.calls.length, 0, method);
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).error.code, -32601);
  }
});

test("a batch with ONE send in it is refused whole (nothing forwarded)", async () => {
  const s = stubFetch([echo]);
  const r = await handleRpcProxy(req([{ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{}, "latest"] }, { jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: ["0x00"] }]), deps(s.f));
  assert.equal(s.calls.length, 0);
  const out = JSON.parse(r.body); assert.equal(out.length, 2); assert.ok(out.every((x: { error: { code: number } }) => x.error.code === -32601));
});

test("batch of reads: forwarded as one upstream request, ids kept", async () => {
  const s = stubFetch([echo]);
  const items = [1, 2, 3].map((id) => ({ jsonrpc: "2.0", id, method: id === 2 ? "eth_getBalance" : "eth_call", params: [] }));
  const r = await handleRpcProxy(req(items), deps(s.f));
  assert.equal(s.calls.length, 1); assert.equal((s.calls[0].body as unknown[]).length, 3);
  assert.deepEqual(JSON.parse(r.body).map((x: { id: number }) => x.id), [1, 2, 3]);
  const tooMany = Array.from({ length: RPC_PROXY_LIMITS.maxBatch + 1 }, (_, id) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [] }));
  assert.equal((await handleRpcProxy(req(tooMany), deps(s.f))).status, 400);
  assert.equal((await handleRpcProxy(req([]), deps(s.f))).status, 400);
});

test("guards: body size, bad JSON, full-tx blocks, cross-origin", async () => {
  const s = stubFetch([echo]);
  const big = { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ data: "0x" + "00".repeat(RPC_PROXY_LIMITS.maxBodyBytes) }, "latest"] };
  assert.equal((await handleRpcProxy(req(big), deps(s.f))).status, 413);
  assert.equal((await handleRpcProxy({ body: "{}", ip: "x", contentLength: String(RPC_PROXY_LIMITS.maxBodyBytes + 1) }, deps(s.f))).status, 413);
  assert.equal((await handleRpcProxy(req("not json"), deps(s.f))).status, 400);
  const full = await handleRpcProxy(req({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", true] }), deps(s.f));
  assert.equal(JSON.parse(full.body).error.code, -32601);
  const hdr = await handleRpcProxy(req({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }), deps(s.f));
  assert.equal(hdr.status, 200);
  const x = await handleRpcProxy(req({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [] }, { origin: "https://evil.example", host: "disciple-pearl.vercel.app" }), deps(s.f));
  assert.equal(x.status, 403);
  const same = await handleRpcProxy(req({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [] }, { origin: "https://disciple-pearl.vercel.app", host: "disciple-pearl.vercel.app" }), deps(s.f));
  assert.equal(same.status, 200);
  assert.equal(s.calls.length, 2);   // only the header-only block + the same-origin call reached upstream
});

test("per-IP rate limit: 429 + -32005 + retry-after, nothing forwarded", async () => {
  const s = stubFetch([echo]);
  let n = 0;
  const limit = (k: string, l: number) => { assert.equal(k, "rpc:ip:1.2.3.4"); n++; return { ok: n <= 2, retryAfterSec: 17, l }; };
  for (let i = 0; i < 2; i++) assert.equal((await handleRpcProxy(req({ jsonrpc: "2.0", id: i, method: "eth_call", params: [] }), deps(s.f, { limit }))).status, 200);
  const r = await handleRpcProxy(req({ jsonrpc: "2.0", id: 9, method: "eth_call", params: [] }), deps(s.f, { limit }));
  assert.equal(r.status, 429); assert.equal(r.headers["retry-after"], "17"); assert.equal(JSON.parse(r.body).error.code, -32005);
  assert.equal(s.calls.length, 2);
});

test("upstream retry with backoff: 5xx, 429, dropped connection, non-JSON edge page, RPC -32005", async () => {
  const cases: [string, Response | Error][] = [
    ["503", json({ error: "x" }, 503)],
    ["429", json({ error: "slow down" }, 429)],
    ["drop", Object.assign(new TypeError("fetch failed"), { cause: new Error("socket hang up") })],
    ["non-JSON 400 (*,*)", new Response("<html>bad request</html>", { status: 400 })],
    ["-32005", json({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "limit exceeded" } })],
  ];
  for (const [name, bad] of cases) {
    const sleeps: number[] = [];
    const s = stubFetch([bad, echo]);
    const r = await handleRpcProxy(req({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [] }), deps(s.f, { sleep: async (ms) => { sleeps.push(ms); } }));
    assert.equal(r.status, 200, name); assert.deepEqual(JSON.parse(r.body), ok(1), name);
    assert.equal(s.calls.length, 2, name); assert.equal(sleeps.length, 1, name); assert.ok(sleeps[0] >= 100 && sleeps[0] < 150, name);
  }
});

test("a node answer (revert) is passed through, not retried", async () => {
  const revert = { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data: "0x08c379a0" } };
  const s = stubFetch([json(revert), echo]);
  const r = await handleRpcProxy(req({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [] }), deps(s.f));
  assert.equal(s.calls.length, 1); assert.deepEqual(JSON.parse(r.body), revert);
});

test("upstream timeout: each attempt is cut, then 502 -32603 after the attempts", async () => {
  const s = stubFetch(["hang"]);
  const logs: unknown[] = [];
  const t0 = Date.now();
  const keep = setInterval(() => {}, 1000);   // AbortSignal.timeout's timer is unref'd: keep the test's event loop alive
  const r = await handleRpcProxy(req({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [] }), deps(s.f, { limits: { attemptTimeoutMs: 60 }, log: (m, d) => logs.push([m, d]) })).finally(() => clearInterval(keep));
  assert.equal(r.status, 502); assert.equal(JSON.parse(r.body).error.code, -32603);
  assert.equal(s.calls.length, RPC_PROXY_LIMITS.attempts);
  assert.ok(Date.now() - t0 < 1000);
  assert.match(JSON.stringify(logs), /upstream failed.*timeout/);
});

test("total budget bounds the retries", async () => {
  let t = 0;
  const s = stubFetch([json({}, 503)]);
  const r = await handleRpcProxy(req({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [] }), deps(s.f, { clock: () => t, sleep: async () => { t += 10_000; } }));
  assert.equal(r.status, 502); assert.equal(s.calls.length, 1);
});

test("optional fallback upstream (RHT_RECEIPT_RPC_URL): attempts alternate", async () => {
  assert.deepEqual(proxyUpstreams(UP, {}), [UP]);
  assert.deepEqual(proxyUpstreams(UP, { RHT_RECEIPT_RPC_URL: "nope" }), [UP]);
  const ups = proxyUpstreams(UP, { RHT_RECEIPT_RPC_URL: "https://fast.example" });
  assert.deepEqual(ups, [UP, "https://fast.example"]);
  const s = stubFetch([json({}, 502), echo]);
  const r = await handleRpcProxy(req({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [] }), deps(s.f, { upstreams: ups }));
  assert.equal(r.status, 200); assert.deepEqual(s.calls.map((c) => c.url), [UP, "https://fast.example"]);
});
