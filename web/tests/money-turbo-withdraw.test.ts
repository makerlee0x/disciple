/**
 * Money flow: Turbo cash -> Cash (lib/server/lighter/withdraw). Who signs: Disciple's trading key signs the transfer to
 * Lighter's fast-withdraw pool, then the player's own wallet signs Lighter's L1 message. Who pays: Lighter's transfer
 * fee comes on top of the amount; no gas. Where it goes: Lighter main pays USDC on Arbitrum into a Relay address that
 * turns it into USDG in the player's Cash. Lighter's REST, the WASM signer and KV are stubbed; the signature check is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

const h = vi.hoisted(() => ({
  player: null as null | Record<string, unknown>,
  puts: [] as Record<string, unknown>[],
  free: "50",
  info: { to_account_index: 9, max_withdrawal_amount: "1000", withdraw_limit: "1000" } as Record<string, unknown>,
  fee: 100_000, // 0.10 USDC (Lighter units are micro-USD)
  sent: [] as { txInfo: string; to: string }[],
  signed: [] as unknown[][],
  relay: vi.fn(async () => ({ address: "0x3333333333333333333333333333333333333333", outUsd: 9.99, feeUsd: 0.01 })),
}));

vi.mock("../lib/server/lighter/keys", () => ({
  getPlayer: async () => (h.player ? structuredClone(h.player) : null),
  putPlayer: async (_c: unknown, _p: string, p: Record<string, unknown>) => { h.puts.push(p); h.player = structuredClone(p); },
  open: () => "0xkey",
}));
vi.mock("../lib/server/lighter/rest", async (orig) => ({
  ...(await orig<typeof import("../lib/server/lighter/rest")>()),
  account: async () => ({ available_balance: h.free }),
  fastWithdrawInfo: async () => h.info,
  transferFee: async () => h.fee,
  assetDetails: async () => [{ symbol: "ETH", asset_id: 1, decimals: 18 }, { symbol: "USDC", asset_id: 3, decimals: 6 }],
  nextNonce: async () => 41,
  fastWithdraw: async (_c: unknown, txInfo: string, to: string) => { h.sent.push({ txInfo, to }); return { ok: true }; },
}));
vi.mock("../lib/server/lighter/signer", () => ({
  signerFor: async () => ({
    CreateAuthToken: () => ({ authToken: "tok" }),
    SignTransfer: (...a: unknown[]) => { h.signed.push(a); return { txType: 12, txInfo: JSON.stringify({ Amount: a[4], Memo: a[6] }), messageToSign: `Transfer ${a[4]} to pool, nonce ${a[8]}` }; },
  }),
  checked: (r: unknown) => r,
}));
vi.mock("../lib/server/lighter/bridge", () => ({ relayCashAddress: h.relay }));

import { finishWithdraw, startWithdraw, withdrawable, withdrawMemo, WITHDRAW_MIN_USDC } from "../lib/server/lighter/withdraw";
import type { LighterConfig } from "../lib/server/lighter/config";

const me = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const other = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const PID = me.address.toLowerCase();
const main = { network: "mainnet", payoutIsCash: false, collateral: "USDC", chainId: 304, keySecret: "s" } as unknown as LighterConfig;
const rh = { network: "rh-mainnet", payoutIsCash: true, collateral: "USDG", chainId: 466324, keySecret: "s" } as unknown as LighterConfig;
const testnet = { network: "testnet", payoutIsCash: false, collateral: "USDC", chainId: 300, keySecret: "s" } as unknown as LighterConfig;

beforeEach(() => {
  h.player = { keyReady: true, enc: "x", keyIndex: 7, account: 1234 };
  h.puts = []; h.sent = []; h.signed = []; h.free = "50"; h.fee = 100_000;
  h.info = { to_account_index: 9, max_withdrawal_amount: "1000", withdraw_limit: "1000" };
  h.relay.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("withdrawable: what Turbo cash can go back now", () => {
  it("free collateral minus Lighter's transfer fee", async () => {
    expect(await withdrawable(main, PID)).toEqual({ usd: 49.9, fee: 0.1, min: WITHDRAW_MIN_USDC });
  });
  it("capped by the fast-withdraw pool's limit", async () => {
    h.info = { to_account_index: 9, max_withdrawal_amount: "20", withdraw_limit: "30" };
    expect((await withdrawable(main, PID)).usd).toBe(20);
  });
  it("never negative when the fee is more than what's free", async () => {
    h.free = "0.05";
    expect((await withdrawable(main, PID)).usd).toBe(0);
  });
  it("Lighter on Robinhood Chain has a $1 floor; Lighter testnet is closed", async () => {
    expect((await withdrawable(rh, PID)).min).toBe(1);
    await expect(withdrawable(testnet, PID)).rejects.toMatchObject({ status: 409 });
  });
  it("needs a finished Lighter set-up", async () => {
    h.player = { keyReady: false };
    await expect(withdrawable(main, PID)).rejects.toMatchObject({ status: 409, message: "Finish Lighter set-up first." });
  });
});

describe("startWithdraw: refusals before anything is signed", () => {
  it("under the $4 USDC fast-withdraw minimum", async () => {
    await expect(startWithdraw(main, PID, 3.99, PID)).rejects.toMatchObject({ status: 400, message: "Move at least $4." });
    expect(h.signed).toHaveLength(0);
  });
  it("raw (the payout-chain test) only ever pays the player's own wallet", async () => {
    await expect(startWithdraw(main, PID, 10, other.address, true)).rejects.toMatchObject({ status: 400, message: "Bad address." });
    expect(h.signed).toHaveLength(0);
  });
  it("more than free collateral after the fee says how much can move", async () => {
    await expect(startWithdraw(main, PID, 49.95, PID)).rejects.toMatchObject({ status: 400, message: "You can move up to $49.90 right now." });
    expect(h.signed).toHaveLength(0);
  });
  it("more than the pool pays out now", async () => {
    h.info = { to_account_index: 9, max_withdrawal_amount: "25" };
    await expect(startWithdraw(main, PID, 30, PID)).rejects.toMatchObject({ status: 400, message: "You can move up to $25.00 right now." });
  });
  it("when Relay's way back is closed, nothing is signed", async () => {
    h.relay.mockRejectedValueOnce(Object.assign(new Error("Moving Turbo cash back isn't open yet."), { status: 409 }));
    await expect(startWithdraw(main, PID, 10, PID)).rejects.toMatchObject({ status: 409 });
    expect(h.signed).toHaveLength(0);
    expect(h.puts).toHaveLength(0);
  });
});

describe("startWithdraw -> finishWithdraw", () => {
  it("Lighter main: pays Relay's address (not the `to` the browser sent), USDC at 6 decimals, fee on top", async () => {
    const r = await startWithdraw(main, PID, 10, "0x000000000000000000000000000000000000dEaD");
    expect(h.relay).toHaveBeenCalledWith(PID, 10);
    expect(r).toEqual({ message: expect.stringContaining("Transfer 10000000"), usd: 10, fee: 0.1 });
    const [toAcct, asset, , , amount, fee, memo, , nonce, keyIndex, acct] = h.signed[0];
    expect({ toAcct, asset, amount, fee, nonce, keyIndex, acct }).toEqual({ toAcct: 9, asset: 3, amount: 10_000_000, fee: 100_000, nonce: 41, keyIndex: 7, acct: 1234 });
    expect(memo).toBe(withdrawMemo("0x3333333333333333333333333333333333333333"));
    expect((h.player!.pending as { to: string }).to).toBe("0x3333333333333333333333333333333333333333");

    const sig = await me.signMessage({ message: r.message });
    expect(await finishWithdraw(main, PID, sig)).toEqual({ usd: 10, to: "0x3333333333333333333333333333333333333333" });
    expect(h.sent).toHaveLength(1);
    expect(JSON.parse(h.sent[0].txInfo)).toMatchObject({ Amount: 10_000_000, L1Sig: sig });
    expect(h.player!.pending).toBeUndefined();
  });

  it("Lighter on Robinhood Chain pays the cash address straight, no Relay", async () => {
    h.player = { keyReady: true, enc: "x", keyIndex: 7, account: 1234 };
    const r = await startWithdraw({ ...rh, collateral: "USDC" } as LighterConfig, PID, 2, PID);
    expect(h.relay).not.toHaveBeenCalled();
    expect(h.signed[0][6]).toBe(withdrawMemo(PID));
    expect(r.usd).toBe(2);
  });

  it("a signature from another wallet is refused and nothing is sent", async () => {
    const r = await startWithdraw(main, PID, 10, PID);
    const sig = await other.signMessage({ message: r.message });
    await expect(finishWithdraw(main, PID, sig)).rejects.toMatchObject({ status: 403 });
    expect(h.sent).toHaveLength(0);
  });

  it("one send per request: a second finish with the same signature is refused", async () => {
    const r = await startWithdraw(main, PID, 10, PID);
    const sig = await me.signMessage({ message: r.message });
    await finishWithdraw(main, PID, sig);
    await expect(finishWithdraw(main, PID, sig)).rejects.toMatchObject({ status: 409, message: "That request expired. Start again." });
    expect(h.sent).toHaveLength(1);
  });

  it("a request older than 10 minutes expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const r = await startWithdraw(main, PID, 10, PID);
    const sig = await me.signMessage({ message: r.message });
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    await expect(finishWithdraw(main, PID, sig)).rejects.toMatchObject({ status: 409 });
    expect(h.sent).toHaveLength(0);
  });
});
