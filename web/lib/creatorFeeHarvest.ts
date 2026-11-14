import { parseAbi } from "viem";

/**
 * Later send for creator fees. This is not a field on LaunchParams.
 *
 * The launcher calls one of these functions in the create transaction and passes
 * `creatorFeeDestination`. 0 means the creator keeps the creator fees. 1 deposits
 * them into that rocket's locked liquidity pool, and that liquidity is renounced.
 * 2 uses them to buy and burn the quote token. On the bonding curve the fee is
 * already the quote token, so it is burned. After orbit, the quote half is burned
 * and the rocket-token half is sold for more of the quote token, which is burned.
 *
 * A later transaction calls `route`. Anyone may call it. The caller is not paid.
 * `route` pulls both the quote half and the rocket-token half. The creator does not
 * claim, approve, or deposit. Destinations 1 and 2 cannot be self-claimed.
 * Trades do not call this contract. The launch function signatures are unchanged.
 */
export const CREATOR_FEE_DESTINATION = {
  /** The creator keeps the creator fees. */
  keep: 0,
  /** Creator fees are deposited into the rocket's locked liquidity pool, and that liquidity is renounced. */
  lockedPool: 1,
  /** Creator fees buy and burn the quote token. */
  burnQuote: 2,
} as const;

export type CreatorFeeDestination = (typeof CREATOR_FEE_DESTINATION)[keyof typeof CREATOR_FEE_DESTINATION];

/**
 * Mirrors contracts/src/addons/CreatorFeeHarvest.sol. `launchAnonWithUsdg` takes `refundTo` (the player) so a
 * relayer batch (Multicall3) never keeps a leftover. That argument needs the harvest from this PR: the v6 testnet
 * harvest predates it, so private routed launches stay behind PRIVATE_FEE_ROUTING_LIVE (lib/quickLaunch).
 */
export const creatorFeeHarvestAbi = parseAbi([
  "function launch((string name,string ticker,string imageURI,string description,string socialsURI,address quote,uint256 creatorTaxBps,uint256 creatorBuyQuoteIn,uint256 creatorBuyMinTokensOut,uint256 deadline) params, uint8 creatorFeeDestination) returns ((address token,address curve,uint256 creatorTokensBought))",
  "function launchWithMode((string name,string ticker,string imageURI,string description,string socialsURI,address quote,uint256 creatorTaxBps,uint256 creatorBuyQuoteIn,uint256 creatorBuyMinTokensOut,uint256 deadline) params, uint8 mode, uint8 creatorFeeDestination) returns ((address token,address curve,uint256 creatorTokensBought))",
  "function launchWithUsdg((string name,string ticker,string imageURI,string description,string socialsURI,address quote,uint256 creatorTaxBps,uint256 creatorBuyQuoteIn,uint256 creatorBuyMinTokensOut,uint256 deadline) params, uint8 mode, uint256 usdgIn, uint256 minQuoteIn, uint8 creatorFeeDestination) returns ((address token,address curve,uint256 creatorTokensBought), uint256 usdgRefund)",
  "function launchAnon((string name,string ticker,string imageURI,string description,string socialsURI,address quote,uint256 creatorTaxBps,uint256 creatorBuyQuoteIn,uint256 creatorBuyMinTokensOut,uint256 deadline) params, address stealthOwner, address buyRecipient, bytes ephemeralPubKey, bytes1 viewTag, uint256 maxFee, uint8 creatorFeeDestination) returns ((address token,address curve,uint256 creatorTokensBought))",
  "function launchAnonWithUsdg((string name,string ticker,string imageURI,string description,string socialsURI,address quote,uint256 creatorTaxBps,uint256 creatorBuyQuoteIn,uint256 creatorBuyMinTokensOut,uint256 deadline) params, address stealthOwner, address buyRecipient, bytes ephemeralPubKey, bytes1 viewTag, uint256 maxFee, uint256 usdgIn, uint256 minQuoteIn, address refundTo, uint8 creatorFeeDestination) returns ((address token,address curve,uint256 creatorTokensBought), uint256 usdgRefund)",
  "function route(address token) returns (uint256 quoteAmount, uint256 rocketTokenAmount, uint256 quoteBought)",
  // Audit PR #371: routes fees that accrued to a past creator (after transferCreator). Not on the v6 testnet harvest.
  "function routeWith(address token, address pastCreator) returns (uint256 quoteAmount, uint256 rocketTokenAmount, uint256 quoteBought)",
  "function depositRocketTokens(address token, uint256 amount)",
  "function creatorFeeDestinationOf(address token) view returns (uint8)",
  "event CreatorFeeDestinationSet(address indexed token, address indexed launcher, uint8 destination)",
  "event CreatorFeesRouted(address indexed token, uint8 destination, uint256 quoteAmount, uint256 rocketTokenAmount, uint256 quoteBought)",
]);

/** Launch functions on the harvest (gas policy / relayer launch targets). */
export const HARVEST_LAUNCH_FUNCTIONS = ["launch", "launchWithMode", "launchWithUsdg", "launchAnon", "launchAnonWithUsdg"] as const;

/** 1 or 2: the launch must go through the harvest. 0 (keep) uses the usual Launchpad / router / AnonLauncher path. */
export const routesThroughHarvest = (dest: number | undefined): dest is 1 | 2 => dest === 1 || dest === 2;
