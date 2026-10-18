import { parseAbi } from "viem";

const TRADE =
  "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 quoteAmt, uint256 tokenAmt, uint256 fee, uint256 snipeFee, uint256 priceBeforeX18, uint256 priceAfterX18, uint256 impactBps, uint256 mcapAfterUsd)";

/** LPDonation (removed in PR #44) is intentionally not decoded. FeesClaimed / SnipeFeeRoutedToLP stay for older stacks.
 * Every event the indexer stores (union across stacks; old stacks simply never emit the newer ones). */
export const EVENTS = parseAbi([
  "event Launched(address indexed token, address indexed curve, address indexed creator, address quote, string name, string ticker, uint256 creatorTaxBps)",
  "event QuotePriced(address indexed token, address indexed quote, uint256 quotePriceUsd)",
  "event MetadataUpdated(address indexed token, string imageURI, string description, string socialsURI)",
  "event CreatorTransferred(address indexed token, address indexed previousCreator, address indexed newCreator)",
  TRADE,
  "event GraduatedToV4(address indexed token, bytes32 poolId, uint256 tokenLiq, uint256 quoteLiq)",
  "event Migrated(address indexed token, address indexed quote, bytes32 poolId, uint256 tokenAmount, uint256 quoteAmount, uint160 sqrtPriceX96)",
  "event TrampPlaced(uint256 indexed id, address indexed owner, address indexed token, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 quoteAmt)",
  "event WallPlaced(uint256 indexed id, address indexed owner, address indexed token, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 tokenAmt)",
  "event Filled(uint256 indexed id, address indexed owner, address indexed token, int24 tickLower, int24 tickUpper, uint256 quoteOut, uint256 tokenOut, address keeper)",
  "event Cancelled(uint256 indexed id, address indexed owner, address indexed token, int24 tickLower, int24 tickUpper, uint256 quoteOut, uint256 tokenOut, uint256 quoteFees, uint256 tokenFees)",
  "event FeesClaimed(uint256 indexed id, address indexed owner, address indexed token, uint256 quoteFees, uint256 tokenFees)",
  "event TradeFeeRouted(address indexed token, address indexed quote, address indexed trader, uint256 creatorShare, uint256 lpShare, uint256 treasuryShare, uint256 referralShare, uint256 creatorTaxAmount)",
  "event CreatorFeesClaimed(address indexed token, address indexed creator, uint256 amount)",
  "event SnipeFeeRoutedToLP(address indexed token, address indexed quote, uint256 amount)",
  "event SnipeFeeRouted(address indexed token, address indexed quote, uint256 toRewards, uint256 toTreasury)",
  "event AnonLaunched(address indexed token, address indexed curve, address indexed stealthOwner, uint256 tokensBought)",
  "event Claimed(address indexed token, address indexed stealthOwner, address to, address asset, uint256 amount)",
  "event StealthOwnerTransferred(address indexed token, address indexed from, address indexed to)",
  "event RewardAccrued(address indexed token, address indexed asset, uint256 amount)",
  "event Distributed(address indexed asset, address indexed to, uint256 amount)",
  // flow/jit-twap (PR #44) additions
  "event LaunchTierContext(address indexed token, uint256 startMcapUsd, uint256 graduationMcapUsd, uint256 totalSupply, uint8 decimals_)",
  "event AltitudeUpdate(address indexed token, uint256 mcapUsd, uint8 tier)",
  "event TierBreak(address indexed token, uint8 fromTier, uint8 toTier, uint256 mcapUsd)",
  "event KeeperTipPaid(uint256 indexed id, address indexed keeper, uint256 quoteTip, uint256 tokenTip)",
  "event ReferrerFeesClaimed(address indexed quote, address indexed referrer, uint256 amount)",
  "event ReferrerAttributed(address indexed wallet, address indexed referrer)",
  "event ReferrerPending(address indexed wallet, address indexed referrer)",
  "event UsdgDepositRecorded(address indexed wallet, uint256 amount, uint256 total)",
  "event LaunchFeePaid(address indexed token, uint256 amount)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  // ── redeploy (feat/modes-gas, PR #75) additions. Old stacks never emit these; signatures from contracts/src on that branch.
  // TradeFeeRouted changed signature (different topic0): feeToken + feeIsQuote (post-grad fees can be in the launch token),
  // creator, referral/KOL payees. Both overloads decode; ingest normalizes them to the same fee_events columns.
  "event TradeFeeRouted(address indexed token, address indexed feeToken, address indexed trader, bool feeIsQuote, address creator, uint256 creatorShare, uint256 creatorTaxAmount, uint256 lpShare, uint256 treasuryShare, address referralPayee, uint256 referralShare, address kolPayee, uint256 kolShare)",
  "event CreatorTokenFeesClaimed(address indexed token, address indexed creator, uint256 amount)",
  "event LaunchMode(address indexed token, address indexed curve, uint8 mode)",
  // BondingCurve (PVE): 0.777% profit tax on DUMPs → crew (holder) rewards pool; holders claim via Launchpad.claim(token)
  "event ProfitTaxCharged(address indexed token, address indexed seller, uint256 tax, uint256 grossQuote, uint256 costBasis)",
  "event HolderRewardsClaimed(address indexed token, address indexed holder, uint256 amount)",
  // UsdgDepositNotifier: referral-gate USDG escrow (each deposit locked 7 days)
  "event Deposited(address indexed payer, address indexed wallet, uint256 amount)",
  "event Escrowed(address indexed wallet, uint256 indexed id, uint256 amount, uint256 unlockAt)",
  "event Withdrawn(address indexed wallet, uint256 amount)",
]);

export const READS = parseAbi([
  "function mcapNow() view returns (uint256)",
  "function priceNow() view returns (uint256)",
  "function quoteReserve() view returns (uint256)",
  "function graduated() view returns (bool)",
  "function quotePriceUsd() view returns (uint256)",
  "function quotePriceUsd(address) view returns (uint256)",
  "function creatorOf(address) view returns (address)",
  "function creatorAccrued(address,address) view returns (uint256)",
  "function creatorTokenAccrued(address,address) view returns (uint256)",
  "function pending(address) view returns (address quote, uint256 quoteAmt, uint256 tokenAmt)",
  "function stealthOwnerOf(address) view returns (address)",
  "function market(address) view returns (uint256 priceWad, uint256 mcapUsd, bool graduated)",
  "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32) view returns (uint128)",
  "function pricer() view returns (address)",
]);
