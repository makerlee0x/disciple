/**
 * Archived badge only (CoinIdentity): a coin is from an older stack iff its curve.loginGate() is not the live LoginGate
 * (deployment().loginGate). Detected on-chain, no hardcoded coin list. This never blocks a trade: every coin uses
 * the same gasless trade path (lee Nov 12).
 */
import { parseAbi, type Address, type PublicClient } from "viem";
import { deployment, ZERO } from "./chains";

const curveGateAbi = parseAbi(["function loginGate() view returns (address)"]);

const cache = new Map<string, { gate: Address; at: number }>();
const TTL_MS = 60_000;

/** Live LoginGate the site attests to. Empty/zero ⇒ treat nothing as legacy (gate not configured). */
export function liveLoginGate(): Address {
  return deployment().loginGate;
}

/** True when curve.loginGate() ≠ the live LoginGate. Read on-chain; cached ~60s per curve. */
export async function isLegacyCurve(pc: PublicClient, curve: Address): Promise<boolean> {
  const live = liveLoginGate();
  if (!live || live === ZERO) return false;
  const k = curve.toLowerCase();
  const hit = cache.get(k);
  let gate: Address;
  if (hit && Date.now() - hit.at < TTL_MS) gate = hit.gate;
  else {
    try {
      gate = (await pc.readContract({ address: curve, abi: curveGateAbi, functionName: "loginGate" })) as Address;
    } catch {
      // Pre-gate curves (or unreadable): not legacy by this rule — leave other error paths to handle.
      return false;
    }
    cache.set(k, { gate, at: Date.now() });
  }
  return gate.toLowerCase() !== live.toLowerCase();
}

/** test hook */
export const _resetLegacyGateCache = () => cache.clear();
