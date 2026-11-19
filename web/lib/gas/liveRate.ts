/**
 * The live USDG-per-ETH rate on the client (maker 2026-11-19: "eth isnt a fixed price"). The server prices every gas fee
 * from the WETH/USDG pool (lib/server/usdgEthRate.liveUsdgPerEth) and returns that rate on each gasless quote; this
 * remembers the latest one so client-side gas reserves use it too. Until the first quote lands, the first read starts
 * a quote in the background and falls back to lib/config GAS.ethUsd for that one read.
 */
import { GAS } from "../config";

type Seen = { rate: bigint; decimals: number; at: number };
let seen: Seen | null = null;
let priming = false;
const MAX_AGE_MS = 10 * 60_000;

/** Called with the `rate` of a gasless quote (USDG base units per 1 ETH, at `decimals`). */
export function rememberUsdgPerEth(rate: bigint, decimals: number): void {
  if (rate > BigInt(0) && Number.isFinite(decimals)) seen = { rate, decimals, at: Date.now() };
}

function prime(): void {
  if (priming || typeof window === "undefined" || typeof fetch !== "function") return;
  priming = true;
  void fetch("/api/gasless", {
    method: "POST", headers: { "content-type": "application/json" },
    body: '{"jsonrpc":"2.0","id":1,"method":"disciple_gaslessWithdrawQuote","params":[{}]}',
  }).then((r) => r.json()).then((j: { result?: { rate?: string; usdgDecimals?: number } }) => {
    if (j.result?.rate) rememberUsdgPerEth(BigInt(j.result.rate), Number(j.result.usdgDecimals ?? 6));
  }).catch(() => undefined).finally(() => { setTimeout(() => { priming = false; }, 60_000); });
}

/** USDG base units per 1 ETH at `decimals`: the latest live rate, else config (and a background read). */
export function usdgPerEthRate(decimals: number): bigint {
  const s = seen;
  if (s && Date.now() - s.at < MAX_AGE_MS) {
    if (s.decimals === decimals) return s.rate;
    const d = decimals - s.decimals;
    return d > 0 ? s.rate * BigInt(10) ** BigInt(d) : s.rate / BigInt(10) ** BigInt(-d);
  }
  prime();
  return BigInt(Math.round(GAS.ethUsd * 1e6)) * BigInt(10) ** BigInt(decimals) / BigInt(1e6);
}
