/**
 * POST /api/bundler — server-side proxy to the Alchemy RH-testnet bundler.
 * Alchemy answers 401 to browser requests (Origin header) from domains not allowlisted on the app, and this keeps the
 * key off the client. Only ERC-4337 methods are forwarded.
 */
import type { Address } from "viem";
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { BUNDLER_LIMITS, clientIp, hitLimit, sendLimiter, type LimitResult, type SendLimiter } from "@/lib/server/limits";
import { checkUserPaid } from "@/lib/aa/gasPolicy";
import { alchemyKey } from "@/lib/server/alchemyKey";
import { inviteRequiredRpc, requireInviteWallet } from "@/lib/server/inviteGate";

import { assertPrepaidReady, configuredPrepaidPaymaster } from "@/lib/server/prepaidPaymaster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set([
  "eth_chainId", "eth_supportedEntryPoints", "eth_sendUserOperation", "eth_estimateUserOperationGas",
  "eth_getUserOperationReceipt", "eth_getUserOperationByHash", "rundler_maxPriorityFeePerGas",
]);
// No custom protocol relay/warm methods and no self-bundler fallback, regardless of old env flags.
const SEND = new Set(["eth_sendUserOperation"]);
const SIM = new Set(["eth_estimateUserOperationGas"]);
const senderOf = (params: unknown[]) => String((params[0] as { sender?: unknown } | undefined)?.sender ?? "").toLowerCase();
const pressOf = (params: unknown[]) => (params[2] as { pressId?: unknown } | undefined)?.pressId;
/** Preserve proxy rate limits; the external bundler alone validates/submits user-paid ops. */
function senderLimiter(req: Request, method: string, params: unknown[]): SendLimiter | null {
  return SEND.has(method) ? sendLimiter(kv(), { ip: clientIp(req.headers), sender: senderOf(params), pressId: req.headers.get("x-disciple-press-id") || pressOf(params) }) : null;
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
  let body: { method?: string; id?: unknown; params?: unknown[] };
  try { body = await req.json(); } catch { return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 }); }
  if (body && !Array.isArray(body) && typeof body.method === "string" && isSponsorMethod(body.method))
    return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: `${body.method}: gas sponsorship disabled` } }, { status: 400 });
  if (!body || Array.isArray(body) || typeof body.method !== "string" || !ALLOWED.has(body.method))
    return NextResponse.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32601, message: "protocol relay disabled; method not allowed" } }, { status: 400 });
  if (body.params !== undefined && !Array.isArray(body.params))
    return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32602, message: "invalid params" } }, { status: 400 });
  if (SEND.has(body.method) || SIM.has(body.method)) {
    const op = body.params?.[0];
    if (!op || typeof op !== "object" || Array.isArray(op))
      return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32602, message: "invalid user operation" } }, { status: 400 });
    try { checkUserPaid(op, configuredPrepaidPaymaster()); } catch {
      return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32602, message: "gas sponsorship disabled" } }, { status: 400 });
    }
    const paid = op as { paymaster?: Address; paymasterAndData?: string; factory?: string; initCode?: string };
    const pm = paid.paymaster || (paid.paymasterAndData && paid.paymasterAndData !== "0x" ? paid.paymasterAndData.slice(0, 42) as Address : undefined);
    // Quote issuance and cold estimates check deployment/stake. Do not add readiness RPC waits to warm submits;
    // the external bundler validates every signature/stake and the contract precharges every operation.
    if (SIM.has(body.method) && pm && !/^0x0{40}$/i.test(pm)) {
      const factory = paid.factory || (paid.initCode && paid.initCode !== "0x" ? paid.initCode.slice(0, 42) : undefined);
      try { await assertPrepaidReady(pm, factory); } catch {
        return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32003, message: "prepaid USDG paymaster unavailable; protocol relay disabled" } }, { status: 503 });
      }
    }
  }
  const key = alchemyKey();
  if (!key) return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32003, message: "external bundler not configured; protocol relay disabled" } }, { status: 503 });
  const sl = senderLimiter(req, body.method, body.params || []);
  const rl = await limited(req, body.method, sl);
  if (rl) return limitedResponse(body.id, body.method, rl.retryAfterSec);
  // invite-only beta (lib/server/invites): sends need an invited sender; off by default ⇒ no-op
  if (SEND.has(body.method) && !(await requireInviteWallet(senderOf(body.params || []), "bundler")).ok) return inviteRequiredRpc(body.id);
  try {
    // forwarded to Alchemy (it validates; we can't hook before its submission): refuse when the sender's validated-sends
    // bucket is already full (read-only — junk ops never fill it), and count the send only once Alchemy accepted it
    const full = sl ? await sl.peek() : null;
    if (full) return limitedResponse(body.id, body.method, full.retryAfterSec);
    const r = await fetch(`https://robinhood-testnet.g.alchemy.com/v2/${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const text = await r.text();
    // Authentication/upstream failures are returned as-is. Never sign, fund, or relay as a fallback.
    if (sl && r.ok && /"result"/.test(text)) await sl.beforeSend().catch(() => undefined);
    return new NextResponse(text, { status: r.status, headers: { "content-type": "application/json" } });
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32003, message: "external bundler unavailable; protocol relay disabled" } }, { status: 502 });
  }
}
