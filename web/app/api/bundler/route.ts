/**
 * POST /api/bundler — server-side proxy to the Alchemy RH-testnet bundler.
 * Alchemy answers 401 to browser requests (Origin header) from domains not allowlisted on the app, and this keeps the
 * key off the client. Only ERC-4337 methods are forwarded.
 */
import { NextResponse } from "next/server";
import { selfBundle } from "@/lib/server/selfBundler";
import { isRelayerNotConfigured } from "@/lib/server/relayer";
import { kv } from "@/lib/server/kv";
import { BUNDLER_LIMITS, bundlerSendPerSender, clientIp, hitLimit, hitSenderSend, type LimitResult } from "@/lib/server/limits";
import { RELAY_METHOD, RELAY_STREAM_ACCEPT } from "@/lib/aa/relayTypes";
import { streamRelay } from "@/lib/server/relayStream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set([
  "eth_chainId", "eth_supportedEntryPoints", "eth_sendUserOperation", "eth_estimateUserOperationGas",
  "eth_getUserOperationReceipt", "eth_getUserOperationByHash", "rundler_maxPriorityFeePerGas",
]);
/**
 * One-round-trip trade path (lib/server/fastRelay). Item 2 (feat/trade-latency): self-relay is THE trade path — these
 * are always served by the self-bundler, even when an Alchemy key is set (the Alchemy proxy only serves the standard
 * eth_* methods, e.g. deploy / launch ops). AA_TRADE_SELF_RELAY=0 restores the old gate (-32601 unless AA_SELF_BUNDLER=1).
 */
const SELF_ONLY = new Set(["disciple_sendUserOperationSync", "disciple_warm"]);
/** Self-pay only: no gas policy / paymaster. Rejected explicitly so clients see why, not "method not allowed". */
const SEND = new Set(["eth_sendUserOperation", "disciple_sendUserOperationSync"]);
const SIM = new Set(["eth_estimateUserOperationGas", "disciple_warm"]);
/** W-1: per-sender + per-IP limits in the shared Upstash store (in-memory only without KV env). null = allowed. */
async function limited(req: Request, method: string, params: unknown[]): Promise<LimitResult | null> {
  const ip = clientIp(req.headers), s = kv();
  if (SEND.has(method)) {
    const sender = String((params[0] as { sender?: unknown } | undefined)?.sender ?? "").toLowerCase();
    const checks = [hitLimit(s, `bundler:send:ip:${ip}`, BUNDLER_LIMITS.sendPerIp.limit, BUNDLER_LIMITS.sendPerIp.windowSec)];
    // rapid taps: retries of the same press (params[2].pressId, lib/aa/relayClient) don't count toward the sender limit
    const pressId = (params[2] as { pressId?: unknown } | undefined)?.pressId;
    if (/^0x[0-9a-f]{40}$/.test(sender)) checks.push(hitSenderSend(s, sender, pressId, bundlerSendPerSender()));
    return (await Promise.all(checks)).find((r) => !r.ok) ?? null;
  }
  if (SIM.has(method)) { const r = await hitLimit(s, `bundler:sim:ip:${ip}`, BUNDLER_LIMITS.simPerIp.limit, BUNDLER_LIMITS.simPerIp.windowSec); return r.ok ? null : r; }
  return null;
}
const isSponsorMethod = (m: string) => m === "alchemy_requestGasAndPaymasterAndData" || m.startsWith("pm_") || m.startsWith("alchemy_requestPaymaster");

export async function POST(req: Request) {
  const key = process.env.ALCHEMY_API_KEY || process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  let body: { method?: string; id?: unknown; params?: unknown[] };
  try { body = await req.json(); } catch { return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 }); }
  if (!Array.isArray(body) && body.method && isSponsorMethod(body.method))
    return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: `${body.method}: not supported` } }, { status: 400 });
  const selfOnly = !!body?.method && SELF_ONLY.has(body.method);
  if (selfOnly && key && process.env.AA_SELF_BUNDLER !== "1" && process.env.AA_TRADE_SELF_RELAY === "0")
    return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: `${body.method}: self-bundler only` } });
  if (Array.isArray(body) || !body.method || (!ALLOWED.has(body.method) && !selfOnly))
    return NextResponse.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32601, message: "method not allowed" } }, { status: 400 });
  const rl = await limited(req, body.method, body.params || []);
  if (rl) return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32005, message: `${body.method}: rate limited, retry in ${rl.retryAfterSec}s` } }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  if (key && process.env.AA_SELF_BUNDLER !== "1" && !selfOnly) {
    const r = await fetch(`https://robinhood-testnet.g.alchemy.com/v2/${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    // Alchemy key rejected (401 "Must be authenticated!") ⇒ fall back to the built-in self-bundler.
    if (r.status !== 401 && !/must be authenticated/i.test(text)) return new NextResponse(text, { status: r.status, headers: { "content-type": "application/json" } });
  }
  // AUDIT Low: a strike / verification recorded while relaying must reach the shared store before the lambda freezes
  const flushTrust = async () => { if (SEND.has(body.method!) || SIM.has(body.method!)) await (await import("@/lib/server/fastRelay")).flushRelayTrust().catch(() => undefined); };
  // Receipt push (lib/aa/relayTypes): streaming clients get NDJSON frames on THIS response — normally one RelayConfirmed;
  // if the sync send timed out, a RelayPending (txHash) first and the RelayConfirmed when the receipt lands.
  if (body.method === RELAY_METHOD && (req.headers.get("accept") || "").includes(RELAY_STREAM_ACCEPT))
    return streamRelay(body.params || [], flushTrust);   // on #140: pass its finish()/afterResponse instead of flushTrust
  try {
    const result = await selfBundle(body.method, body.params || []);
    await flushTrust();
    return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? 1, result });
  } catch (e) {
    await flushTrust();
    // production without a dedicated RELAYER_PRIVATE_KEY (or set to the faucet key): fail closed, never sign with the faucet
    if (isRelayerNotConfigured(e))
      return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32003, message: `${body.method}: relayer not configured` } }, { status: 503, headers: { "retry-after": "300" } });
    const m = (e as { shortMessage?: string }).shortMessage || (e as Error).message;
    const txHash = (e as { txHash?: string }).txHash;
    // data: the revert payload (string) as before; when the relayer tx was signed but no receipt came back, { txHash }
    const data = (e as { data?: string }).data ?? (txHash ? { txHash, userOpHash: (e as { userOpHash?: string }).userOpHash, notSent: (e as { notSent?: boolean }).notSent === true } : undefined);
    return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32000, message: `${body.method}: ${m.split("\n")[0].slice(0, 300)}`, data } });
  }
}
