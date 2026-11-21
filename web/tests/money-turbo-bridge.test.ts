/**
 * Money flow: Cash -> Turbo cash (lib/server/lighter/bridge). Who signs: nobody new (the gasless cash-out sends USDG to the
 * address this returns). Who pays: Relay's solver; its fee comes out of the amount. This pins where the money is sent
 * on each Lighter network and the $6 minimum (maker 2026-11-20), with Relay and Lighter answered by a stub fetch.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

const W = "0x929d22560c48d3240a7e35559810d58f3d2692ad";
const INTENT = "0x1111111111111111111111111111111111111111";
const RELAY_DEP = "0x2222222222222222222222222222222222222222";

type Call = { url: string; body: string };
let calls: Call[] = [];
let answer: (url: string, body: string) => { status?: number; json: unknown };
function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    calls.push({ url, body });
    const a = answer(url, body);
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }));
}
const relayOk = (outMicro: string, fee = "0.04", eta = 2) => ({ json: { steps: [{ id: "deposit", depositAddress: RELAY_DEP }], details: { currencyOut: { amount: outMicro }, timeEstimate: eta }, fees: { relayer: { amountUsd: fee } } } });

let bridge: typeof import("@/lib/server/lighter/bridge");
let cfgMod: typeof import("@/lib/server/lighter/config");
let kvMod: typeof import("@/lib/server/kv");
const env = { ...process.env };

beforeAll(async () => {
  process.env.KV_LOCAL_FILE = join(tmpdir(), `turbo-bridge-${Date.now()}-${Math.random()}.json`);
  bridge = await import("@/lib/server/lighter/bridge");
  cfgMod = await import("@/lib/server/lighter/config");
  kvMod = await import("@/lib/server/kv");
});
beforeEach(() => { calls = []; stubFetch(); });
afterEach(() => { vi.unstubAllGlobals(); for (const k of ["LIGHTER_NETWORK", "LIGHTER_PAYOUT_CHAIN"]) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } });
const net = (n: string) => { process.env.LIGHTER_NETWORK = n; return cfgMod.lighterConfig(); };

describe("minimums and the chain the deposit comes from", () => {
  it("Lighter main and testnet: one $6 minimum (TURBO_MIN_IN); Lighter on Robinhood Chain: 1 USDG", async () => {
    const { TURBO_MIN_IN } = await import("@/lib/lighter/mins");
    expect(TURBO_MIN_IN).toBe(6);
    expect(bridge.depositMins(net("mainnet"))).toEqual({ minNew: 6, min: 6 });
    expect(bridge.depositMins(net("testnet"))).toEqual({ minNew: 6, min: 6 });
    expect(bridge.depositMins(net("rh-mainnet"))).toEqual({ minNew: 1, min: 1 });
  });
  it("cash only leaves from Robinhood Chain mainnet on a real venue; a testnet Lighter has no deposit chain", () => {
    expect(bridge.depositChain(net("mainnet"))).toBe(4663);
    expect(bridge.depositChain(net("rh-mainnet"))).toBe(4663);
    expect(bridge.depositChain(net("rh-testnet"))).toBe(46630);
    expect(bridge.depositChain(net("testnet"))).toBeNull();
  });
});

describe("parseRelayDeposit", () => {
  it("keeps Relay's time estimate only when it is a sane number of seconds", () => {
    const base = { steps: [{ id: "deposit", depositAddress: RELAY_DEP }], details: { currencyOut: { amount: "9960000" } } };
    expect(bridge.parseRelayDeposit({ ...base, details: { ...base.details, timeEstimate: 1.6 } }).etaSec).toBe(2);
    expect(bridge.parseRelayDeposit({ ...base, details: { ...base.details, timeEstimate: 7200 } }).etaSec).toBeUndefined();
    expect(bridge.parseRelayDeposit(base).feeUsd).toBeNull();
  });
  it("refuses a non-deposit step, a bad address and a zero output", () => {
    expect(() => bridge.parseRelayDeposit({ steps: [{ id: "swap", depositAddress: RELAY_DEP }], details: { currencyOut: { amount: "1" } } })).toThrow();
    expect(() => bridge.parseRelayDeposit({ steps: [{ id: "deposit", depositAddress: "0x12" }], details: { currencyOut: { amount: "1" } } })).toThrow();
    expect(() => bridge.parseRelayDeposit({ steps: [{ id: "deposit", depositAddress: RELAY_DEP }], details: { currencyOut: { amount: "0" } } })).toThrow();
  });
});

describe("depositAddress on Lighter main: Relay USDG (Robinhood Chain) -> USDC (Arbitrum) -> the wallet's Lighter intent address", () => {
  beforeEach(() => {
    answer = (url) => url.includes("createIntentAddress") ? { json: { code: 200, intent_address: INTENT } } : relayOk("9960000");
  });

  it("needs an amount before it asks anyone", async () => {
    net("mainnet");
    await expect(bridge.depositAddress(W)).rejects.toMatchObject({ status: 400, message: "Pick an amount." });
    expect(calls).toHaveLength(0);
  });

  it("quotes exactly the amount, from our USDG to Arbitrum USDC, paid to the intent address, refunds to the player", async () => {
    net("mainnet");
    const d = await bridge.depositAddress(W, 10);
    expect(d).toMatchObject({ address: RELAY_DEP, outUsd: 9.96, feeUsd: 0.04, etaSec: 2 });
    const intent = calls.find((c) => c.url.includes("createIntentAddress"))!;
    expect(new URLSearchParams(intent.body).get("chain_id")).toBe(String(bridge.ARBITRUM_ID));
    expect(new URLSearchParams(intent.body).get("from_addr")).toBe(W);
    const q = JSON.parse(calls.find((c) => c.url.endsWith("/quote"))!.body);
    expect(q).toMatchObject({
      user: W, recipient: INTENT, refundTo: W, useDepositAddress: true, tradeType: "EXACT_INPUT",
      originChainId: 4663, originCurrency: bridge.RH_USDG, destinationChainId: 42161, destinationCurrency: bridge.ARBITRUM_USDC, amount: "10000000",
    });
  });

  it("the intent address is asked for once per wallet, then read from KV", async () => {
    net("mainnet");
    const w2 = "0x" + "ab".repeat(20);
    await bridge.depositAddress(w2, 10);
    await bridge.depositAddress(w2, 12);
    expect(calls.filter((c) => c.url.includes("createIntentAddress"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith("/quote"))).toHaveLength(2);
  });

  it("refuses when less than Lighter's 5 USDC would land (its intent minimum), in plain words", async () => {
    net("mainnet");
    answer = (url) => url.includes("createIntentAddress") ? { json: { code: 200, intent_address: INTENT } } : relayOk("4990000");
    await expect(bridge.depositAddress(W, 5.2)).rejects.toMatchObject({ status: 400, message: "Add at least $6.00." });
  });

  it("a Relay error is a 502 with Relay's own message, never a deposit address", async () => {
    net("mainnet");
    answer = (url) => url.includes("createIntentAddress") ? { json: { code: 200, intent_address: INTENT } } : { status: 400, json: { message: "Amount too low" } };
    await expect(bridge.depositAddress(W, 6)).rejects.toMatchObject({ status: 502, message: "Amount too low" });
  });

  it("a bad intent address from Lighter is refused, not cached", async () => {
    net("mainnet");
    const w3 = "0x" + "cd".repeat(20);
    answer = (url) => url.includes("createIntentAddress") ? { json: { code: 200, intent_address: "0xnope" } } : relayOk("9960000");
    await expect(bridge.depositAddress(w3, 10)).rejects.toMatchObject({ status: 502 });
    expect(await kvMod.kv().get(`lighter:mainnet:intent:${w3}:42161`)).toBeNull();
  });
});

describe("depositAddress elsewhere", () => {
  it("Lighter on Robinhood Chain: the intent address on our chain, no Relay", async () => {
    answer = () => ({ json: { code: 200, intent_address: INTENT } });
    net("rh-mainnet");
    const d = await bridge.depositAddress("0x" + "ef".repeat(20));
    expect(d.address).toBe(INTENT);
    expect(calls.some((c) => c.url.endsWith("/quote"))).toBe(false);
    expect(new URLSearchParams(calls[0].body).get("chain_id")).toBe("4663");
  });
  it("Lighter testnet refuses Add cash (its faucet funds test accounts)", async () => {
    answer = () => ({ json: {} });
    net("testnet");
    await expect(bridge.depositAddress(W, 10)).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(0);
  });
});

describe("relayCashAddress: Turbo cash back to Cash", () => {
  it("stays closed until LIGHTER_PAYOUT_CHAIN=42161 says where Lighter pays", async () => {
    delete process.env.LIGHTER_PAYOUT_CHAIN;
    answer = () => relayOk("9990000");
    await expect(bridge.relayCashAddress(W, 10)).rejects.toMatchObject({ status: 409, message: "Moving Turbo cash back isn't open yet." });
    expect(calls).toHaveLength(0);
  });
  it("once open: USDC on Arbitrum -> USDG on Robinhood Chain, into and refunded to the player's own wallet", async () => {
    process.env.LIGHTER_PAYOUT_CHAIN = "42161";
    answer = () => relayOk("9990000");
    const d = await bridge.relayCashAddress(W, 10);
    expect(d.address).toBe(RELAY_DEP);
    const q = JSON.parse(calls[0].body);
    expect(q).toMatchObject({ user: W, recipient: W, refundTo: W, originChainId: 42161, originCurrency: bridge.ARBITRUM_USDC, destinationChainId: 4663, destinationCurrency: bridge.RH_USDG, amount: "10000000" });
  });
});
