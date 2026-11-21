/**
 * Claim capabilities on the v4 stack (generated ABIs in lib/abi/*, addresses in lib/chains.ts).
 *
 *   creatorFees       FeeRouter.creatorAccrued(token, creator) + claimCreatorFees(token)           (quote side, pre-grad)
 *   creatorTokenFees  FeeRouter.creatorTokenAccrued(token, creator) + claimCreatorTokenFees(token) (launch token, post-grad)
 *   referrerFees      FeeRouter.referrerAccrued(referrer, quote) + claimReferrerFees(quote)        (referrer FIRST)
 *   crew              Launchpad.modeOf / curveOf + BondingCurve.pendingRewards + Launchpad.claim   (PVE only)
 *   referralGate      UsdgDepositNotifier minDeposit / deposit / escrowCount / escrowOf / withdraw
 *   anonClaims        AnonLauncher.pending(token) + claimMany / claimManyBySig, on the coin's launcher (v2, or v1 legacy)
 *   curveFeeVault     lp-accrue CurveFeeVault configured (deployment().curveFeeVault) and answering referrerAccrued. Per-coin
 *                     creator rows do not need it (they read BondingCurve.feeVault()); it scopes the stack-wide referral /
 *                     history reads. Optional in Caps so older literals stay valid.
 *
 * Each needs the function in the generated ABI, a non-zero address, and (probeCaps) a view answering on-chain,
 * so a misconfigured env hides the card instead of showing broken buttons.
 */
import type { Abi, PublicClient } from "viem";
import { anonLauncherAbi, bondingCurveAbi, feeRouterAbi, launchpadAbi, usdgDepositNotifierAbi } from "../abi";
import { ANON_ADDONS } from "../anon";
import { ACTIVE_CHAIN, deployment, isDeployed } from "../chains";
import { curveFeeVaultAbi } from "./vault";

export type Caps = {
  creatorFees: boolean;
  referrerFees: boolean;
  creatorTokenFees: boolean;
  crew: boolean;
  referralGate: boolean;
  anonClaims: boolean;
  curveFeeVault?: boolean;
};

export const abiHas = (abi: Abi | readonly unknown[], name: string) =>
  (abi as readonly { type?: string; name?: string }[]).some((x) => x.type === "function" && x.name === name);

const Z = "0x0000000000000000000000000000000000000000";
const set = (a?: string) => !!a && a.toLowerCase() !== Z;
/** AnonLauncher v2 (default for new private launches; its claims pay both the quote and the post-grad token share). */
export const anonLauncherAddr = () => ANON_ADDONS[ACTIVE_CHAIN.id]?.anonLauncher;
/** AnonLauncher v1 (legacy coins only). Each coin's launcher = Launchpad.creatorOf(token); see lib/claims/creatorFees anonRockets. */
export const anonLauncherLegacyAddr = () => ANON_ADDONS[ACTIVE_CHAIN.id]?.anonLauncherLegacy;

/** Static (sync) capabilities: ABI + addresses. A true here still needs probeCaps() before showing UI. */
export function staticCaps(): Caps {
  const d = isDeployed() ? deployment() : null;
  const fr = set(d?.feeRouter);
  return {
    creatorFees: fr && abiHas(feeRouterAbi, "creatorAccrued") && abiHas(feeRouterAbi, "claimCreatorFees"),
    referrerFees: fr && abiHas(feeRouterAbi, "referrerAccrued") && abiHas(feeRouterAbi, "claimReferrerFees"),
    creatorTokenFees: fr && abiHas(feeRouterAbi, "creatorTokenAccrued") && abiHas(feeRouterAbi, "claimCreatorTokenFees"),
    crew: !!d && abiHas(launchpadAbi, "modeOf") && abiHas(launchpadAbi, "claim") && abiHas(bondingCurveAbi, "pendingRewards"),
    referralGate: !!d && set(d.usdgDepositNotifier) && abiHas(usdgDepositNotifierAbi, "minDeposit") && abiHas(usdgDepositNotifierAbi, "escrowOf"),
    anonClaims: set(anonLauncherAddr()) && abiHas(anonLauncherAbi, "pending") && abiHas(anonLauncherAbi, "claimMany"),
    curveFeeVault: !!d && set(d.curveFeeVault),
  };
}

