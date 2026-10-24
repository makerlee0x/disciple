/**
 * POST /api/paymaster — ERC-7677 paymaster web service for DisciplePaymaster (USDG token paymaster, RH testnet only).
 *   pm_getPaymasterStubData [userOp, entryPoint, chainId, context] → stub fields + { disciple: rate, maxTokenCost, … }
 *   pm_getPaymasterData     [userOp, entryPoint, chainId, context] → signed paymasterData
 *   pm_getPaymasterAllowance [sender, entryPoint, chainId] → signed per-sender allowance (reused by every op of the
 *                           sender until validUntil; the client caches it ⇒ 0 pm_* calls per warm trade)
 * Gas is paid out of the user's own USDG (postOp transferFrom at the signed rate); nothing is sponsored. Quote rules:
 * lib/server/paymasterCore. Signer key: PAYMASTER_SIGNER_KEY (server env only).
 */
import { NextResponse } from "next/server";
import { kv } from "@/lib/server/kv";
import { BUNDLER_LIMITS, clientIp, hitLimit, paymasterAllowanceLimits } from "@/lib/server/limits";
import { allowanceQuote, finalQuote, PaymasterQuoteError, stubQuote } from "@/lib/server/paymasterCore";
import { quoteConfig, quoteDeps } from "@/lib/server/paymasterQuote";
import type { UserOp } from "@/lib/aa/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CODES: Record<PaymasterQuoteError["code"], number> = { config: -32003, chain: -32602, entrypoint: -32602, op: -32602, gas: -32602, approve: -32602, balance: -32602, rate: -32003 };
const ADDR = /^0x[0-9a-fA-F]{40}$/;

export async function POST(req: Request) {
  let body: { method?: string; id?: unknown; params?: unknown[] };
  try { body = await req.json(); } catch { return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 }); }
  const id = (body as { id?: unknown })?.id ?? null;
  const fail = (code: number, message: string, status = 400, data?: unknown) => NextResponse.json({ jsonrpc: "2.0", id, error: { code, message, data } }, { status });
  if (Array.isArray(body) || (body.method !== "pm_getPaymasterStubData" && body.method !== "pm_getPaymasterData" && body.method !== "pm_getPaymasterAllowance")) return fail(-32601, "method not allowed");
  if (body.method === "pm_getPaymasterAllowance") return allowance(req, id, body.params || [], fail);
  const [op, entryPoint, chainId] = (body.params || []) as [UserOp | undefined, string | undefined, string | number | undefined];
  if (!op || typeof op !== "object" || !ADDR.test(String(op.sender)) || typeof op.callData !== "string" || entryPoint === undefined || chainId === undefined)
    return fail(-32602, "params: [userOp, entryPoint, chainId, context?]");

  const ip = clientIp(req.headers);
  const rl = await hitLimit(kv(), `paymaster:ip:${ip}`, BUNDLER_LIMITS.simPerIp.limit, BUNDLER_LIMITS.simPerIp.windowSec);
  if (!rl.ok) return NextResponse.json({ jsonrpc: "2.0", id, error: { code: -32005, message: `rate limited, retry in ${rl.retryAfterSec}s` } }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });

  try {
    const cfg = await quoteConfig();
    const deps = quoteDeps(cfg);
    const result = body.method === "pm_getPaymasterStubData"
      ? await stubQuote(op, entryPoint, chainId, cfg, deps)
      : await finalQuote(op, entryPoint, chainId, cfg, deps);
    return NextResponse.json({ jsonrpc: "2.0", id, result });
  } catch (e) {
    if (e instanceof PaymasterQuoteError) return fail(CODES[e.code], `${body.method}: ${e.message}`, e.code === "config" ? 503 : 400, e.data);
    const m = (e as { shortMessage?: string }).shortMessage || (e as Error).message || String(e);
    return fail(-32000, `${body.method}: ${m.split("\n")[0].slice(0, 200)}`, 500);
  }
}

/**
 * Allowance issuance: per-IP limit (shared with the quote methods) + a per-(IP, sender) limit (≤ 30 / 10 min: the client
 * asks once per ~8 min). Keyed on IP + sender so a third party can't exhaust a victim's bucket (AUDIT #141 L-3).
 */
async function allowance(req: Request, id: unknown, params: unknown[], fail: (code: number, message: string, status?: number, data?: unknown) => Response) {
  const [sender, entryPoint, chainId] = params as [string | undefined, string | undefined, string | number | undefined];
  if (!sender || !ADDR.test(sender) || entryPoint === undefined || chainId === undefined) return fail(-32602, "params: [sender, entryPoint, chainId]");
  const ip = clientIp(req.headers);
  for (const [key, limit, windowSec] of paymasterAllowanceLimits(ip, sender)) {
    const rl = await hitLimit(kv(), key, limit, windowSec);
    if (!rl.ok) return NextResponse.json({ jsonrpc: "2.0", id, error: { code: -32005, message: `rate limited, retry in ${rl.retryAfterSec}s` } }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  }
  try {
    const cfg = await quoteConfig();
    return NextResponse.json({ jsonrpc: "2.0", id, result: await allowanceQuote(sender as `0x${string}`, entryPoint, chainId, cfg, quoteDeps(cfg)) });
  } catch (e) {
    if (e instanceof PaymasterQuoteError) return fail(CODES[e.code], `pm_getPaymasterAllowance: ${e.message}`, e.code === "config" ? 503 : 400, e.data);
    const m = (e as { shortMessage?: string }).shortMessage || (e as Error).message || String(e);
    return fail(-32000, `pm_getPaymasterAllowance: ${m.split("\n")[0].slice(0, 200)}`, 500);
  }
}
