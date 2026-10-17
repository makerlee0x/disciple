/**
 * Bonding-curve game modes + accrue/claim fee ABIs (contracts/docs/bonding-modes.md). Calldata/typed-data builders
 * only — nothing here holds or signs with secrets. The PVE login attestation is signed by the protocol BACKEND key.
 */
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

/** Must match Constants.MODE_* */
export const Mode = { TRENCH_WARFARE: 0, PVE: 1, PVP: 2 } as const;
export type ModeId = (typeof Mode)[keyof typeof Mode];

/** Protocol defaults (proposals, Constants.sol) — for UI copy / pre-checks; the chain is the source of truth. */
export const ModeDefaults = {
  pve: { netCapBps: 100, windowSec: 7 * 60, windowBuyCapBps: 25, maxSellBps: 50, profitTriggerBps: 17_700, profitTaxPpm: 7_770 },
  pvp: { capStartBps: 400, capEndBps: 1200, maxBuyBps: 333 },
} as const;

export const launchpadModesAbi = parseAbi([
  "struct LaunchParams { string name; string ticker; string imageURI; string description; string socialsURI; address quote; uint256 creatorTaxBps; uint256 creatorBuyQuoteIn; uint256 creatorBuyMinTokensOut; uint256 deadline; }",
  "struct LaunchResult { address token; address curve; uint256 creatorTokensBought; }",
  "function launchWithMode(LaunchParams params, uint8 mode) returns (LaunchResult)",
  "function modeOf(address token) view returns (uint8)",
  "function claim(address token) returns (uint256)",
  "function loginGate() view returns (address)",
  "function isTrustedRouter(address router) view returns (bool)",
  "event LaunchMode(address indexed token, address indexed curve, uint8 mode)",
]);

export const curveModesAbi = parseAbi([
  "struct BuyQuote { uint256 tokensOut; uint256 fee; uint256 snipeFee; uint256 quoteToCurve; uint256 priceAfterX18; uint256 impactBps; uint256 mcapAfterUsd; bool graduates; uint256 refund; }",
  "struct SellQuote { uint256 quoteOut; uint256 fee; uint256 grossQuote; uint256 priceAfterX18; uint256 impactBps; uint256 mcapAfterUsd; uint256 profitTax; }",
  "function mode() view returns (uint8)",
  "function launchTime() view returns (uint256)",
  "function launchBlock() view returns (uint256)",
  "function netCapNow() view returns (uint256)",
  "function maxBuyNow() view returns (uint256)",
  "function maxSellNow() view returns (uint256)",
  "function balanceOnCurve(address) view returns (uint256)",
  "function costBasisOf(address) view returns (uint256)",
  "function verifiedUntilOf(address) view returns (uint64)",
  "function pendingRewards(address) view returns (uint256)",
  "function totalNet() view returns (uint256)",
  "function quoteBuyFor(address trader, uint256 quoteIn) view returns (BuyQuote)",
  "function quoteSellFor(address trader, uint256 tokensIn) view returns (SellQuote)",
  "function claim() returns (uint256)",
  "function trustedRouter() view returns (address)",
  "function rewardsHeld() view returns (uint256)",
  "event ProfitTaxCharged(address indexed token, address indexed seller, uint256 tax, uint256 grossQuote, uint256 costBasis)",
  "event HolderRewardsClaimed(address indexed token, address indexed holder, uint256 amount)",
  "error LaunchBlock()",
  "error NotVerified()",
  "error BuyTooLarge()",
  "error SellTooLarge()",
  "error WalletCap()",
  "error NotRouter()",
  "error NotPrepaid()",
  "error OnlyToken()",
  "error BadParams()",
  "error PriceImpactTooHigh(uint256 impactBps, uint256 maxImpactBps)",
]);

/** DiscipleHook: block-start anchor + 60s time-weighted EMA reference (compound guard) + altitude tier. */
export const hookAnchorAbi = parseAbi([
  "function blockAnchor(bytes32 id) view returns (uint64 blockNumber, uint160 sqrtPriceX96)",
  "function priceReference(bytes32 id) view returns (int32 emaTickX256, uint40 emaTime, uint40 refSince, uint8 obs, bool ready)",
  "function compoundRefs(bytes32 id) view returns (uint160 refBlock, uint160 refEma)",
  "function altitudeTierOf(bytes32 id) view returns (uint8)",
]);

/** Trade events. BondingCurve (pre-grad) ends with `uint256 mcapAfterUsd`; DiscipleHook (post-grad, gas G-1) ends with
 *  `uint160 sqrtPriceAfter` (different topic0). Decode both. Hook USD mcap off-chain:
 *  DiscipleHook.mcapUsdFromSqrt(sqrtPriceAfter, tokenIsC0, DiscipleHook.quoteUsdOf(poolId)). */
