/**
 * Anon launch pool (contracts/src/addons/AnonLaunchPool.sol), maker 2026-11-19: "if your wallet is connected thats not
 * anon". The old private launch pulled the First BOOST from the player's wallet through DisciplePermitForwarder, so the
 * launch tx named that wallet (AnonLaunchRelayed.owner, the Permit2 transfer, the refund). With the pool:
 *   1. the player tops up an anon balance (a USDG transfer or gasless withdraw to the pool, a separate tx at any time),
 *   2. the site keeps the balance in its own ledger (lib/server/anonPoolLedger),
 *   3. the site's spend signer signs one PoolLaunch for the exact launch and a relayer submits AnonLaunchPool.launch.
 * The launch tx holds the relayer, the pool, the launcher and the stealth owner only. Free launches ($0 Ticket) use the
 * same path, so no anon launch ever needs a player signature on-chain.
 *
 * ANON_POOL_LIVE stays false until the pool is deployed and its address is set per chain (NEXT_PUBLIC_*_ANON_POOL).
 */
import { encodeAbiParameters, keccak256, parseAbi, type Address, type Hex } from "viem";
import { robinhood, robinhoodTestnet } from "./chains";

export const ANON_POOL_LIVE = false;

// NOTE: NEXT_PUBLIC_* must be referenced literally for Next.js to inline them.
const env = (v: string | undefined): Address | null => (v && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/i.test(v) ? (v as Address) : null);
export const ANON_POOL: Record<number, Address | null> = {
  [robinhood.id]: env(process.env.NEXT_PUBLIC_RH_ANON_POOL),
  [robinhoodTestnet.id]: env(process.env.NEXT_PUBLIC_RHT_ANON_POOL),
};
export const anonPoolAddress = (chainId: number): Address | null => (ANON_POOL_LIVE ? ANON_POOL[chainId] ?? null : null);

const P =
  "(string name,string ticker,string imageURI,string description,string socialsURI,address quote,uint256 creatorTaxBps,uint256 creatorBuyQuoteIn,uint256 creatorBuyMinTokensOut,uint256 deadline)";
const ARGS = `(${P} p,uint8 mode,address stealthOwner,address buyRecipient,bytes ephemeralPubKey,bytes1 viewTag,uint256 minQuoteIn,uint8 creatorFeeDestination)`;

export const anonPoolAbi = parseAbi([
  `function launch(${ARGS} a, uint256 usdgIn, uint256 nonce, uint256 deadline, bytes sig) returns ((address token,address curve,uint256 creatorTokensBought) r, uint256 spent)`,
  "function payout(address to, uint256 amount, uint256 nonce, uint256 deadline, bytes sig)",
  "function deposit(uint256 amount)",
  "function usedNonce(uint256) view returns (bool)",
  "function spendSigner() view returns (address)",
  "event Deposited(address indexed from, uint256 amount)",
  "event PoolLaunched(address indexed token, address indexed curve, uint256 indexed nonce, uint256 usdgIn, uint256 spent)",
  "event PaidOut(uint256 indexed nonce, address indexed to, uint256 amount)",
]);

export type PoolLaunchParams = {
  name: string; ticker: string; imageURI: string; description: string; socialsURI: string;
  quote: Address; creatorTaxBps: bigint; creatorBuyQuoteIn: bigint; creatorBuyMinTokensOut: bigint; deadline: bigint;
};
export type PoolLaunchArgs = {
  p: PoolLaunchParams;
  mode: number; // 0 Expert (Trench), 1 Easy, 2 Hard
  stealthOwner: Address;
  buyRecipient: Address;
  ephemeralPubKey: Hex;
  viewTag: Hex; // bytes1
  minQuoteIn: bigint;
  creatorFeeDestination: number; // 0 keep, 1 locked pool, 2 buy-and-burn
};

/** Same as AnonLaunchPool.launchHash: keccak256(abi.encode(p, mode, stealthOwner, buyRecipient, keccak(eph), viewTag, minQuoteIn, dest)). */
export function poolLaunchHash(a: PoolLaunchArgs): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "tuple", components: [
        { name: "name", type: "string" }, { name: "ticker", type: "string" }, { name: "imageURI", type: "string" },
        { name: "description", type: "string" }, { name: "socialsURI", type: "string" }, { name: "quote", type: "address" },
        { name: "creatorTaxBps", type: "uint256" }, { name: "creatorBuyQuoteIn", type: "uint256" },
        { name: "creatorBuyMinTokensOut", type: "uint256" }, { name: "deadline", type: "uint256" },
      ] },
      { type: "uint8" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes1" }, { type: "uint256" }, { type: "uint8" },
    ],
    [a.p, a.mode, a.stealthOwner, a.buyRecipient, keccak256(a.ephemeralPubKey), a.viewTag, a.minQuoteIn, a.creatorFeeDestination],
  ));
}

/** EIP-712 domain + types the spend signer signs (AnonLaunchPool POOL_LAUNCH_TYPEHASH / PAYOUT_TYPEHASH). */
export const anonPoolDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: "DISCIPLE AnonLaunchPool", version: "1", chainId, verifyingContract }) as const;
export const POOL_LAUNCH_TYPES = {
  PoolLaunch: [
    { name: "launchHash", type: "bytes32" }, { name: "usdgIn", type: "uint256" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
} as const;
export const PAYOUT_TYPES = {
  Payout: [
    { name: "to", type: "address" }, { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
} as const;
