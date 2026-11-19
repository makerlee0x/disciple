/** maker 2026-11-19: hidden launches are free and anon. No Ticket buy, fees burned or locked, and the relayer's launch call
 *  holds no wallet of the player's (no payment, no refund, coins only to the stealth owner). */
import { describe, expect, it } from "vitest";
import { decodeFunctionData, type Address } from "viem";
import { creatorFeeHarvestAbi } from "../lib/creatorFeeHarvest";
import { checkFreeAnonLaunch, encodeFreeAnonLaunch, parseFreeAnonLaunchRequest } from "../lib/trade/freeAnonLaunch";
import { GaslessReject } from "../lib/trade/gaslessPermit2";

const WALLET = "0x5555555555555555555555555555555555555555" as Address;
const STEALTH = "0x2222222222222222222222222222222222222222" as Address;
const HARVEST = "0x4e94a3e9900b435b7c91d0a7cd53a22c8a9f8a03" as Address;
const LAUNCHER = "0x526784706e5ef369412abe65213ed65256182c6b" as Address;
const NOW = 1_000_000;
const raw = (over: Record<string, unknown> = {}) => ({
  wallet: WALLET,
  launch: {
    name: "Anon", ticker: "ANON", imageURI: "ipfs://x", description: "", socialsURI: "",
    quote: "0x1111111111111111111111111111111111111111", creatorTaxBps: "0", deadline: String(NOW + 200),
    mode: 0, stealthOwner: STEALTH, ephemeralPubKey: "0x02aa", viewTag: "0x11", creatorFeeDestination: 2, ...over,
  },
});
const rules = { harvest: HARVEST, launcher: LAUNCHER, anyMode: false, nowSec: NOW };

describe("free anon launch", () => {
  it("encodes a launch with no buy, coins to the stealth owner and no player wallet", () => {
    const q = parseFreeAnonLaunchRequest(raw());
    checkFreeAnonLaunch(q, rules);
    for (const anyMode of [false, true]) {
      const data = encodeFreeAnonLaunch(q.launch, anyMode);
      expect(data.toLowerCase()).not.toContain(WALLET.slice(2).toLowerCase());
      const { functionName, args } = decodeFunctionData({ abi: creatorFeeHarvestAbi, data });
      expect(functionName).toBe(anyMode ? "launchAnonWithMode" : "launchAnon");
      const a = args as readonly unknown[];
      const p = a[0] as { creatorBuyQuoteIn: bigint; creatorBuyMinTokensOut: bigint };
      expect(p.creatorBuyQuoteIn).toBe(0n);
      expect(p.creatorBuyMinTokensOut).toBe(0n);
      const o = anyMode ? 1 : 0;
      expect(a[1 + o]).toBe(STEALTH); // stealth owner
      expect(a[2 + o]).toBe(STEALTH); // coins go to the stealth owner, never the wallet
      expect(a[5 + o]).toBe(0n); // maxFee
      expect(a[6 + o]).toBe(2); // burn
    }
  });
  it("refuses keep (a kept fee has to be claimed to a wallet)", () => {
    expect(() => parseFreeAnonLaunchRequest(raw({ creatorFeeDestination: 0 }))).toThrow(GaslessReject);
    expect(parseFreeAnonLaunchRequest(raw({ creatorFeeDestination: 1 })).launch.creatorFeeDestination).toBe(1);
  });
  it("the wallet can't be the hidden creator", () => {
    expect(() => checkFreeAnonLaunch(parseFreeAnonLaunchRequest(raw({ stealthOwner: WALLET })), rules)).toThrow(/wallet/);
  });
  it("needs the harvest, Expert-only until modes are live, live deadline", () => {
    const q = parseFreeAnonLaunchRequest(raw({ mode: 1 }));
    expect(() => checkFreeAnonLaunch(q, rules)).toThrow(/Expert/);
    expect(() => checkFreeAnonLaunch(q, { ...rules, anyMode: true })).not.toThrow();
    expect(() => checkFreeAnonLaunch(parseFreeAnonLaunchRequest(raw()), { ...rules, harvest: null })).toThrow(/switched on/);
    expect(() => checkFreeAnonLaunch(parseFreeAnonLaunchRequest(raw()), { ...rules, nowSec: NOW + 500 })).toThrow(/deadline/);
  });
});
