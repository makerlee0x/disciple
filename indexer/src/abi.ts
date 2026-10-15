import { parseAbi } from "viem";

const TRADE =
  "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 quoteAmt, uint256 tokenAmt, uint256 fee, uint256 snipeFee, uint256 priceBeforeX18, uint256 priceAfterX18, uint256 impactBps, uint256 mcapAfterUsd)";

/** Every event the indexer stores (union across stacks; old stacks simply never emit the newer ones). */
export const EVENTS = parseAbi([
  "event Launched(address indexed token, address indexed curve, address indexed creator, address quote, string name, string ticker, uint256 creatorTaxBps)",
  "event QuotePriced(address indexed token, address indexed quote, uint256 quotePriceUsd)",
  "event MetadataUpdated(address indexed token, string imageURI, string description, string socialsURI)",
  "event CreatorTransferred(address indexed token, address indexed previousCreator, address indexed newCreator)",
  TRADE,
  "event GraduatedToV4(address indexed token, bytes32 poolId, uint256 tokenLiq, uint256 quoteLiq)",
  "event Migrated(address indexed token, address indexed quote, bytes32 poolId, uint256 tokenAmount, uint256 quoteAmount, uint160 sqrtPriceX96)",
  "event LPDonation(address indexed token, address indexed currency, uint256 amount)",
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
  "event Transfer(address indexed from, address indexed to, uint256 value)",
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
  "function pending(address) view returns (address quote, uint256 quoteAmt, uint256 tokenAmt)",
  "function stealthOwnerOf(address) view returns (address)",
  "function market(address) view returns (uint256 priceWad, uint256 mcapUsd, bool graduated)",
  "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32) view returns (uint128)",
  "function pricer() view returns (address)",
]);
