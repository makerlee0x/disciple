/**
 * Gasless trade, client side (flow/gasless-permit2; clientGaslessMode()). The Privy embedded EOA signs — silently,
 * Privy UI off, the same way it signs today's owner ops — ONE EIP-712 Permit2 witness (lib/trade/gaslessPermit2), plus,
 * on the very first trade of an asset, an EIP-2612 permit of that asset to PERMIT2 (USDG on the first buy, the coin on
 * its first sell). No ETH, no approve tx, no smart account. POST /api/gasless returns the full receipt.
 */
import { parseAbi, parseSignature, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { ACTIVE_CHAIN } from "../chains";
import { GASLESS_MAX_DEADLINE_SEC, NonceBook, PERMIT2, tradeTypedData, type Erc2612, type GaslessRequest, type Permit, type Trade } from "./gaslessPermit2";

const erc20 = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function nonces(address owner) view returns (uint256)",
  "function name() view returns (string)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
]);
const p2 = parseAbi(["function nonceBitmap(address owner, uint256 word) view returns (uint256)"]);
const MAX = BigInt(2) ** BigInt(256) - BigInt(1);
/** Allowance to PERMIT2 at or above this ⇒ no permit needed (Permit2 pulls exact amounts; max approvals don't decrease
 *  on OZ ERC20 when MAX). */
const ENOUGH = BigInt(2) ** BigInt(255);

let book: NonceBook | undefined;
const approved = new Map<string, boolean>();   // `${asset}:${owner}` ⇒ allowance to PERMIT2 known sufficient

export type GaslessSendResult = { txHash: Hex; logs: { address: Address; data: Hex; topics: Hex[] }[]; gasUsed: number; server?: unknown };
export class GaslessError extends Error {
  constructor(message: string, public data: { notSent?: boolean; txHash?: Hex; unclear?: boolean; revert?: Hex } = {}, public status = 0) { super(message); }
}

/** EIP-2612 permit(owner → PERMIT2, max) signature, or undefined when the allowance is already there. */
async function permitFor(pc: PublicClient, owner: LocalAccount, asset: Address, deadline: bigint): Promise<Erc2612 | undefined> {
  const k = `${asset.toLowerCase()}:${owner.address.toLowerCase()}`;
  if (approved.get(k)) return undefined;
  const [allowance, nonce, dom] = await Promise.all([
    pc.readContract({ address: asset, abi: erc20, functionName: "allowance", args: [owner.address, PERMIT2] }),
    pc.readContract({ address: asset, abi: erc20, functionName: "nonces", args: [owner.address] }),
    pc.readContract({ address: asset, abi: erc20, functionName: "eip712Domain" }).catch(async () => [undefined, await pc.readContract({ address: asset, abi: erc20, functionName: "name" }), "1"] as const),
  ]);
  if (allowance >= ENOUGH) { approved.set(k, true); return undefined; }
  const sig = await owner.signTypedData({
    domain: { name: dom[1] as string, version: (dom[2] as string) || "1", chainId: ACTIVE_CHAIN.id, verifyingContract: asset },
    types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "Permit", message: { owner: owner.address, spender: PERMIT2, value: MAX, nonce, deadline },
  });
  const { v, r, s, yParity } = parseSignature(sig);
  return { value: MAX, deadline, v: Number(v ?? BigInt(27 + (yParity ?? 0))), r, s };
}

/** Build + sign one gasless request (no network beyond reads). Exported for tests / scripts. */
export async function signGaslessTrade(pc: PublicClient, owner: LocalAccount, a: { router: Address; usdg: Address; coin: Address; isBuy: boolean; amountIn: bigint; minOut: bigint; nowSec?: number }): Promise<GaslessRequest> {
  const now = BigInt(a.nowSec ?? Math.floor(Date.now() / 1000));
  const deadline = now + BigInt(GASLESS_MAX_DEADLINE_SEC - 30);
  const asset = a.isBuy ? a.usdg : a.coin;
  book ??= new NonceBook((o, w) => pc.readContract({ address: PERMIT2, abi: p2, functionName: "nonceBitmap", args: [o, w] }));
  const [nonce, approval] = await Promise.all([book.next(owner.address), permitFor(pc, owner, asset, deadline)]);
  const trade: Trade = { coin: a.coin, isBuy: a.isBuy, amountIn: a.amountIn, minOut: a.minOut, recipient: owner.address, deadline };
  const permit: Permit = { permitted: { token: asset, amount: a.amountIn }, nonce, deadline };
  const signature = await owner.signTypedData(tradeTypedData(ACTIVE_CHAIN.id, a.router, permit, trade));
  return { signer: owner.address, permit, trade, signature, ...(approval ? { approval } : {}) };
}

const json = (q: GaslessRequest) => JSON.stringify(q, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
/** POST one signed request; resolves with the receipt (success) or throws GaslessError (data.notSent ⇒ nothing sent). */
export async function submitGasless(q: GaslessRequest, url = "/api/gasless", fetchFn: typeof fetch = fetch, idToken?: string | null): Promise<GaslessSendResult> {
  // Off-chain login: the relay requires the Privy identity token (https://docs.privy.io/user-management/users/identity-tokens)
  // whose linked wallet is the signer. Sent as `privy-id-token` (Privy's documented header); no users-API lookup on the server.
  const headers: Record<string, string> = { "content-type": "application/json", ...(idToken ? { "privy-id-token": idToken } : {}) };
  const r = await fetchFn(url, { method: "POST", headers, body: `{"jsonrpc":"2.0","id":1,"method":"disciple_gaslessTrade","params":[${json(q)}]}` });
  const j = await r.json().catch(() => ({})) as { result?: { txHash: Hex; success: boolean; receipt: { logs: GaslessSendResult["logs"] }; gasUsed: number; server?: unknown }; error?: { message?: string; data?: GaslessError["data"] } };
  if (!j.result) throw new GaslessError(j.error?.message ?? `gasless relay HTTP ${r.status}`, j.error?.data ?? {}, r.status);
  if (!j.result.success) throw new GaslessError("trade reverted on-chain", { notSent: false, txHash: j.result.txHash }, r.status);
  const k = `${(q.trade.isBuy ? q.permit.permitted.token : q.trade.coin).toLowerCase()}:${q.signer.toLowerCase()}`;
  if (q.approval) approved.set(k, true);
  return { txHash: j.result.txHash, logs: j.result.receipt.logs, gasUsed: j.result.gasUsed, server: j.result.server };
}
/** A nonce collision (another tab) fails the server simulation notSent: re-read the bitmap before the next pick. */
export function resetGaslessNonces(owner: Address) { book?.reset(owner); }
