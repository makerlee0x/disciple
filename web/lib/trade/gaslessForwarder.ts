/**
 * Protocol Permit2 spender for gasless private launch and USDG withdraw.
 * Pattern: UniswapX reactors, 0x Settler meta-transactions, and DiscipleRouter.buyWithPermit2 —
 * this contract is the spender, pulls funds to itself, and the signed witness binds every recipient.
 * It is not deployed on testnet yet; relays refuse rather than fall back to Multicall3.
 */
import type { Address } from "viem";
import { ANON_ADDONS } from "../anon";
import { GaslessReject } from "./gaslessPermit2";

const ZERO = /^0x0{40}$/i;

/** Live GaslessForwarder for `chainId`, or a clear refusal if it has not been deployed yet. */
export function gaslessForwarderAddress(chainId = 46630): Address {
  const a = ANON_ADDONS[chainId]?.gaslessForwarder;
  if (!a || ZERO.test(a)) throw new GaslessReject("this path isn't live on this chain yet");
  return a;
}

export function setGaslessForwarderForTests(chainId: number, address: Address | undefined): void {
  const row = ANON_ADDONS[chainId];
  if (!row) throw new Error(`no ANON_ADDONS for ${chainId}`);
  if (address) row.gaslessForwarder = address;
  else delete row.gaslessForwarder;
}

export const gaslessForwarderAbi = [
  {
    type: "function",
    name: "launchAnon",
    stateMutability: "nonpayable",
    inputs: [
      { name: "signer", type: "address" },
      {
        name: "permit",
        type: "tuple",
        components: [
          { name: "permitted", type: "tuple", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      {
        name: "l",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "ticker", type: "string" },
          { name: "imageURI", type: "string" },
          { name: "description", type: "string" },
          { name: "socialsURI", type: "string" },
          { name: "quote", type: "address" },
          { name: "creatorTaxBps", type: "uint256" },
          { name: "creatorBuyQuoteIn", type: "uint256" },
          { name: "creatorBuyMinTokensOut", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "stealthOwner", type: "address" },
          { name: "buyRecipient", type: "address" },
          { name: "ephemeralPubKey", type: "bytes" },
          { name: "viewTag", type: "bytes1" },
          { name: "maxFee", type: "uint256" },
          { name: "usdgIn", type: "uint256" },
          { name: "minQuoteIn", type: "uint256" },
          { name: "refundTo", type: "address" },
          { name: "launcher", type: "address" },
        ],
      },
      { name: "signature", type: "bytes" },
      {
        name: "approval",
        type: "tuple",
        components: [
          { name: "value", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
    ],
    outputs: [
      { name: "r", type: "tuple", components: [{ name: "token", type: "address" }, { name: "curve", type: "address" }, { name: "creatorTokensBought", type: "uint256" }] },
      { name: "refund", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "signer", type: "address" },
      {
        name: "permit",
        type: "tuple",
        components: [
          { name: "permitted", type: "tuple", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      {
        name: "w",
        type: "tuple",
        components: [
          { name: "to", type: "address" },
          { name: "fee", type: "uint256" },
          { name: "feeTo", type: "address" },
        ],
      },
      { name: "signature", type: "bytes" },
      {
        name: "approval",
        type: "tuple",
        components: [
          { name: "value", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

export const ZERO_ERC2612 = {
  value: BigInt(0),
  deadline: BigInt(0),
  v: 0,
  r: `0x${"00".repeat(32)}` as `0x${string}`,
  s: `0x${"00".repeat(32)}` as `0x${string}`,
};
