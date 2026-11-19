/** Anon launch pool (maker 2026-11-19): the launch hash / EIP-712 the site signs match AnonLaunchPool.sol, the relay rules
 *  keep the player's wallet out of the launch, and the ledger never double-spends or double-credits. */
import { describe, expect, it } from "vitest";
import { hashTypedData, type Address } from "viem";
import { anonPoolDomain, poolLaunchHash, POOL_LAUNCH_TYPES, PAYOUT_TYPES, type PoolLaunchArgs } from "../lib/anonPool";
import { checkAnonPoolLaunch, parseAnonPoolLaunchRequest } from "../lib/server/anonPoolRelay";
import { AnonPoolLedger } from "../lib/server/anonPoolLedger";
import { kv, resetKvForTests } from "../lib/server/kv";
import { GaslessReject } from "../lib/trade/gaslessPermit2";

/** Same fixed args as contracts/test/AnonLaunchPool.t.sol test_vector_matchesSite. */
const VEC: PoolLaunchArgs = {
  p: {
    name: "Anon", ticker: "ANON", imageURI: "ipfs://x", description: "d", socialsURI: "s",
    quote: "0x1111111111111111111111111111111111111111", creatorTaxBps: 100n, creatorBuyQuoteIn: 0n,
    creatorBuyMinTokensOut: 5n, deadline: 1_000_000n,
  },
  mode: 1, stealthOwner: "0x2222222222222222222222222222222222222222", buyRecipient: "0x3333333333333333333333333333333333333333",
  ephemeralPubKey: "0x02aa", viewTag: "0x11", minQuoteIn: 7n, creatorFeeDestination: 2,
};
const POOL = "0x4444444444444444444444444444444444444444" as Address;

describe("anon pool hashes match the contract", () => {
  it("launchHash + PoolLaunch + Payout digests", () => {
    const lh = poolLaunchHash(VEC);
    const d = hashTypedData({ domain: anonPoolDomain(4663, POOL), types: POOL_LAUNCH_TYPES, primaryType: "PoolLaunch", message: { launchHash: lh, usdgIn: 10n, nonce: 9n, deadline: 99n } });
    const p = hashTypedData({ domain: anonPoolDomain(4663, POOL), types: PAYOUT_TYPES, primaryType: "Payout", message: { to: VEC.buyRecipient, amount: 10n, nonce: 9n, deadline: 99n } });
    // pinned in contracts/test/AnonLaunchPool.t.sol test_vector_matchesSite
    expect(lh).toBe("0x5c3176a1c2e679876562e34d6563021d47babd48ba75cae994a85bc3a27af651");
    expect(d).toBe("0x630029e57489cadfab66cd4e87c0bf481c2c0de2963344b94ff3222e1e22f818");
    expect(p).toBe("0x303235c33178b4a5874ad72e0f485ba768ef16f7cb94092484a2263ee927f41e");
  });
});

const WALLET = "0x5555555555555555555555555555555555555555" as Address;
const LAUNCHER = "0x6666666666666666666666666666666666666666" as Address;
const NOW = 1_000_000;
const req = (over: Partial<PoolLaunchArgs> = {}) => parseAnonPoolLaunchRequest(JSON.parse(JSON.stringify({
  wallet: WALLET, usdgIn: "10000000",
  launch: { ...VEC, mode: 0, creatorFeeDestination: 0, ...over, p: { ...VEC.p, deadline: NOW + 200 } },
}, (_k, v) => (typeof v === "bigint" ? v.toString() : v))));
const rules = { pool: POOL, launcher: LAUNCHER, harvest: null, nowSec: NOW };

describe("anon pool launch rules", () => {
  it("accepts a clean launch", () => {
    expect(() => checkAnonPoolLaunch(req(), rules)).not.toThrow();
  });
  it("never lets the player's wallet into the launch", () => {
    expect(() => checkAnonPoolLaunch(req({ buyRecipient: WALLET }), rules)).toThrow(GaslessReject);
    expect(() => checkAnonPoolLaunch(req({ stealthOwner: WALLET }), rules)).toThrow(GaslessReject);
  });
  it("coins can't go to the pool or launcher", () => {
    expect(() => checkAnonPoolLaunch(req({ buyRecipient: POOL }), rules)).toThrow(GaslessReject);
    expect(() => checkAnonPoolLaunch(req({ buyRecipient: LAUNCHER }), rules)).toThrow(GaslessReject);
  });
  it("pool / burn fee routing needs the harvest", () => {
    expect(() => checkAnonPoolLaunch(req({ creatorFeeDestination: 1 }), rules)).toThrow(/fee routing/);
  });
  it("deadline must be live and short", () => {
    expect(() => checkAnonPoolLaunch(req(), { ...rules, nowSec: NOW + 500 })).toThrow(/deadline/);
  });
  it("bad shapes are refused", () => {
    expect(() => parseAnonPoolLaunchRequest({ wallet: WALLET, launch: { ...VEC, mode: 3 } })).toThrow(GaslessReject);
    expect(() => parseAnonPoolLaunchRequest({ wallet: "0x0", launch: VEC })).toThrow(GaslessReject);
  });
});

describe("anon balance ledger", () => {
  it("credits, debits, refuses overspend and credits a deposit log once", async () => {
    resetKvForTests();
    const L = new AnonPoolLedger(46630, kv);
    const did = `did:privy:test-${Date.now()}`;
    expect(await L.balance(did)).toBe(0n);
    expect(await L.creditDepositOnce(did, "0xabc:1", 50n)).toBe(true);
    expect(await L.creditDepositOnce(did, "0xABC:1", 50n)).toBe(false);
    expect(await L.balance(did)).toBe(50n);
    await expect(L.debit(did, 60n)).rejects.toThrow(/not enough/);
    expect(await L.debit(did, 20n)).toBe(30n);
    expect(await L.credit(did, 5n)).toBe(35n);
    expect(await L.debit(did, 0n)).toBe(35n);
  });
});
