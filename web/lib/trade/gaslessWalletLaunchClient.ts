/**
 * Client for the gasless wallet launch (lib/trade/gaslessWalletLaunch): quote the gas in USDG, sign one Permit2 witness
 * (spender = CreatorFeeHarvest) for First BOOST + gas fee, POST /api/gasless disciple_walletLaunch.
 */
import type { Address, Hex, LocalAccount, PublicClient } from "viem";
import { ACTIVE_CHAIN } from "../chains";
import { bigintToDecimal, GASLESS_MAX_DEADLINE_SEC, jsonSafe, type Permit } from "./gaslessPermit2";
import { GaslessError, permitFor, permit2NonceBook, type GaslessSendResult } from "./gaslessClient";
import { privyIdentityToken } from "../aa/session";
import { launchParamsHash, walletLaunchTypedData, type GaslessLaunchWitness, type LaunchParams, type WalletLaunchRequest } from "./gaslessWalletLaunch";

export type WalletLaunchInput = { params: LaunchParams; mode: number; usdgIn: bigint; minQuoteIn: bigint; creatorFeeDestination: number };
export type WalletLaunchFee = { gasFee: bigint; harvest: Address; usdg: Address; usdgDecimals: number };

async function rpc<T>(method: string, param: unknown, url: string, fetchFn: typeof fetch, idToken?: string | null): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(idToken ? { "privy-id-token": idToken } : {}) };
  const r = await fetchFn(url, { method: "POST", headers, body: `{"jsonrpc":"2.0","id":1,"method":"${method}","params":[${JSON.stringify(param, bigintToDecimal)}]}` });
  const j = await r.json().catch(() => ({})) as { result?: T; error?: { message?: string; data?: GaslessError["data"] } };
  if (!j.result) throw new GaslessError(j.error?.message ?? `${method} HTTP ${r.status}`, j.error?.data ?? {}, r.status);
  return j.result;
}

export async function quoteWalletLaunch(signer: Address, l: WalletLaunchInput, url = "/api/gasless", fetchFn: typeof fetch = fetch): Promise<WalletLaunchFee> {
  const q = await rpc<{ gasFee: string; harvest: Address; usdg: Address; usdgDecimals: number }>("disciple_walletLaunchQuote",
    { signer, params: l.params, mode: l.mode, usdgIn: l.usdgIn, creatorFeeDestination: l.creatorFeeDestination }, url, fetchFn);
  return { gasFee: BigInt(q.gasFee), harvest: q.harvest, usdg: q.usdg, usdgDecimals: Number(q.usdgDecimals) };
}

/** Quote, sign and send. The relayer sends the launch; this wallet is the coin creator and pays First BOOST + gas in USDG. */
export async function sendWalletLaunch(pc: PublicClient, owner: LocalAccount, l: WalletLaunchInput, url = "/api/gasless", fetchFn: typeof fetch = fetch): Promise<GaslessSendResult> {
  const tokenP = privyIdentityToken().catch(() => null);
  const fee = await quoteWalletLaunch(owner.address, l, url, fetchFn);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = now + BigInt(GASLESS_MAX_DEADLINE_SEC - 30);
  const [nonce, approval] = await Promise.all([permit2NonceBook(pc).next(owner.address), permitFor(pc, owner, fee.usdg, deadline)]);
  const w: GaslessLaunchWitness = {
    paramsHash: launchParamsHash(l.params), mode: l.mode, usdgIn: l.usdgIn, minQuoteIn: l.minQuoteIn,
    creatorFeeDestination: l.creatorFeeDestination, gasFee: fee.gasFee,
  };
  const permit: Permit = { permitted: { token: fee.usdg, amount: l.usdgIn + fee.gasFee }, nonce, deadline };
  const signature = await owner.signTypedData(jsonSafe(walletLaunchTypedData(ACTIVE_CHAIN.id, fee.harvest, permit, w))) as Hex;
  const req: WalletLaunchRequest = { signer: owner.address, permit, params: l.params, w, signature, ...(approval ? { approval } : {}) };
  const res = await rpc<{ txHash: Hex; success: boolean; receipt: { logs: GaslessSendResult["logs"] }; gasUsed: number; server?: unknown }>(
    "disciple_walletLaunch", req, url, fetchFn, await tokenP);
  if (!res.success) throw new GaslessError("The launch didn't go through.", { notSent: false, txHash: res.txHash });
  return { txHash: res.txHash, logs: res.receipt.logs, gasUsed: res.gasUsed, server: res.server };
}
