/**
 * ⚠️ REDEPLOY ONLY — NOT in the live v3 contracts (web-bundle @ 27e92d8).
 *
 * ABI fragments for FLOW's redeploy (PR #75, branch feat/modes-gas @ 4388d9c6), copied verbatim from
 * sdk/session-keys/src/modes.ts (launchpadModesAbi / curveModesAbi / feeClaimsAbi / depositEscrowAbi) and, where the SDK
 * has no entry, from that branch's contracts/src (FeeRouter.TradeFeeRouted, ReferralRegistry views/events,
 * UsdgDepositNotifier.Deposited). Nothing here is called unless lib/claims/capabilities says the redeploy is live
 * (ABI/env gate + an on-chain probe). After the redeploy, scripts/gen-abi.mjs regenerates the main ABIs and these
 * fragments become redundant: delete this file once lib/abi/* carries them.
 */
import { parseAbi } from "viem";

/** Constants.MODE_* */
export const Mode = { TRENCH_WARFARE: 0, PVE: 1, PVP: 2 } as const;

/** Launchpad (redeploy): per-coin mode + PVE holder (crew) claim. */
export const launchpadRedeployAbi = parseAbi([
  "function modeOf(address token) view returns (uint8)",
  "function claim(address token) returns (uint256)",
  "event LaunchMode(address indexed token, address indexed curve, uint8 mode)",
]);

/** BondingCurve (redeploy, PVE): crew rewards from the 0.777% profit tax on DUMPs. */
export const curveRedeployAbi = parseAbi([
  "function mode() view returns (uint8)",
  "function pendingRewards(address) view returns (uint256)",
  "function rewardsHeld() view returns (uint256)",
  "event ProfitTaxCharged(address indexed token, address indexed seller, uint256 tax, uint256 grossQuote, uint256 costBasis)",
  "event HolderRewardsClaimed(address indexed token, address indexed holder, uint256 amount)",
  "error ZeroAmount()",
]);

/** FeeRouter (redeploy): post-graduation creator share in the LAUNCH token + the new TradeFeeRouted shape. */
export const feeRouterRedeployAbi = parseAbi([
  "function creatorTokenAccrued(address token, address creator) view returns (uint256)",
  "function claimCreatorTokenFees(address token) returns (uint256)",
  "event CreatorTokenFeesClaimed(address indexed token, address indexed creator, uint256 amount)",
  "event TradeFeeRouted(address indexed token, address indexed feeToken, address indexed trader, bool feeIsQuote, address creator, uint256 creatorShare, uint256 creatorTaxAmount, uint256 lpShare, uint256 treasuryShare, address referralPayee, uint256 referralShare, address kolPayee, uint256 kolShare)",
  "error NothingToClaim()",
]);

/** UsdgDepositNotifier (redeploy): referral-gate USDG escrow. Each deposit is its own entry locked LOCK_PERIOD (7 days). */
export const depositNotifierAbi = parseAbi([
  "function deposit(address wallet, uint256 amount) returns (uint256 id)",
  "function withdraw(uint256[] ids) returns (uint256 amount)",
  "function escrowCount(address wallet) view returns (uint256)",
  "function escrowOf(address wallet, uint256 id) view returns (uint256 amount, uint256 unlockAt)",
  "function escrowedOf(address wallet) view returns (uint256)",
  "function LOCK_PERIOD() view returns (uint256)",
  "function usdg() view returns (address)",
  "event Deposited(address indexed payer, address indexed wallet, uint256 amount)",
  "event Escrowed(address indexed wallet, uint256 indexed id, uint256 amount, uint256 unlockAt)",
  "event Withdrawn(address indexed wallet, uint256 amount)",
  "error BelowMinimum(uint256 min)",
  "error Locked(uint256 id, uint256 unlockAt)",
  "error NothingEscrowed()",
  "error ZeroAmount()",
  "error ZeroAddress()",
  "error NotTransferred()",
]);

/** ReferralRegistry (redeploy): first-touch pending referrer, locked by a USDG deposit ≥ the gate. */
export const referralRegistryRedeployAbi = parseAbi([
  "function referrerOf(address wallet) view returns (address)",
  "function pendingReferrer(address wallet) view returns (address)",
  "function usdgDeposited(address wallet) view returns (uint256)",
  "event ReferrerPending(address indexed wallet, address indexed referrer)",
  "event ReferrerAttributed(address indexed wallet, address indexed referrer)",
  "event UsdgDepositRecorded(address indexed wallet, uint256 amount, uint256 total)",
]);
