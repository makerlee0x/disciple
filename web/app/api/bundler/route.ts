/**
 * POST /api/bundler — server-side proxy to the Alchemy RH-testnet bundler.
 * Alchemy answers 401 to browser requests (Origin header) from domains not allowlisted on the app, and this keeps the
 * key off the client. Only ERC-4337 methods are forwarded.
 */
import { NextResponse } from "next/server";
import { selfBundle } from "@/lib/server/selfBundler";
import { isRelayerNotConfigured } from "@/lib/server/relayer";
import { kv } from "@/lib/server/kv";
import { BUNDLER_LIMITS, clientIp, hitLimit, isSendLimitError, sendLimiter, type LimitResult, type SendLimiter } from "@/lib/server/limits";
import { alchemyKey } from "@/lib/server/alchemyKey";
import { RELAY_METHOD, RELAY_STREAM_ACCEPT, relayErrorData } from "@/lib/aa/relayTypes";
import { streamRelay } from "@/lib/server/relayStream";
import { afterResponse } from "@/lib/server/defer";
import { inviteRequiredRpc, requireInviteWallet } from "@/lib/server/inviteGate";

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
const senderOf = (params: unknown[]) => String((params[0] as { sender?: unknown } | undefined)?.sender ?? "").toLowerCase();
const pressOf = (params: unknown[]) => (params[2] as { pressId?: unknown } | undefined)?.pressId;
/**
 * W-1 + AUDIT Low (sender lockout), lib/server/limits.sendLimiter. Sends: pre-validation per IP + per IP+sender here;
 * the per-SENDER limit (and a press's free retry, params[2].pressId) is charged only after the op passed validation
 * (beforeSend, inside fastRelay / selfBundler, before the relayer signs). A send the relay rejected BEFORE submitting
 * anything grants that press ONE free retry (AUDIT L1). Sims: per IP. Shared Upstash store (in-memory without KV env).
 */
function senderLimiter(req: Request, method: string, params: unknown[]): SendLimiter | null {
  return SEND.has(method) ? sendLimiter(kv(), { ip: clientIp(req.headers), sender: senderOf(params), pressId: pressOf(params) }) : null;
}
async function limited(req: Request, method: string, sl: SendLimiter | null): Promise<LimitResult | null> {
  if (sl) return sl.pre();
  if (SIM.has(method)) { const r = await hitLimit(kv(), `bundler:sim:ip:${clientIp(req.headers)}`, BUNDLER_LIMITS.simPerIp.limit, BUNDLER_LIMITS.simPerIp.windowSec); return r.ok ? null : r; }
  return null;
}
const limitedResponse = (id: unknown, method: string, retryAfterSec: number) =>
  NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32005, message: `${method}: rate limited, retry in ${retryAfterSec}s` } }, { status: 429, headers: { "retry-after": String(retryAfterSec) } });
const isSponsorMethod = (m: string) => m === "alchemy_requestGasAndPaymasterAndData" || m.startsWith("pm_") || m.startsWith("alchemy_requestPaymaster");

