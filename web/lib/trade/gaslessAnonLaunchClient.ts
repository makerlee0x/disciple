/**
 * Client for a relayer-submitted private launch. The Privy EOA signs one Permit2
 * witness that binds the launch and the exact USDG amount, then POSTs /api/gasless
 * (disciple_gaslessAnonLaunch). Same session token as a gasless trade.
 */
import { type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { ACTIVE_CHAIN } from "../chains";
import { bigintToDecimal, GASLESS_MAX_DEADLINE_SEC, jsonSafe, PERMIT2 } from "./gaslessPermit2";
import { permitFor, permit2NonceBook, GaslessError, type GaslessSendResult } from "./gaslessClient";
import { gaslessSigner } from "../wallet";
import { privyIdentityToken } from "../aa/session";
import {
  anonLaunchTypedData, parseGaslessAnonLaunchRequest, permitAmount,
  type AnonLaunch, type GaslessAnonLaunchRequest,
} from "./gaslessAnonLaunch";
import type { Permit } from "./gaslessPermit2";

export async function signAnonLaunch(
  pc: PublicClient,
  owner: LocalAccount,
  usdg: Address,
  launch: AnonLaunch,
  nowSec?: number,
): Promise<GaslessAnonLaunchRequest> {
  const now = BigInt(nowSec ?? Math.floor(Date.now() / 1000));
  const deadline = now + BigInt(GASLESS_MAX_DEADLINE_SEC - 30);
  // The launch deadline is already set by the caller; the permit uses a live window.
  const amount = permitAmount(launch);
  const [nonce, approval] = await Promise.all([permit2NonceBook(pc).next(owner.address), permitFor(pc, owner, usdg, deadline)]);
  const permit: Permit = { permitted: { token: usdg, amount }, nonce, deadline };
  const signature = await owner.signTypedData(jsonSafe(anonLaunchTypedData(ACTIVE_CHAIN.id, permit, launch)));
  return { signer: owner.address, permit, launch, signature, ...(approval ? { approval } : {}) };
}

export async function submitGaslessAnonLaunch(
  q: GaslessAnonLaunchRequest,
  url = "/api/gasless",
  fetchFn: typeof fetch = fetch,
  idToken?: string | null,
): Promise<GaslessSendResult> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(idToken ? { "privy-id-token": idToken } : {}) };
  const r = await fetchFn(url, { method: "POST", headers, body: `{"jsonrpc":"2.0","id":1,"method":"disciple_gaslessAnonLaunch","params":[${JSON.stringify(q, bigintToDecimal)}]}` });
  const j = await r.json().catch(() => ({})) as { result?: { txHash: Hex; success: boolean; receipt: { logs: GaslessSendResult["logs"] }; gasUsed: number; server?: unknown }; error?: { message?: string; data?: GaslessError["data"] } };
  if (!j.result) throw new GaslessError(j.error?.message ?? `private launch HTTP ${r.status}`, j.error?.data ?? {}, r.status);
  if (!j.result.success) throw new GaslessError("The launch didn't go through. Your cash was not taken.", { notSent: false, txHash: j.result.txHash }, r.status);
  return { txHash: j.result.txHash, logs: j.result.receipt.logs, gasUsed: j.result.gasUsed, server: j.result.server };
}

/** Sign the witness and submit the private launch through the relayer. */
export async function sendPrivateLaunchRelayer(
  pc: PublicClient,
  usdg: Address,
  launch: AnonLaunch,
  url = "/api/gasless",
  fetchFn: typeof fetch = fetch,
): Promise<GaslessSendResult> {
  const owner = gaslessSigner();
  if (!owner) throw new GaslessError("Sign in to launch this private rocket.");
  if (owner.address.toLowerCase() !== launch.refundTo.toLowerCase()) {
    throw new GaslessError("The leftover cash has to come back to you.");
  }
  const req = parseGaslessAnonLaunchRequest(await signAnonLaunch(pc, owner, usdg, launch));
  const tokenP = privyIdentityToken().catch(() => null);
  return submitGaslessAnonLaunch(req, url, fetchFn, await tokenP);
}

export type { AnonLaunch, GaslessAnonLaunchRequest };
export { PERMIT2 };
