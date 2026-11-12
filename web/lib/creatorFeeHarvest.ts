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
 * Trades do not call this contract.
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

export const creatorFeeHarvestAbi = [
  "function launch((string,string,string,string,string,address,uint256,uint256,uint256,uint256) params, uint8 creatorFeeDestination) returns ((address,address,uint256))",
  "function launchWithMode((string,string,string,string,string,address,uint256,uint256,uint256,uint256) params, uint8 mode, uint8 creatorFeeDestination) returns ((address,address,uint256))",
  "function launchWithUsdg((string,string,string,string,string,address,uint256,uint256,uint256,uint256) params, uint8 mode, uint256 usdgIn, uint256 minQuoteIn, uint8 creatorFeeDestination) returns ((address,address,uint256), uint256)",
  "function launchAnon((string,string,string,string,string,address,uint256,uint256,uint256,uint256) params, address stealthOwner, address buyRecipient, bytes ephemeralPubKey, bytes1 viewTag, uint256 maxFee, uint8 creatorFeeDestination) returns ((address,address,uint256))",
  "function launchAnonWithUsdg((string,string,string,string,string,address,uint256,uint256,uint256,uint256) params, address stealthOwner, address buyRecipient, bytes ephemeralPubKey, bytes1 viewTag, uint256 maxFee, uint256 usdgIn, uint256 minQuoteIn, uint8 creatorFeeDestination) returns ((address,address,uint256), uint256)",
  "function route(address token) returns (uint256 quoteAmount, uint256 rocketTokenAmount, uint256 quoteBought)",
  "function depositRocketTokens(address token, uint256 amount)",
  "function creatorFeeDestinationOf(address token) view returns (uint8)",
  "event CreatorFeeDestinationSet(address indexed token, address indexed launcher, uint8 destination)",
  "event CreatorFeesRouted(address indexed token, uint8 destination, uint256 quoteAmount, uint256 rocketTokenAmount, uint256 quoteBought)",
] as const;
