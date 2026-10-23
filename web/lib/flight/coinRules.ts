/**
 * The coin's game mode + wallet cap for the flight HUD's TIER line ("TRENCH · no cap", "EASY · cap 1%").
 * Read from the coin itself, never hardcoded: BondingCurve.mode() (via coinFacts) + netCapNow() (tokens one wallet may
 * hold right now; type(uint256).max = no cap). Caps can move with the market cap (mode-rules-v2), so this is polled.
 * After graduation the curve's mode rules no longer apply ⇒ "no cap".
 */
import type { PublicClient } from "viem";
import type { Address } from "@/lib/protocol";
import { bondingCurveAbi, tokenAbi } from "@/lib/abi";
import { coinFacts } from "@/lib/protocol-viem";
import { capBpsOf, MODE_NAME, rulesLabel, UINT_MAX } from "./coinRulesLabel";
export { capBpsOf, fmtCapPct, MODE_NAME, rulesLabel } from "./coinRulesLabel";

export type CoinRules = { ticker: string; mode: number; modeName: string; capBps: number | null; label: string };

export async function readCoinRules(pc: PublicClient, token: Address): Promise<CoinRules> {
  const f = await coinFacts(pc, token);
  const [netCap, supply, symbol] = await Promise.all([
    f.graduated ? Promise.resolve(UINT_MAX) : (pc.readContract({ address: f.curve, abi: bondingCurveAbi, functionName: "netCapNow" }) as Promise<bigint>).catch(() => null),
    pc.readContract({ address: token, abi: tokenAbi, functionName: "totalSupply" }) as Promise<bigint>,
    (pc.readContract({ address: token, abi: tokenAbi, functionName: "symbol" }) as Promise<string>).catch(() => ""),
  ]);
  if (netCap == null) throw new Error("netCapNow unavailable");   // pre-v4 curve: don't guess a cap
  const capBps = capBpsOf(netCap, supply);
  return { ticker: String(symbol || "").replace(/^\$/, "").toUpperCase(), mode: f.mode, modeName: MODE_NAME[f.mode] ?? `MODE ${f.mode}`, capBps, label: rulesLabel(f.mode, capBps) };
}
