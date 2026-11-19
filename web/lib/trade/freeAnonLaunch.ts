/**
 * Free anon launch request (lib/trade/gaslessAnonLaunchClient sendFreeAnonLaunch → disciple_anonFreeLaunch).
 * maker 2026-11-19: hidden launches are free (no Ticket buy) and their creator fees are burned or locked in the pool, so
 * nothing is paid, refunded or claimed and no wallet of the player's is ever in the launch tx. The relayer calls
 * CreatorFeeHarvest.launchAnon / launchAnonWithMode with buyRecipient = the stealth owner and maxFee = 0.
 * Shape + rules only (no RPC), shared by the relay and the tests.
 */
import { encodeFunctionData, type Address, type Hex } from "viem";
import { creatorFeeHarvestAbi } from "../creatorFeeHarvest";
import { GaslessReject, GASLESS_MAX_DEADLINE_SEC } from "./gaslessPermit2";
import { ANON_LAUNCH_LIMITS, anonLaunchTooLong } from "./gaslessAnonLaunch";

/** What the relayer launches. creatorFeeDestination: 1 locked pool, 2 burn. */
export type FreeAnonLaunch = {
  name: string; ticker: string; imageURI: string; description: string; socialsURI: string;
  quote: Address; creatorTaxBps: bigint; deadline: bigint;
  mode: number; stealthOwner: Address; ephemeralPubKey: Hex; viewTag: Hex;
  /** 1 locked pool, 2 burn. */
  creatorFeeDestination: number;
};

export type FreeAnonLaunchRequest = { wallet: Address; launch: FreeAnonLaunch };

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const isZero = (a: string) => /^0x0{40}$/i.test(a);
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const addr = (v: unknown, what: string): Address => {
  if (typeof v !== "string" || !ADDR.test(v) || isZero(v)) throw new GaslessReject(`bad ${what}`);
  return v as Address;
};
const big = (v: unknown, what: string): bigint => {
  if ((typeof v === "string" && /^[0-9]{1,78}$/.test(v)) || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) return BigInt(v);
  throw new GaslessReject(`bad ${what}`);
};
const hex = (v: unknown, what: string): Hex => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v) || v.length % 2) throw new GaslessReject(`bad ${what}`);
  return v as Hex;
};
const str = (v: unknown, what: string): string => { if (typeof v !== "string") throw new GaslessReject(`bad ${what}`); return v; };
const oneOf = (v: unknown, ok: number[], what: string): number => {
  const n = typeof v === "string" && /^[0-9]$/.test(v) ? Number(v) : v;
  if (typeof n === "number" && ok.includes(n)) return n;
  throw new GaslessReject(`bad ${what}`);
};

export function parseFreeAnonLaunchRequest(x: unknown): FreeAnonLaunchRequest {
  const o = (x ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const l = o.launch ?? {};
  const viewTag = hex(l.viewTag ?? "0x00", "viewTag");
  if (viewTag.length !== 4) throw new GaslessReject("bad viewTag");
  return {
    wallet: addr(o.wallet, "wallet"),
    launch: {
      name: str(l.name, "name"), ticker: str(l.ticker, "ticker"), imageURI: str(l.imageURI, "imageURI"),
      description: str(l.description ?? "", "description"), socialsURI: str(l.socialsURI ?? "", "socialsURI"),
      quote: typeof l.quote === "string" && isZero(l.quote) ? (l.quote as Address) : addr(l.quote, "quote"),
      creatorTaxBps: big(l.creatorTaxBps ?? "0", "creatorTaxBps"), deadline: big(l.deadline, "deadline"),
      mode: oneOf(l.mode ?? 0, [0, 1, 2], "mode"),
      stealthOwner: addr(l.stealthOwner, "stealthOwner"),
      ephemeralPubKey: hex(l.ephemeralPubKey ?? "0x", "ephemeralPubKey"),
      viewTag,
      // keep (0) is refused: a kept fee has to be claimed, and the claim names a wallet
      creatorFeeDestination: oneOf(l.creatorFeeDestination, [1, 2], "creator fee choice (burn or locked pool)"),
    },
  };
}

/** Every rule before any RPC. The player's wallet can never be the stealth owner (it would be on-chain). */
export function checkFreeAnonLaunch(q: FreeAnonLaunchRequest, o: { harvest: Address | null; launcher: Address; anyMode: boolean; nowSec: number }): void {
  const l = q.launch;
  if (!o.harvest) throw new GaslessReject("anon launches aren't switched on here yet");
  const tooLong = anonLaunchTooLong(l);
  if (tooLong) throw new GaslessReject(tooLong);
  if ((l.ephemeralPubKey.length - 2) / 2 > ANON_LAUNCH_LIMITS.ephemeralPubKey) throw new GaslessReject("bad ephemeralPubKey");
  if (!o.anyMode && l.mode) throw new GaslessReject("anon launches are Expert only for now");
  if (eq(l.stealthOwner, q.wallet)) throw new GaslessReject("your wallet can't be the hidden creator");
  if (eq(l.stealthOwner, o.harvest) || eq(l.stealthOwner, o.launcher)) throw new GaslessReject("bad stealthOwner");
  const now = BigInt(o.nowSec);
  if (l.deadline <= now || l.deadline > now + BigInt(GASLESS_MAX_DEADLINE_SEC)) throw new GaslessReject("deadline out of range");
}

/** The relayer's call: no Ticket buy (creatorBuyQuoteIn 0), coins to nobody but the stealth owner, maxFee 0. */
export function encodeFreeAnonLaunch(l: FreeAnonLaunch, anyMode: boolean): Hex {
  const p = {
    name: l.name, ticker: l.ticker, imageURI: l.imageURI, description: l.description, socialsURI: l.socialsURI,
    quote: l.quote, creatorTaxBps: l.creatorTaxBps, creatorBuyQuoteIn: BigInt(0), creatorBuyMinTokensOut: BigInt(0), deadline: l.deadline,
  };
  return anyMode
    ? encodeFunctionData({ abi: creatorFeeHarvestAbi, functionName: "launchAnonWithMode", args: [p, l.mode, l.stealthOwner, l.stealthOwner, l.ephemeralPubKey, l.viewTag, BigInt(0), l.creatorFeeDestination] })
    : encodeFunctionData({ abi: creatorFeeHarvestAbi, functionName: "launchAnon", args: [p, l.stealthOwner, l.stealthOwner, l.ephemeralPubKey, l.viewTag, BigInt(0), l.creatorFeeDestination] });
}