export const tradeEventsAbi = parseAbi([
  "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 quoteAmt, uint256 tokenAmt, uint256 fee, uint256 snipeFee, uint256 priceBeforeX18, uint256 priceAfterX18, uint256 impactBps, uint256 mcapAfterUsd)",
  "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 quoteAmt, uint256 tokenAmt, uint256 fee, uint256 snipeFee, uint256 priceBeforeX18, uint256 priceAfterX18, uint256 impactBps, uint160 sqrtPriceAfter)",
  "event AltitudeUpdate(address indexed token, uint256 mcapUsd, uint8 tier)",
  "event TierBreak(address indexed token, uint8 fromTier, uint8 toTier, uint256 mcapUsd)",
  "function mcapUsdFromSqrt(uint160 sqrtP, bool tokenIsC0, uint256 qUsd) pure returns (uint256)",
  "function quoteUsdOf(bytes32 id) view returns (uint256)",
]);

/** UsdgDepositNotifier: referral-gate USDG escrow (min $10). Each deposit is its own entry locked 7 days from that
 *  deposit (gifts never re-lock existing entries). Approve the notifier for exactly `amount`. */
export const depositEscrowAbi = parseAbi([
  "function deposit(address wallet, uint256 amount) returns (uint256 id)",
  "function withdraw(uint256[] ids) returns (uint256 amount)",
  "function escrowCount(address wallet) view returns (uint256)",
  "function escrowOf(address wallet, uint256 id) view returns (uint256 amount, uint256 unlockAt)",
  "function escrowedOf(address wallet) view returns (uint256)",
  "function LOCK_PERIOD() view returns (uint256)",
  "event Deposited(address indexed payer, address indexed wallet, uint256 amount)",
  "event Escrowed(address indexed wallet, uint256 indexed id, uint256 amount, uint256 unlockAt)",
  "event Withdrawn(address indexed wallet, uint256 amount)",
  "error BelowMinimum(uint256 min)",
  "error Locked(uint256 id, uint256 unlockAt)",
  "error NothingEscrowed()",
]);

/** Token (PVE coins only): pre-graduation transfer hook into the curve so NET/cost basis follow transfers. */
export const tokenPveAbi = parseAbi([
  "function pveHooks() view returns (bool)",
  "function pveCurve() view returns (address)",
  "function pveLive() view returns (bool)",
]);

export const loginGateAbi = parseAbi([
  "function attest(address wallet, uint64 expiry, address coin, bytes sig)",
  "function verifiedUntil(address wallet, address coin) view returns (uint64)",
  "function attester() view returns (address)",
  "function MAX_TTL() view returns (uint256)",
  "error TtlTooLong()",
  "event LoginAttested(address indexed wallet, address indexed coin, uint64 expiry)",
]);

/** Accrue-then-claim fee balances (FeeRouter). */
export const feeClaimsAbi = parseAbi([
  "function creatorAccrued(address token, address creator) view returns (uint256)",
  "function creatorTokenAccrued(address token, address creator) view returns (uint256)",
  "function referrerAccrued(address referrer, address asset) view returns (uint256)",
  "function treasuryAccrued(address asset) view returns (uint256)",
  "function claimCreatorFees(address token) returns (uint256)",
  "function claimCreatorTokenFees(address token) returns (uint256)",
  "function claimReferrerFees(address asset) returns (uint256)",
  "function claimTreasury(address asset) returns (uint256)",
  "event CreatorTokenFeesClaimed(address indexed token, address indexed creator, uint256 amount)",
  "event TreasuryFeesClaimed(address indexed asset, address indexed treasury, uint256 amount)",
]);

/** EIP-712 typed data the backend signs after verifying a Privy login (coin = zero address → all PVE coins). */
export function loginAttestationTypedData(a: { chainId: number; gate: Address; wallet: Address; expiry: bigint; coin?: Address }) {
  return {
    domain: { name: "DisciplePVE", version: "1", chainId: a.chainId, verifyingContract: a.gate },
    types: { LoginAttestation: [ { name: "wallet", type: "address" }, { name: "expiry", type: "uint64" }, { name: "coin", type: "address" } ] },
    primaryType: "LoginAttestation" as const,
    message: { wallet: a.wallet, expiry: a.expiry, coin: a.coin ?? "0x0000000000000000000000000000000000000000" },
  };
}

export function encodeAttest(a: { wallet: Address; expiry: bigint; coin?: Address; sig: Hex }): Hex {
  return encodeFunctionData({ abi: loginGateAbi, functionName: "attest", args: [a.wallet, a.expiry, a.coin ?? "0x0000000000000000000000000000000000000000", a.sig] });
}
export function encodeHolderClaim(token: Address): Hex {
  return encodeFunctionData({ abi: launchpadModesAbi, functionName: "claim", args: [token] });
}
export function encodeClaimTreasury(asset: Address): Hex {
  return encodeFunctionData({ abi: feeClaimsAbi, functionName: "claimTreasury", args: [asset] });
}
export function encodeClaimCreatorTokenFees(token: Address): Hex {
  return encodeFunctionData({ abi: feeClaimsAbi, functionName: "claimCreatorTokenFees", args: [token] });
}
