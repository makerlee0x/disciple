/**
 * lp-accrue CurveFeeVault reads + claim calls (contracts/src/CurveFeeVault.sol, branch hook/curve-lp-accrue-followups).
 *
 * New curves accrue the 1% trade fee on the curve and settle it into the vault (BondingCurve.feeVault()); unsettled fees
 * are still claimable: every vault claim settles the coin first, and creatorClaimable() previews accrued + still owed.
 *   creator      creatorClaimable(token, creator) / claimCreatorFees(token)                      → CreatorFeesClaimed
 *   private      creatorClaimable(token, launcher) / claimCreatorFeesAsStealth(token, to)        → StealthCreatorFeesClaimed
 *                claimManyAsStealthBySig(ClaimReq) — same Claim struct as AnonLauncher (lib/anon CLAIM_TYPES), domain
 *                "DISCIPLE CurveFeeVault" v1 at the vault, nonce = sigNonces(owner)
 *   referral     referrerAccrued(referrer, quote) / claimReferrerFees(quote, settleTokens)       → ReferrerFeesClaimed
 *   history      CurveFeeSettled (same fields as FeeRouter.TradeFeeRouted, quote side only)
 * Older curves have no feeVault() ⇒ null here and the FeeRouter path is used as before.
 * ABI written by hand (parseAbi) from the contract until lib/abi is regenerated after a deploy.
 */
import { parseAbi, type Address, type PublicClient } from "viem";
import { bondingCurveAbi, launchpadAbi } from "../abi";
import { deployment } from "../chains";

export const curveFeeVaultAbi = parseAbi([
  "function creatorAccrued(address token, address creator) view returns (uint256)",
  "function creatorClaimable(address token, address creator) view returns (uint256)",
  "function referrerAccrued(address referrer, address quote) view returns (uint256)",
  "function treasuryAccrued(address quote) view returns (uint256)",
  "function anonLauncher() view returns (address)",
  "function sigNonces(address owner) view returns (uint256)",
  "function claimCreatorFees(address token) returns (uint256)",
  "function claimReferrerFees(address quote, address[] settleTokens) returns (uint256)",
  "function claimCreatorFeesAsStealth(address token, address to) returns (uint256)",
  "struct ClaimReq { address owner; address[] tokens; address to; uint256 relayerFeeBps; uint256 deadline; bytes sig; }",
  "function claimManyAsStealthBySig(ClaimReq c)",
  "event CurveFeeSettled(address indexed token, address indexed quote, address indexed trader, address creator, uint256 creatorShare, uint256 creatorTaxAmount, uint256 lpShareKept, uint256 treasuryShare, address referralPayee, uint256 referralShare, address kolPayee, uint256 kolShare)",
  "event CreatorFeesClaimed(address indexed token, address indexed creator, uint256 amount)",
  "event ReferrerFeesClaimed(address indexed quote, address indexed referrer, uint256 amount)",
  "event TreasuryFeesClaimed(address indexed asset, address indexed treasury, uint256 amount)",
  "event StealthCreatorFeesClaimed(address indexed token, address indexed stealthOwner, address to, address asset, uint256 amount)",
  "error NothingToClaim()",
  "error NotStealthOwner()",
  "error OnlyClaimRouter()",
  "error OnlyCurve()",
  "error ZeroAddress()",
  "error FeeTooHigh()",
  "error Expired()",
  "error BadSignature()",
]);
const feeVaultViewAbi = parseAbi(["function feeVault() view returns (address)"]);

export const vaultClaimDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: "DISCIPLE CurveFeeVault", version: "1", chainId, verifyingContract }) as const;

const isZero = (a?: string | null) => !a || /^0x0{40}$/i.test(a);
/** Stack-wide vault from config (env NEXT_PUBLIC_<NET>_CURVE_FEE_VAULT), else null. */
export const stackFeeVault = (): Address | null => { const v = deployment().curveFeeVault; return isZero(v) ? null : v; };

const byCurve = new Map<string, Promise<Address | null>>();
/** The coin's CurveFeeVault (BondingCurve.feeVault()), or null for a pre-lp-accrue curve. Cached per curve. */
export function feeVaultOfCurve(pc: PublicClient, curve: Address): Promise<Address | null> {
  const k = curve.toLowerCase();
  let p = byCurve.get(k);
  if (!p) {
    p = pc.readContract({ address: curve, abi: feeVaultViewAbi, functionName: "feeVault" }).then((v) => (isZero(v) ? null : (v as Address)), () => null);
    byCurve.set(k, p);
  }
  return p;
}
export async function feeVaultOf(pc: PublicClient, token: Address): Promise<Address | null> {
  const curve = await pc.readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "curveOf", args: [token] }).catch(() => null);
  return curve && !isZero(curve as string) ? feeVaultOfCurve(pc, curve as Address) : null;
}
/** Quote of a coin's curve (vault rows are always quote-side). */
export const curveQuote = (pc: PublicClient, curve: Address) => pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quote" }) as Promise<Address>;

/** Accrued + still-owed creator fees of `creator` on `token` (0 when the vault is missing or the read fails). */
export function vaultCreatorClaimable(pc: PublicClient, vault: Address | null, token: Address, creator: Address): Promise<bigint> {
  if (!vault) return Promise.resolve(BigInt(0));
  return (pc.readContract({ address: vault, abi: curveFeeVaultAbi, functionName: "creatorClaimable", args: [token, creator] }) as Promise<bigint>).catch(() => BigInt(0));
}
