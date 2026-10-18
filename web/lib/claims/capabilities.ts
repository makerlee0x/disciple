/**
 * Claim capabilities on the v4 stack (generated ABIs in lib/abi/*, addresses in lib/chains.ts).
 *
 *   creatorFees       FeeRouter.creatorAccrued(token, creator) + claimCreatorFees(token)           (quote side, pre-grad)
 *   creatorTokenFees  FeeRouter.creatorTokenAccrued(token, creator) + claimCreatorTokenFees(token) (launch token, post-grad)
 *   referrerFees      FeeRouter.referrerAccrued(referrer, quote) + claimReferrerFees(quote)        (referrer FIRST)
 *   crew              Launchpad.modeOf / curveOf + BondingCurve.pendingRewards + Launchpad.claim   (PVE only)
 *   referralGate      UsdgDepositNotifier minDeposit / deposit / escrowCount / escrowOf / withdraw
 *   anonClaims        AnonLauncher.pending(token) + claimMany(tokens, to)                         (stealth owner)
 *
 * Each needs the function in the generated ABI, a non-zero address, and (probeCaps) a view answering on-chain,
 * so a misconfigured env hides the card instead of showing broken buttons.
 */
import type { Abi, PublicClient } from "viem";
import { anonLauncherAbi, bondingCurveAbi, feeRouterAbi, launchpadAbi, usdgDepositNotifierAbi } from "../abi";
import { ANON_ADDONS } from "../anon";
import { ACTIVE_CHAIN, deployment, isDeployed } from "../chains";

export type Caps = {
  creatorFees: boolean;
  referrerFees: boolean;
  creatorTokenFees: boolean;
  crew: boolean;
  referralGate: boolean;
  anonClaims: boolean;
};

export const abiHas = (abi: Abi | readonly unknown[], name: string) =>
  (abi as readonly { type?: string; name?: string }[]).some((x) => x.type === "function" && x.name === name);

const Z = "0x0000000000000000000000000000000000000000";
const set = (a?: string) => !!a && a.toLowerCase() !== Z;
export const anonLauncherAddr = () => ANON_ADDONS[ACTIVE_CHAIN.id]?.anonLauncher;

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
    const [quote, token, ref, crew, gate, anon] = await Promise.all([
      s.creatorFees ? ok(pc.readContract({ address: d.feeRouter, abi: feeRouterAbi, functionName: "creatorAccrued", args: [Z, Z] })) : false,
      s.creatorTokenFees ? ok(pc.readContract({ address: d.feeRouter, abi: feeRouterAbi, functionName: "creatorTokenAccrued", args: [Z, Z] })) : false,
      s.referrerFees ? ok(pc.readContract({ address: d.feeRouter, abi: feeRouterAbi, functionName: "referrerAccrued", args: [Z, Z] })) : false,
      s.crew ? ok(pc.readContract({ address: d.launchpad, abi: launchpadAbi, functionName: "modeOf", args: [Z] })) : false,
      s.referralGate ? ok(pc.readContract({ address: d.usdgDepositNotifier, abi: usdgDepositNotifierAbi, functionName: "minDeposit" })) : false,
      s.anonClaims ? ok(pc.readContract({ address: anonLauncherAddr()!, abi: anonLauncherAbi, functionName: "stealthOwnerOf", args: [Z] })) : false,
    ]);
    return { creatorFees: quote, creatorTokenFees: token, referrerFees: ref, crew, referralGate: gate, anonClaims: anon };
  })();
  probed.catch(() => { probed = null; });
  return probed;
}