export async function POST(req: Request) {
  const key = alchemyKey();
  let body: { method?: string; id?: unknown; params?: unknown[] };
  try { body = await req.json(); } catch { return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 }); }
  if (!Array.isArray(body) && body.method && isSponsorMethod(body.method))
    return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: `${body.method}: not supported` } }, { status: 400 });
  const selfOnly = !!body?.method && SELF_ONLY.has(body.method);
  if (selfOnly && key && process.env.AA_SELF_BUNDLER !== "1" && process.env.AA_TRADE_SELF_RELAY === "0")
    return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: `${body.method}: self-bundler only` } });
  if (Array.isArray(body) || !body.method || (!ALLOWED.has(body.method) && !selfOnly))
    return NextResponse.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32601, message: "method not allowed" } }, { status: 400 });
  const sl = senderLimiter(req, body.method, body.params || []);
  const rl = await limited(req, body.method, sl);
  if (rl) return limitedResponse(body.id, body.method, rl.retryAfterSec);
  // invite-only beta (lib/server/invites): sends need an invited sender; off by default ⇒ no-op
  if (SEND.has(body.method) && !(await requireInviteWallet(senderOf(body.params || []), "bundler")).ok) return inviteRequiredRpc(body.id);
  if (key && process.env.AA_SELF_BUNDLER !== "1" && !selfOnly) {
    // forwarded to Alchemy (it validates; we can't hook before its submission): refuse when the sender's validated-sends
    // bucket is already full (read-only — junk ops never fill it), and count the send only once Alchemy accepted it
    const full = sl ? await sl.peek() : null;
    if (full) return limitedResponse(body.id, body.method, full.retryAfterSec);
    const r = await fetch(`https://robinhood-testnet.g.alchemy.com/v2/${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    // Alchemy key rejected (401 "Must be authenticated!") ⇒ fall back to the built-in self-bundler.
    if (r.status !== 401 && !/must be authenticated/i.test(text)) {
      // Alchemy validated + accepted the op (a result) ⇒ only then does it count toward the per-sender limit
      if (sl && r.ok && /"result"/.test(text)) await sl.beforeSend().catch(() => undefined);
      return new NextResponse(text, { status: r.status, headers: { "content-type": "application/json" } });
    }
  }
  // AUDIT Low: a strike / verification recorded while relaying must reach the shared store before the lambda freezes
  // Latency plan #4 (#140): the shared-store trust flush runs after the response (lib/server/defer afterResponse: Vercel
  // waitUntil keeps the lambda alive for it; on Vercel without waitUntil it is awaited exactly as before).
  const flushTrust = async () => {
    if (SEND.has(body.method!) || SIM.has(body.method!)) await afterResponse(async () => (await import("@/lib/server/fastRelay")).flushRelayTrust().catch(() => undefined));
  };
  // Receipt push (lib/aa/relayTypes): streaming clients get NDJSON frames on THIS response — normally one RelayConfirmed;
  // if the sync send timed out, a RelayPending (txHash) first and the RelayConfirmed when the receipt lands.
  if (body.method === RELAY_METHOD && (req.headers.get("accept") || "").includes(RELAY_STREAM_ACCEPT))
    return streamRelay(body.params || [], flushTrust, async (e) => sl?.rejected(e), sl ? () => sl.beforeSend() : undefined);
  try {
    const result = await selfBundle(body.method, body.params || [], { beforeSend: sl ? () => sl.beforeSend() : undefined });
    await flushTrust();
    return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? 1, result });
  } catch (e) {
    await flushTrust();
    await sl?.rejected(e);
    // validated, but the sender's per-sender send limit is full: nothing was signed or sent
    if (isSendLimitError(e)) return limitedResponse(body.id, body.method, e.retryAfterSec);
    // production without a dedicated RELAYER_PRIVATE_KEY (or set to the faucet key): fail closed, never sign with the faucet
    if (isRelayerNotConfigured(e))
      return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32003, message: `${body.method}: relayer not configured` } }, { status: 503, headers: { "retry-after": "300" } });
    const m = (e as { shortMessage?: string }).shortMessage || (e as Error).message;
    // data: the revert payload (string) as before for definite rejections; once the relayer tx was signed, RelayErrorData
    // { txHash, userOpHash, relayNonce, notSent } — notSent (AUDIT L2) true ONLY for a definite rejection — plus
    // unclear/reason when the outcome is unknown (receipt timeout: never a failure, never notSent)
    const d = relayErrorData(e);
    const rev = (e as { data?: unknown }).data;
    const data = d?.unclear || d?.txHash ? d : typeof rev === "string" ? rev : undefined;
    return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32000, message: `${body.method}: ${m.split("\n")[0].slice(0, 300)}`, data } });
  }
}
