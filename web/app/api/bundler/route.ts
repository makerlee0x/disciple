/**
 * POST /api/bundler — server-side proxy to the Alchemy RH-testnet bundler.
 * Alchemy answers 401 to browser requests (Origin header) from domains not allowlisted on the app, and this keeps the
 * key off the client. Only ERC-4337 methods are forwarded.
 */
import { NextResponse } from "next/server";
import { selfBundle } from "@/lib/server/selfBundler";
import { isRelayerNotConfigured } from "@/lib/server/relayer";
import { kv } from "@/lib/server/kv";
import { BUNDLER_LIMITS, HybridLimiter, clientIp, type LimitResult } from "@/lib/server/limits";
import { afterResponse, type DeferMode } from "@/lib/server/defer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set([
  "eth_chainId", "eth_supportedEntryPoints", "eth_sendUserOperation", "eth_estimateUserOperationGas",
  "eth_getUserOperationReceipt", "eth_getUserOperationByHash", "rundler_maxPriorityFeePerGas",
]);
/** One-round-trip trade path (lib/server/fastRelay): always the built-in relay, never proxied (latency plan #1). */
const SELF_ONLY = new Set(["disciple_sendUserOperationSync", "disciple_warm"]);
/** Self-pay only: no gas policy / paymaster. Rejected explicitly so clients see why, not "method not allowed". */
const SEND = new Set(["eth_sendUserOperation", "disciple_sendUserOperationSync"]);
const SIM = new Set(["eth_estimateUserOperationGas", "disciple_warm"]);
/**
 * W-1: per-sender + per-IP limits. Latency plan #4: decided from this instance's memory (no store round trip before
 * the relay); every hit is still counted in the shared Upstash store AFTER the response (HybridLimiter + afterResponse),
 * and the store's answer blocks the key on this instance too. Without KV env: memory only. null = allowed.
 */
const LIMITER = new HybridLimiter(() => { const s = kv(); return s.kind === "upstash" ? s : null; });
function limited(req: Request, method: string, params: unknown[], syncs: Promise<void>[]): LimitResult | null {
  const ip = clientIp(req.headers);
  const hit = (k: string, l: { limit: number; windowSec: number }) => { const r = LIMITER.hit(k, l.limit, l.windowSec); if (r.sync) syncs.push(r.sync); return r; };
  if (SEND.has(method)) {
    const sender = String((params[0] as { sender?: unknown } | undefined)?.sender ?? "").toLowerCase();
    const checks = [hit(`bundler:send:ip:${ip}`, BUNDLER_LIMITS.sendPerIp)];
    if (/^0x[0-9a-f]{40}$/.test(sender)) checks.push(hit(`bundler:send:sender:${sender}`, BUNDLER_LIMITS.sendPerSender));
    return checks.find((r) => !r.ok) ?? null;
  }
  if (SIM.has(method)) { const r = hit(`bundler:sim:ip:${ip}`, BUNDLER_LIMITS.simPerIp); return r.ok ? null : r; }
  return null;
}
/** Instance age marker for the timing log (cold = first request on this lambda). */
let served = 0;
const BOOT = Date.now();
const isSponsorMethod = (m: string) => m === "alchemy_requestGasAndPaymasterAndData" || m.startsWith("pm_") || m.startsWith("alchemy_requestPaymaster");