const ok = (p: Promise<unknown>) => p.then(() => true, () => false);
let probed: Promise<Caps> | null = null;

/** Static caps confirmed on-chain (views answer at the deployed addresses). Cached per page load. */
export function probeCaps(pc: PublicClient): Promise<Caps> {
  if (probed) return probed;
  const s = staticCaps();
  probed = (async (): Promise<Caps> => {
    if (!isDeployed()) return s;
    const d = deployment();
    const key = cacheKey(s);
    const hit = readCached(key);
    if (hit) return hit;
    const [quote, token, ref, crew, gate, anon, vault] = await Promise.all([
      s.creatorFees ? ok(pc.readContract({ address: d.feeRouter, abi: feeRouterAbi, functionName: "creatorAccrued", args: [Z, Z] })) : false,
      s.creatorTokenFees ? ok(pc.readContract({ address: d.feeRouter, abi: feeRouterAbi, functionName: "creatorTokenAccrued", args: [Z, Z] })) : false,
      s.referrerFees ? ok(pc.readContract({ address: d.feeRouter, abi: feeRouterAbi, functionName: "referrerAccrued", args: [Z, Z] })) : false,
      s.crew ? ok(pc.readContract({ address: d.launchpad, abi: launchpadAbi, functionName: "modeOf", args: [Z] })) : false,
      s.referralGate ? ok(pc.readContract({ address: d.usdgDepositNotifier, abi: usdgDepositNotifierAbi, functionName: "minDeposit" })) : false,
      s.anonClaims ? ok(pc.readContract({ address: anonLauncherAddr()!, abi: anonLauncherAbi, functionName: "stealthOwnerOf", args: [Z] })) : false,
      s.curveFeeVault ? ok(pc.readContract({ address: d.curveFeeVault, abi: curveFeeVaultAbi, functionName: "referrerAccrued", args: [Z, Z] })) : false,
    ]);
    const caps: Caps = { creatorFees: quote, creatorTokenFees: token, referrerFees: ref, crew, referralGate: gate, anonClaims: anon, curveFeeVault: vault };
    writeCached(key, s, caps);
    return caps;
  })();
  probed.catch(() => { probed = null; });
  return probed;
}

/* Probe cache (speed pass 2026-11-21): the 7 reads above ran on every page load for every signed-in player. The answer
   only changes with a redeploy, so a full pass (every capability the ABI and addresses allow answered) is kept for 6 hours,
   keyed by chain and the probed addresses. A partial or failed pass is never kept, so a flaky RPC can't hide a card. */
const CAPS_LS = "disciple.caps.v1";
const CAPS_TTL_MS = 6 * 3600_000;
function cacheKey(s: Caps): string {
  const d = isDeployed() ? deployment() : null;
  return [ACTIVE_CHAIN.id, d?.feeRouter, d?.launchpad, d?.usdgDepositNotifier, d?.curveFeeVault, anonLauncherAddr(), JSON.stringify(s)].join("|").toLowerCase();
}
function readCached(key: string): Caps | null {
  try {
    const v = JSON.parse(localStorage.getItem(CAPS_LS) || "null") as { key?: string; at?: number; caps?: Caps } | null;
    if (!v || v.key !== key || !v.caps || typeof v.at !== "number" || Date.now() - v.at > CAPS_TTL_MS || v.at > Date.now()) return null;
    return v.caps;
  } catch { return null; }
}
function writeCached(key: string, s: Caps, caps: Caps) {
  const full = (Object.keys(s) as (keyof Caps)[]).every((k) => !s[k] || caps[k]);
  try { if (full) localStorage.setItem(CAPS_LS, JSON.stringify({ key, at: Date.now(), caps })); } catch { /* private mode */ }
}
