import { NextResponse } from "next/server";
import { diagnosticText } from "@/lib/aa/diagnostics";
import { kv } from "@/lib/server/kv";
import { clientIp } from "@/lib/server/limits";
import { RelayMetrics } from "@/lib/server/relayMetrics";
import { flushRelayTrust } from "@/lib/server/fastRelay";
import { relayGaslessLogin, relayGaslessTrade, requireGaslessMode, warmGasless } from "@/lib/server/gaslessRelay";
/**
 * POST /api/gasless — gasless swaps (flow/gasless-permit2). Only when GAS_SPONSORSHIP_MODE=gasless on testnet
 * Preview/local; otherwise every method is refused notSent and /api/bundler (self-bundler / BSO / hosted) is unchanged.
 * Methods: disciple_gaslessTrade [request] (needs `privy-id-token`, the Privy identity token; the session's wallet must
 * be the signer) · disciple_gaslessLogin [{wallet, expiry, signature}] (OFF unless GASLESS_LOGIN_RELAY=1; TODO delete) ·
 * disciple_gaslessWarm [wallet].
 * One JSON answer with the full receipt (eth_sendRawTransactionSync). Never logs signatures, keys or RPC URLs.
 */
const ID_TOKEN_RE = /^[A-Za-z0-9_\-.]+$/;
/** Privy identity token: `privy-id-token` header, else the same-name cookie (docs.privy.io identity-tokens). */
function identityToken(req: Request): string | null {
  const h = req.headers.get("privy-id-token");
  if (h && ID_TOKEN_RE.test(h)) return h;
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)privy-id-token=([^;]+)/);
  if (!m) return null;
  try {
    const v = decodeURIComponent(m[1]);
    return ID_TOKEN_RE.test(v) ? v : null;
  } catch { return null; }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const METHODS = new Set(["disciple_gaslessTrade", "disciple_gaslessLogin", "disciple_gaslessWarm"]);
const GASLESS_IP_LIMIT = 120;   // same relay:ip window as the self-bundler route (per minute)

export async function POST(req: Request) {
  const metrics = new RelayMetrics();
  let body: { method?: string; id?: unknown; params?: unknown[] };
  try { body = await req.json(); } catch { return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 }); }
  const id = body?.id ?? null;
  if (!body || typeof body.method !== "string" || !METHODS.has(body.method) || !Array.isArray(body.params) || body.params.length !== 1)
    return NextResponse.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not allowed" } }, { status: 400 });
  try {
    requireGaslessMode();
    // Per-IP limit runs IN PARALLEL with admission + simulation (lee: auth, sim and rate limit together); nothing is
    // signed before it resolves under the limit.
    const ipGate = metrics.span("rateLimitStore", () => kv().incrEx(`relay:ip:${clientIp(req.headers)}`, 60)).then(n => {
      if (n > GASLESS_IP_LIMIT) throw Object.assign(new Error("rate limited"), { limited: true });
    });
    void ipGate.catch(() => undefined);
    if (body.method === "disciple_gaslessWarm") { await ipGate; return NextResponse.json({ jsonrpc: "2.0", id, result: await warmGasless(body.params[0], metrics) }); }
    const result = body.method === "disciple_gaslessLogin"
      ? await relayGaslessLogin(body.params[0], { ipGate, metrics })
      : await relayGaslessTrade(body.params[0], { ipGate, metrics, idToken: identityToken(req) });
    await flushRelayTrust().catch(() => undefined);
    console.info("[disciple] gasless relay " + JSON.stringify({ method: body.method, txHash: result.txHash, ok: result.success, gasUsed: result.gasUsed, t: result.t, request: metrics.snapshot() }));
    return NextResponse.json({ jsonrpc: "2.0", id, result: { ...result, server: metrics.snapshot() } });
  } catch (e) {
    await flushRelayTrust().catch(() => undefined);
    const x = e as { message?: string; notSent?: boolean; txHash?: string; unclear?: boolean; data?: unknown; limited?: boolean };
    const reason = diagnosticText(x.message ?? String(e));
    console.info("[disciple] gasless relay rejected " + JSON.stringify({ method: body.method, reason, notSent: x.notSent === true, txHash: x.txHash, unclear: x.unclear }));
    const status = x.limited || /rate limited/.test(reason) ? 429 : x.notSent ? 403 : 502;
    return NextResponse.json({ jsonrpc: "2.0", id, error: { code: status === 429 ? -32005 : -32003, message: reason,
      data: { notSent: x.notSent === true, ...(x.txHash ? { txHash: x.txHash } : {}), ...(x.unclear ? { unclear: true } : {}), ...(typeof x.data === "string" ? { revert: x.data } : {}) } } }, { status });
  }
}
