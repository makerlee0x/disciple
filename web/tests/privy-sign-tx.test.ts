/**
 * Public launch (and every execCalls send) signs with the Privy owner EOA through Privy's toViemAccount →
 * eth_signTransaction. Privy's wallet RPC rejects viem's string type ("eip1559") with a 400; it needs the numeric
 * EIP-2718 type 2. These tests lock the payload Privy receives. No live Privy call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { custom, decodeFunctionData, encodeFunctionData, keccak256, parseAbi, parseTransaction, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount, toAccount } from "viem/accounts";
import { PRIVY_TX_TYPE, toPrivyTxRequest, withPrivyTxType } from "../lib/aa/privyTx";

// Fresh random throwaway key per run. Never a real account.
const real = privateKeyToAccount(generatePrivateKey());
const NUM_TO_STR = { 0: "legacy", 1: "eip2930", 2: "eip1559", 4: "eip7702" } as const;
const isHex = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);
const q = (v: unknown) => (v == null ? undefined : isHex(v) ? v : `0x${BigInt(v as bigint).toString(16)}`);

/**
 * Stand-in for Privy toViemAccount (@privy-io/react-auth 3.50 toViemAccount → provider.request eth_signTransaction).
 * The body mirrors the SDK's mapping for Privy wallets, field for field, and validates `type` the way the wallet RPC did
 * in the failed launch: anything but 0 / 1 / 2 / 4 (or 118) → 400.
 */
function fakePrivyAccount(bodies: Record<string, unknown>[]): LocalAccount {
  return toAccount({
    address: real.address,
    sign: real.sign!, signMessage: real.signMessage, signTypedData: real.signTypedData,
    async signTransaction(e) {
      const tx = e as Record<string, unknown>;
      const body = { from: tx.from, to: tx.to, nonce: q(tx.nonce), chain_id: q(tx.chainId), data: tx.data, value: q(tx.value), type: tx.type,
        gas_limit: q(tx.gasLimit ?? tx.gas), gas_price: q(tx.gasPrice ?? tx.gas), max_fee_per_gas: q(tx.maxFeePerGas), max_priority_fee_per_gas: q(tx.maxPriorityFeePerGas) };
      bodies.push(body);
      if (!(typeof body.type === "number" && [0, 1, 2, 4, 118].includes(body.type))) {
        throw Object.assign(new Error("Privy 400: transaction.type expected number 0 | 2 | 4 | 118"), { status: 400 });
      }
      return real.signTransaction({ ...(e as object), type: NUM_TO_STR[body.type as 2] } as never);
    },
  });
}

describe("toPrivyTxRequest / withPrivyTxType", () => {
  it("maps viem string types to the EIP-2718 numbers Privy documents", () => {
    expect(toPrivyTxRequest({ type: "eip1559" }).type).toBe(2);
    expect(toPrivyTxRequest({ type: "legacy" }).type).toBe(0);
    expect(toPrivyTxRequest({ type: "eip7702" }).type).toBe(4);
    expect(PRIVY_TX_TYPE.eip1559).toBe(2);
  });
  it("leaves every other field untouched and never invents type 118", () => {
    const tx = { type: "eip1559", to: "0x0000000000000000000000000000000000000001", data: "0x1234", value: 0n, gas: 21000n, maxFeePerGas: 7n, maxPriorityFeePerGas: 1n, nonce: 0, chainId: 46630 } as const;
    const out = toPrivyTxRequest(tx);
    expect(out).toEqual({ ...tx, type: 2 });
    expect(out.type).not.toBe(118);
    expect(toPrivyTxRequest({ to: "0x1" } as { to: string; type?: string })).toEqual({ to: "0x1" }); // no type → unchanged
    expect(toPrivyTxRequest({ type: 2 }).type).toBe(2);            // already numeric → unchanged
  });
  it("only signTransaction changes: address, type, sign / signMessage / signTypedData are the Privy account's own", () => {
    const base = fakePrivyAccount([]);
    const w = withPrivyTxType(base);
    expect(w.address).toBe(base.address);
    expect(w.type).toBe("local");
    expect(w.signMessage).toBe(base.signMessage);
    expect(w.signTypedData).toBe(base.signTypedData);
    expect(w.sign).toBe(base.sign);
  });
});

