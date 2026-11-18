import { parseAbi } from "viem";
import { MAINNET_CHAIN_ID } from "./networkConfig";

/**
 * Private (hidden-name) launches on every difficulty (maker 2026-11-16). Needs the AnonLauncher, CreatorFeeHarvest and
 * DisciplePermitForwarder from the "anon launches on every difficulty" contracts change: AnonLauncher.launchAnonWithMode /
 * launchAnonWithUsdgMode (Easy holds the First BOOST until orbit, then releaseBoost), the harvest's *Mode wrappers, and
 * the forwarder's signed AnonLaunch struct with `uint8 mode`. The deployed testnet contracts don't have them, so keep false
 * until they are deployed (the mainnet deploy, or a testnet redeploy), then flip. While false, hidden launches stay on Expert.
 * Mainnet (4663) deploys from 425a23b+, which has all three, so it is on there (maker 2026-11-18). Testnet stays off
 * until a redeploy; NEXT_PUBLIC_ANON_ANY_MODE=1 / 0 overrides either way.
 */
const ANON_ENV = process.env.NEXT_PUBLIC_ANON_ANY_MODE;
export const ANON_ANY_MODE_LIVE: boolean =
  ANON_ENV === "1" || ANON_ENV === "true" ? true
  : ANON_ENV === "0" || ANON_ENV === "false" ? false
  : Number(process.env.NEXT_PUBLIC_CHAIN_ID || 0) === MAINNET_CHAIN_ID;

const P =
  "(string name,string ticker,string imageURI,string description,string socialsURI,address quote,uint256 creatorTaxBps,uint256 creatorBuyQuoteIn,uint256 creatorBuyMinTokensOut,uint256 deadline)";

/** AnonLauncher functions added with the modes change (lib/abi/AnonLauncher.ts is generated from the deployed v5 bundle). */
export const anonLauncherModesAbi = parseAbi([
  `function launchAnonWithMode(${P} p, uint8 mode, address stealthOwner, address buyRecipient, bytes ephemeralPubKey, bytes1 viewTag, uint256 maxFee) returns ((address token,address curve,uint256 creatorTokensBought) r)`,
  `function launchAnonWithUsdgMode(${P} p, uint8 mode, address stealthOwner, address buyRecipient, bytes ephemeralPubKey, bytes1 viewTag, uint256 maxFee, uint256 usdgIn, uint256 minQuoteIn, address refundTo) returns ((address token,address curve,uint256 creatorTokensBought) r, uint256 usdgRefund)`,
  "function heldBoost(address token) view returns (address recipient, uint96 amount, address curve)",
  "function releaseBoost(address token)",
  "event BoostHeld(address indexed token, address indexed recipient, uint256 amount)",
  "event BoostReleased(address indexed token, address indexed recipient, uint256 tokens, uint256 rewards)",
]);