export async function POST(req: Request) {
  const T0 = Date.now(), tm: Record<string, number> = {};
  const cold = served++ === 0;
  const key = process.env.ALCHEMY_API_KEY || process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  let body: { method?: string; id?: unknown; params?: unknown[] };
  try { body = await req.json(); } catch { return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 }); }
  tm.parse = Date.now() - T0;
  if (!Array.isArray(body) && body.method && isSponsorMethod(body.method))
    return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: `${body.method}: gas sponsorship is disabled (self-pay only, no paymaster)` } }, { status: 400 });
  // Latency plan #1: the one-round-trip trade path (disciple_sendUserOperationSync / disciple_warm) ALWAYS runs on the
  // built-in relay, whatever ALCHEMY_API_KEY / AA_SELF_BUNDLER say. Before, an Alchemy key without AA_SELF_BUNDLER=1
  // answered -32601 here and every trade fell back to the multi-second estimate + eth_sendUserOperation + receipt-poll
  // flow. The fast path needs a dedicated RELAYER_PRIVATE_KEY (fails closed with 503 otherwise, see lib/server/relayer).
  const selfOnly = !!body?.method && SELF_ONLY.has(body.method);
  if (Array.isArray(body) || !body.method || (!ALLOWED.has(body.method) && !selfOnly))
    return NextResponse.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32601, message: "method not allowed" } }, { status: 400 });
  const method = body.method;
  const syncs: Promise<void>[] = [];
  const t1 = Date.now();
  const rl = limited(req, method, body.params || [], syncs);
  tm.rateLimit = Date.now() - t1;
  // shared-store work (rate-limit INCRs, relay trust ledger writes) runs after the response; see lib/server/defer.
  // AUDIT Low (kept): a strike / verification recorded while relaying must reach the shared store before the lambda
  // freezes — waitUntil keeps the lambda alive for it; without waitUntil on Vercel it is awaited exactly as before.
  const finish = async (mode: string) => {
    const flushTrust = SEND.has(method) || SIM.has(method);
    const d: DeferMode = await afterResponse(async () => {
      await Promise.all([...syncs, flushTrust ? import("@/lib/server/fastRelay").then((m) => m.flushRelayTrust()).catch(() => undefined) : undefined]);
    });
    tm.total = Date.now() - T0;
    if (TIMED.has(method)) console.info("[disciple] relay timing", { method, mode, cold, ageS: Math.round((Date.now() - BOOT) / 1000), defer: d, ...tm });
    return tm;
  };
  if (rl) {
    await finish("rate-limited");
    return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32005, message: `${method}: rate limited, retry in ${rl.retryAfterSec}s` } }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  }
  if (key && process.env.AA_SELF_BUNDLER !== "1" && !selfOnly) {
    const t2 = Date.now();
    const r = await fetch(`https://robinhood-testnet.g.alchemy.com/v2/${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    tm.alchemy = Date.now() - t2;
    // Alchemy key rejected (401 "Must be authenticated!") ⇒ fall back to the built-in self-bundler.
    if (r.status !== 401 && !/must be authenticated/i.test(text)) {
      await finish("alchemy");
      return new NextResponse(text, { status: r.status, headers: { "content-type": "application/json" } });
    }
  }
  const t3 = Date.now();
  try {
    const result = await selfBundle(method, body.params || []);
    tm.relay = Date.now() - t3;
    // fast relay stages (baseFee/nonce warm, simulate, signTx, send, mined) ride on the result for the client log
    const rt = (result as { t?: Record<string, number> } | null)?.t;
    if (rt) Object.assign(tm, Object.fromEntries(Object.entries(rt).map(([k, v]) => [`relay.${k}`, v])));
    await finish("self");
    if (rt) Object.assign(rt, { route: tm.total, rateLimit: tm.rateLimit, cold: cold ? 1 : 0 });
    return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? 1, result }, { headers: serverTiming(tm) });
  } catch (e) {
    tm.relay = Date.now() - t3;
    await finish("self-error");
    // production without a dedicated RELAYER_PRIVATE_KEY (or set to the faucet key): fail closed, never sign with the faucet
    if (isRelayerNotConfigured(e))
      return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32003, message: `${method}: relayer not configured` } }, { status: 503, headers: { "retry-after": "300" } });
    const m = (e as { shortMessage?: string }).shortMessage || (e as Error).message;
    return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32000, message: `${method}: ${m.split("\n")[0].slice(0, 300)}`, data: (e as { data?: string }).data } }, { headers: serverTiming(tm) });
  }
}

/** Methods whose per-stage timing is logged (`[disciple] relay timing`): the trade path + its warm-up + the standard send. */
const TIMED = new Set(["disciple_sendUserOperationSync", "disciple_warm", "eth_sendUserOperation", "eth_estimateUserOperationGas"]);
/** Server-Timing header (durations only, no ids/addresses): visible in the browser's Network → Timing tab. */
function serverTiming(tm: Record<string, number>): Record<string, string> {
  return { "server-timing": Object.entries(tm).filter(([, v]) => typeof v === "number" && Number.isFinite(v)).map(([k, v]) => `${k.replace(/[^a-zA-Z0-9_]/g, "_")};dur=${v}`).join(", ") };
}
