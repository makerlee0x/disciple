/**
 * The coin's game mode + wallet cap for the flight HUD's TIER line ("TRENCH · no cap", "EASY · cap 1%").
 * Read from the coin itself, never hardcoded: BondingCurve.mode() (via coinFacts) + netCapNow() (tokens one wallet may
 * hold right now; type(uint256).max = no cap). Caps can move with the market cap (mode-rules-v2), so this is polled.
 * After graduation the curve's mode rules no longer apply ⇒ "no cap".
 */
import type { PublicClient } from "viem";
import type { Address } from "@/lib/protocol";
import { bondingCurveAbi, tokenAbi } from "@/lib/abi";
import { coinFacts, MODE } from "@/lib/protocol-viem";

export type CoinRules = { ticker: string; mode: number; modeName: string; capBps: number | null; label: string };

/** Player-facing mode names (Easy = PVE, Hard = PVP). */
export const MODE_NAME: Record<number, string> = { [MODE.TRENCH]: "TRENCH", [MODE.PVE]: "EASY", [MODE.PVP]: "HARD" };

const MAX = (BigInt(1) << BigInt(256)) - BigInt(1);

/** netCapNow (token wei) + totalSupply (token wei) → cap in bps of supply, or null = no cap. */
export function capBpsOf(netCap: bigint, totalSupply: bigint): number | null {
  if (netCap >= MAX || totalSupply <= BigInt(0) || netCap >= totalSupply) return null;
  return Number((netCap * BigInt(1_000_000)) / totalSupply) / 100;   // bps with 2 decimals (3.33% = 333 bps, 7.77% = 777)
}

/** "1%", "3.33%", "0.25%" — at most 2 decimals, no trailing zeros. */
export function fmtCapPct(bps: number): string {
  return `${+(bps / 100).toFixed(2)}%`;
}

/** "TRENCH · no cap" / "EASY · cap 1%" / "HARD · cap 3.33%". */
export function rulesLabel(mode: number, capBps: number | null): string {
  const name = MODE_NAME[mode] ?? `MODE ${mode}`;
  return `${name} · ${capBps == null ? "no cap" : `cap ${fmtCapPct(capBps)}`}`;
}

export async function readCoinRules(pc: PublicClient, token: Address): Promise<CoinRules> {
  const f = await coinFacts(pc, token);
  const [netCap, supply, symbol] = await Promise.all([
    f.graduated ? Promise.resolve(MAX) : (pc.readContract({ address: f.curve, abi: bondingCurveAbi, functionName: "netCapNow" }) as Promise<bigint>).catch(() => null),
    pc.readContract({ address: token, abi: tokenAbi, functionName: "totalSupply" }) as Promise<bigint>,
    (pc.readContract({ address: token, abi: tokenAbi, functionName: "symbol" }) as Promise<string>).catch(() => ""),
  ]);
  if (netCap == null) throw new Error("netCapNow unavailable");   // pre-v4 curve: don't guess a cap
  const capBps = capBpsOf(netCap, supply);
  return { ticker: String(symbol || "").replace(/^\$/, "").toUpperCase(), mode: f.mode, modeName: MODE_NAME[f.mode] ?? `MODE ${f.mode}`, capBps, label: rulesLabel(f.mode, capBps) };
}
