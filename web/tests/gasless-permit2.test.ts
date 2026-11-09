/** flow/gasless-permit2: witness / signature binding, request rules ($3, signer == recipient, deadlines), nonces. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decodeFunctionData, hashTypedData, keccak256, recoverTypedDataAddress, toBytes, encodeAbiParameters, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { checkGaslessRequest, encodeGaslessCall, gaslessRouterAbi, GaslessReject, lowestFreeBit, MIN_TRADE_USD, minTradeRaw, NonceBook, parseGaslessRequest, PERMIT2, TRADE_TYPEHASH, TRADE_WITNESS_TYPE, tradeTypedData, tradeWitnessHash, type GaslessRequest } from "../lib/trade/gaslessPermit2";
import { MIN_TRADE_USD as CONFIG_MIN, minShotUsd } from "../lib/config";

const usdg = "0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D" as Address, coin = "0xab9e86498c9b32743e31b0fca02d6b254bcddd4e" as Address;
const router = "0x00000000000000000000000000000000000000bb" as Address, NOW = 1_000_000;
const user = privateKeyToAccount(generatePrivateKey());
async function req(o: Partial<{ isBuy: boolean; amountIn: bigint; recipient: Address; nonce: bigint; deadline: bigint; token: Address; permitAmount: bigint }> = {}): Promise<GaslessRequest> {
  const isBuy = o.isBuy ?? true, amountIn = o.amountIn ?? 3_000_000n, deadline = o.deadline ?? BigInt(NOW + 120);
  const trade = { coin, isBuy, amountIn, minOut: 1n, recipient: o.recipient ?? user.address, deadline };
  const permit = { permitted: { token: o.token ?? (isBuy ? usdg : coin), amount: o.permitAmount ?? amountIn }, nonce: o.nonce ?? 0n, deadline };
  return { signer: user.address, permit, trade, signature: await user.signTypedData(tradeTypedData(46630, router, permit, trade)) };
}
const chk = (q: GaslessRequest) => checkGaslessRequest(q, { usdg, usdgDecimals: 6, nowSec: NOW });

describe("Permit2 witness (0x Gasless pattern)", () => {
  it("type strings match DiscipleRouter.sol (TokenPermissions sorts before Trade)", () => {
    expect(TRADE_WITNESS_TYPE).toBe("Trade witness)TokenPermissions(address token,uint256 amount)Trade(address coin,bool isBuy,uint256 amountIn,uint256 minOut,address recipient,uint256 deadline)");
    const sol = readFileSync(new URL("../../contracts/src/DiscipleRouter.sol", import.meta.url), "utf8");
    expect(sol).toContain('"Trade witness)TokenPermissions(address token,uint256 amount)"');
    expect(sol).toContain('"Trade(address coin,bool isBuy,uint256 amountIn,uint256 minOut,address recipient,uint256 deadline)"');
    expect(sol).toContain("0x000000000022D473030F116dDEE9F6B43aC78BA3");
  });
  it("viem's EIP-712 digest == Permit2's PermitWitnessTransferFrom digest with our witness hash", async () => {
    const q = await req();
    const td = tradeTypedData(46630, router, q.permit, q.trade);
    // Permit2 SignatureTransfer._hashWithWitness, rebuilt by hand
    const stub = "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";
    const typeHash = keccak256(toBytes(stub + TRADE_WITNESS_TYPE));
    const tokenPerm = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "uint256" }], [keccak256(toBytes("TokenPermissions(address token,uint256 amount)")), q.permit.permitted.token, q.permit.permitted.amount]));
    const structHash = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }], [typeHash, tokenPerm, router, q.permit.nonce, q.permit.deadline, tradeWitnessHash(q.trade)]));
    const domainSep = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }], [keccak256(toBytes("EIP712Domain(string name,uint256 chainId,address verifyingContract)")), keccak256(toBytes("Permit2")), 46630n, PERMIT2]));
    expect(hashTypedData(td)).toBe(keccak256(`0x1901${domainSep.slice(2)}${structHash.slice(2)}`));
    expect(TRADE_TYPEHASH).toBe(keccak256(toBytes("Trade(address coin,bool isBuy,uint256 amountIn,uint256 minOut,address recipient,uint256 deadline)")));
  });
  it("binds every field: a relayer-changed minOut / recipient / amount / spender no longer recovers the signer", async () => {
    const q = await req();
    const rec = (t: GaslessRequest["trade"], p = q.permit, spender = router) => recoverTypedDataAddress({ ...tradeTypedData(46630, spender, p, t), signature: q.signature });
    expect(await rec(q.trade)).toBe(user.address);
    expect(await rec({ ...q.trade, minOut: 0n })).not.toBe(user.address);
    expect(await rec({ ...q.trade, recipient: router })).not.toBe(user.address);
    expect(await rec({ ...q.trade, amountIn: 1n })).not.toBe(user.address);
    expect(await rec(q.trade, { ...q.permit, nonce: 1n })).not.toBe(user.address);
    expect(await rec(q.trade, q.permit, "0x00000000000000000000000000000000000000cc")).not.toBe(user.address);
  });
});

describe("request rules (before any RPC)", () => {
  it("signer == trader == recipient", async () => {
    const q = await req({ recipient: router });
    expect(() => chk(q)).toThrow("recipient must be the signer");
  });
  it("permit token / amount must match the trade", async () => {
    await expect(req({ token: coin }).then(chk)).rejects.toThrow("permit token mismatch");
    await expect(req({ isBuy: false, token: usdg }).then(chk)).rejects.toThrow("permit token mismatch");
    await expect(req({ permitAmount: 1n }).then(chk)).rejects.toThrow("permit amount mismatch");
  });
  it("deadline: expired or more than 5 min ahead is refused (replay window)", async () => {
    await expect(req({ deadline: BigInt(NOW) }).then(chk)).rejects.toThrow("deadline");
    await expect(req({ deadline: BigInt(NOW + 301) }).then(chk)).rejects.toThrow("deadline");
    await expect(req({ deadline: BigInt(NOW + 300) }).then(chk)).resolves.toBeUndefined();
  });
  it("$3 minimum on buys (lee), sells never size-filtered", async () => {
    expect(minTradeRaw(6)).toBe(3_000_000n);
    await expect(req({ amountIn: 2_999_999n }).then(chk)).rejects.toThrow("minimum trade is $3");
    await expect(req({ amountIn: 3_000_000n }).then(chk)).resolves.toBeUndefined();
    await expect(req({ isBuy: false, amountIn: 1n }).then(chk)).resolves.toBeUndefined();
  });
  it("$3 is the same number in config, engine and the gasless rules (was $0.20)", () => {
    expect(MIN_TRADE_USD).toBe(3); expect(CONFIG_MIN).toBe(3); expect(minShotUsd()).toBeGreaterThanOrEqual(3);
    const engine = readFileSync(new URL("../public/flight/engine.js", import.meta.url), "utf8");
    expect(engine).toMatch(/^const MIN_SHOT=3;/m);
  });
  it("parse: JSON bigints round-trip; junk is rejected as GaslessReject (notSent)", async () => {
    const q = await req();
    const wire = JSON.parse(JSON.stringify(q, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    expect(parseGaslessRequest(wire)).toEqual(q);
    for (const bad of [{ ...wire, signer: "0x0" }, { ...wire, signature: "0x12" }, { ...wire, trade: { ...wire.trade, isBuy: "yes" } }, { ...wire, permit: { ...wire.permit, nonce: "-1" } }]) {
      try { parseGaslessRequest(bad); throw new Error("accepted"); } catch (e) { expect(e).toBeInstanceOf(GaslessReject); expect((e as GaslessReject).notSent).toBe(true); }
    }
  });
  it("encodes the router call (approve variant only when an EIP-2612 approval rides along)", async () => {
    const q = await req();
    expect(decodeFunctionData({ abi: gaslessRouterAbi, data: encodeGaslessCall(q) }).functionName).toBe("buyWithPermit2");
    const a = { value: 2n ** 256n - 1n, deadline: BigInt(NOW + 100), v: 27, r: `0x${"11".repeat(32)}` as const, s: `0x${"22".repeat(32)}` as const };
    expect(decodeFunctionData({ abi: gaslessRouterAbi, data: encodeGaslessCall({ ...q, approval: a }) }).functionName).toBe("buyWithPermit2AndApprove");
    const s = await req({ isBuy: false });
    expect(decodeFunctionData({ abi: gaslessRouterAbi, data: encodeGaslessCall(s) }).functionName).toBe("sellWithPermit2");
  });
});

describe("Permit2 unordered nonces", () => {
  it("lowest free bit, skipping on-chain used and locally taken bits", () => {
    expect(lowestFreeBit(0n)).toBe(0); expect(lowestFreeBit(0b1011n)).toBe(2); expect(lowestFreeBit(0b11n, 0b100n)).toBe(3);
    expect(lowestFreeBit(2n ** 256n - 1n)).toBe(-1);
  });
  it("rapid taps never share a nonce; a full word rolls to the next", async () => {
    const reads: bigint[] = [];
    const book = new NonceBook(async (_o, w) => { reads.push(w); return w === 0n ? (2n ** 256n - 1n) ^ (1n << 255n) ^ (1n << 254n) : 0n; });
    const ns = await Promise.all([book.next(user.address), book.next(user.address), book.next(user.address)]);
    expect(ns).toEqual([254n, 255n, 256n]);
    expect(new Set(ns).size).toBe(3);
    expect(reads).toEqual([0n, 1n]);
  });
});