/* ---- execCalls end to end through viem's real sendTransaction, with a fake RPC and the fake Privy account ---- */
const state = vi.hoisted(() => ({ owner: null as LocalAccount | null, raw: [] as Hex[] }));
vi.mock("../lib/aa/session", () => ({
  aaAddress: async () => null, aaAvailable: () => true, aaGasReservePerOp: () => 0n, aaLogout: async () => {}, aaOwnerAccount: () => state.owner,
  aaPeekGasReservePerOp: () => 0n, aaSession: () => null, eoaLogin: async () => null, localImport: async () => null, localReset: async () => {},
  localStart: async () => null, privyLogin: () => {}, restore: async () => null, setPrivyOwner: async () => null, privyIdentityToken: async () => null,
}));
vi.mock("viem", async (orig) => {
  const v = await orig<typeof import("viem")>();
  const rpc = async ({ method, params }: { method: string; params?: unknown[] }) => {
    switch (method) {
      case "eth_chainId": return "0xb626"; // 46630
      case "eth_getTransactionCount": return "0x0";
      case "eth_estimateGas": return "0x30d40";
      case "eth_maxPriorityFeePerGas": return "0x1";
      case "eth_gasPrice": return "0x3b9aca00";
      case "eth_getBlockByNumber": return { number: "0x10", baseFeePerGas: "0x3b9aca00", hash: `0x${"11".repeat(32)}`, timestamp: "0x1", transactions: [] };
      case "eth_blockNumber": return "0x11";
      case "eth_sendRawTransaction": { const raw = (params as Hex[])[0]; state.raw.push(raw); return keccak256(raw); }
      case "eth_getTransactionReceipt": return { status: "0x1", transactionHash: (params as Hex[])[0], blockNumber: "0x11", blockHash: `0x${"22".repeat(32)}`, logs: [], from: real.address, to: null, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", transactionIndex: "0x0", type: "0x2", logsBloom: `0x${"00".repeat(256)}`, contractAddress: null };
      default: throw new Error(`unexpected rpc ${method}`);
    }
  };
  return { ...v, http: () => custom({ request: rpc as never }, { retryCount: 0 }) };
});

describe("execCalls (public launch) → Privy eth_signTransaction payload", () => {
  const launchAbi = parseAbi(["function launchWithMode(string name, string symbol, uint8 mode)"]);
  const to = "0x00000000000000000000000000000000000000aa" as const;
  const data = encodeFunctionData({ abi: launchAbi, functionName: "launchWithMode", args: ["Site Retry", "SRT2", 0] });
  beforeEach(() => { state.raw = []; });

  it("unwrapped Privy account reproduces the live 400 (string \"eip1559\")", async () => {
    const bodies: Record<string, unknown>[] = [];
    state.owner = fakePrivyAccount(bodies);
    const { execCalls } = await import("../lib/wallet");
    await expect(execCalls([{ to, data, value: 0n }])).rejects.toThrow(/Privy 400/);
    expect(bodies[0].type).toBe("eip1559");
    expect(state.raw).toHaveLength(0); // nothing sent
  });

  it("wrapped account sends numeric type 2 with EIP-1559 fee fields; the signed tx is the same launch call", async () => {
    const bodies: Record<string, unknown>[] = [];
    state.owner = withPrivyTxType(fakePrivyAccount(bodies));
    const { execCalls } = await import("../lib/wallet");
    const r = await execCalls([{ to, data, value: 0n }]);
    expect(bodies).toHaveLength(1);
    const b = bodies[0];
    expect(b.type).toBe(2);
    expect(typeof b.type).toBe("number");
    expect(b.type).not.toBe(118);
    expect(b.to).toBe(to);
    expect(b.data).toBe(data);
    expect(b.value).toBe("0x0");
    expect(b.chain_id).toBe("0xb626");
    expect(b.nonce).toBe("0x0");
    expect(b.gas_limit).toBe("0x30d40");                 // viem's own estimate — gas unchanged
    expect(isHex(b.max_fee_per_gas)).toBe(true);
    expect(isHex(b.max_priority_fee_per_gas)).toBe(true);
    // the signed raw tx broadcast by viem is an ordinary EIP-1559 launchWithMode from the owner EOA
    expect(state.raw).toHaveLength(1);
    const tx = parseTransaction(state.raw[0]);
    expect(tx.type).toBe("eip1559");
    expect(tx.to).toBe(to);
    expect(tx.gas).toBe(0x30d40n);
    expect(decodeFunctionData({ abi: launchAbi, data: tx.data! }).functionName).toBe("launchWithMode");
    expect(r.txHash).toBe(keccak256(state.raw[0]));
  });
});
