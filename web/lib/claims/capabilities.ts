/**
 * Claim capabilities: what the deployed contracts support, so the UI shows exactly the balances/claims that exist.
 *
 * LIVE on v3 (decided by the generated web ABI, lib/abi/FeeRouter.ts):
 *   creatorFees   FeeRouter.creatorAccrued(token, creator) + claimCreatorFees(token)
 *   referrerFees  FeeRouter.referrerAccrued(referrer, quote) + claimReferrerFees(quote)
 *
 * REDEPLOY (feat/modes-gas, PR #75), fragments in lib/abi/redeploy.ts. Each needs ALL of:
 *   1. the gate: NEXT_PUBLIC_REDEPLOY_CLAIMS = "1" (on) / "0" (force off) / unset = auto, i.e. on only once the
 *      regenerated web ABI itself carries the function (gen-abi after the redeploy);
 *   2. the address (deposit notifier) where one is needed;
 *   3. an on-chain probe: the view answers at the deployed address (so a v3 deployment with the flag on stays hidden).
 *   creatorTokenFees  FeeRouter.creatorTokenAccrued + claimCreatorTokenFees (post-grad share in the launch token)
 *   crew              Launchpad.modeOf + BondingCurve.pendingRewards + Launchpad.claim(token) (PVE only)
 *   referralGate      UsdgDepositNotifier deposit/escrowOf/withdraw + ReferralRegistry.pendingReferrer
 *
 * TODO(anon): pseudonymous launches accrue to AnonLauncher; claim via AnonLauncher.pending(token) / claimMany(...).
 *   Hook: `anonClaims` below (ABI-detected, no UI yet).
 */
import type { Abi, PublicClient } from "viem";
import { anonLauncherAbi, feeRouterAbi, launchpadAbi } from "../abi";
import { deployment, isDeployed } from "../chains";
import { depositNotifierAbi, feeRouterRedeployAbi, launchpadRedeployAbi, referralRegistryRedeployAbi } from "../abi/redeploy";

export type Caps = {
  creatorFees: boolean;
  referrerFees: boolean;
  creatorTokenFees: boolean;
  crew: boolean;
  referralGate: boolean;
  /** TODO hook only: AnonLauncher pending/claimMany exist in the ABI. */
  anonClaims: boolean;
};

export const abiHas = (abi: Abi | readonly unknown[], name: string) =>
  (abi as readonly { type?: string; name?: string }[]).some((x) => x.type === "function" && x.name === name);

/** Pure gate (unit-tested): flag "1" on, "0" off, anything else = auto (on iff the generated ABI already has it). */
export function redeployGate(flag: string | undefined, abiSignal: boolean): boolean {
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return abiSignal;
}

const Z = "0x0000000000000000000000000000000000000000";
const FLAG = process.env.NEXT_PUBLIC_REDEPLOY_CLAIMS;

/** Static (sync) capabilities: ABI + flag + addresses. A true here still needs probeCaps() before showing UI. */
export function staticCaps(flag: string | undefined = FLAG): Caps {
  const d = isDeployed() ? deployment() : null;
  const fr = d?.feeRouter && d.feeRouter !== Z;
  return {
    creatorFees: !!fr && abiHas(feeRouterAbi, "creatorAccrued") && abiHas(feeRouterAbi, "claimCreatorFees"),
    referrerFees: !!fr && abiHas(feeRouterAbi, "referrerAccrued") && abiHas(feeRouterAbi, "claimReferrerFees"),
    creatorTokenFees: !!fr && redeployGate(flag, abiHas(feeRouterAbi, "creatorTokenAccrued")),
    crew: !!d && redeployGate(flag, abiHas(launchpadAbi, "modeOf") && abiHas(launchpadAbi, "claim")),
    referralGate: !!d && d.depositNotifier !== Z && d.referralRegistry !== Z && redeployGate(flag, true),
    anonClaims: abiHas(anonLauncherAbi, "pending") && abiHas(anonLauncherAbi, "claimMany"),
  };
}

const ok = (p: Promise<unknown>) => p.then(() => true, () => false);
let probed: Promise<Caps> | null = null;

/** Static caps confirmed on-chain (views answer at the deployed addresses). Cached per page load. */
export function probeCaps(pc: PublicClient, flag: string | undefined = FLAG): Promise<Caps> {
  if (probed && flag === FLAG) return probed;
  const s = staticCaps(flag);
  const run = (async (): Promise<Caps> => {
    if (!isDeployed()) return s;
    const d = deployment();
    const [tokenFees, crew, gate] = await Promise.all([
      s.creatorTokenFees ? ok(pc.readContract({ address: d.feeRouter, abi: feeRouterRedeployAbi, functionName: "creatorTokenAccrued", args: [Z, Z] })) : false,
      s.crew ? ok(pc.readContract({ address: d.launchpad, abi: launchpadRedeployAbi, functionName: "modeOf", args: [Z] })) : false,
      s.referralGate
        ? ok(Promise.all([
            pc.readContract({ address: d.depositNotifier, abi: depositNotifierAbi, functionName: "escrowCount", args: [Z] }),
            pc.readContract({ address: d.referralRegistry, abi: referralRegistryRedeployAbi, functionName: "pendingReferrer", args: [Z] }),
          ]))
        : false,
    ]);
    return { ...s, creatorTokenFees: tokenFees, crew, referralGate: gate };
  })();
  if (flag === FLAG) probed = run;
  return run;
}
