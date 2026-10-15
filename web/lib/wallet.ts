/**
 * Signer seam. No custody: the user's Privy embedded wallet signs its own txs.
 * When Privy lands (@privy-io/react-auth), register its EIP-1193 provider once:
 *   const w = wallets.find((w) => w.walletClientType === "privy");
 *   setWalletProvider(await w.getEthereumProvider());
 * Until then (or for dev) we fall back to an injected wallet (window.ethereum).
 */
import { createWalletClient, custom, type Address, type WalletClient } from "viem";
import { ACTIVE_CHAIN } from "./chains";

type Eip1193 = Parameters<typeof custom>[0];
let provider: Eip1193 | null = null;

export function setWalletProvider(p: Eip1193 | null) {
  provider = p;
}

export function hasWallet() {
  return !!(provider || (globalThis as { ethereum?: unknown }).ethereum);
}

export type Signer = WalletClient & { account: { address: Address } };

/** Switch the wallet to ACTIVE_CHAIN, adding it first (RPC/explorer) if the wallet doesn't know it. */
export async function ensureChain(w: WalletClient) {
  if ((await w.getChainId()) === ACTIVE_CHAIN.id) return;
  try {
    await w.switchChain({ id: ACTIVE_CHAIN.id });
  } catch {
    await w.addChain({ chain: ACTIVE_CHAIN }); // EIP-3085; most wallets switch after adding
    if ((await w.getChainId()) !== ACTIVE_CHAIN.id) await w.switchChain({ id: ACTIVE_CHAIN.id });
  }
}

/** Explicit connect (wallet button). Returns the address. */
export async function connectWallet(): Promise<Address> {
  const s = await getSigner();
  emit(s.account.address);
  return s.account.address;
}

/** Tiny pub/sub so UI bits (wallet button, ammo bar) share the connected address. */
let current: Address | null = null;
const subs = new Set<(a: Address | null) => void>();
function emit(a: Address | null) { current = a; subs.forEach((f) => f(a)); }
export function connectedAddress() { return current; }
export function onWallet(f: (a: Address | null) => void) { subs.add(f); f(current); return () => { subs.delete(f); }; }

export async function getSigner(): Promise<Signer> {
  const eth = provider || ((globalThis as { ethereum?: unknown }).ethereum as Eip1193 | undefined);
  if (!eth) throw Object.assign(new Error("Connect a wallet first (Privy embedded wallet)."), { code: "NoWallet" });
  const w = createWalletClient({ chain: ACTIVE_CHAIN, transport: custom(eth) });
  const [address] = await w.requestAddresses();
  await ensureChain(w);
  return Object.assign(w, { account: { address } }) as Signer;
}

/* ---------------- smart account (one-tap) seam ---------------- */
import type { Call } from "./aa/core";
import { aaAddress, aaAvailable, aaLogout, aaSend, aaSession, eoaLogin, emailVerify, googleLogin, restore } from "./aa/session";
import type { Hex } from "viem";

export type ExecResult = { txHash: Hex; logs: { address: Address; data: Hex; topics: Hex[] }[]; userOp?: Hex; gasMode?: string };

/** Smart-account mode is on when a session exists; otherwise the legacy EOA path is used. */
export const isSmartMode = () => !!aaSession();
export { aaAvailable };

/** Sign in once with an existing wallet (EOA owner). */
export async function connectSmartWithWallet(): Promise<Address> {
  const eth = provider || ((globalThis as { ethereum?: unknown }).ethereum as Eip1193 | undefined);
  if (!eth) throw Object.assign(new Error("No browser wallet found."), { code: "NoWallet" });
  const a = await eoaLogin(eth); emit(a); return a;
}
export async function connectSmartEmail(code: string) { const a = await emailVerify(code); emit(a); return a; }
export async function connectSmartGoogle() { const a = await googleLogin(); emit(a); return a; }
export async function restoreSmart() { if (!aaAvailable()) return null; const a = await restore(); if (a) emit(a); return a; }
export async function disconnect() { await aaLogout(); emit(null); }

/** The address that holds funds/trades: smart account if signed in, else the EOA. */
export async function activeAddress(): Promise<Address> {
  const a = await aaAddress();
  if (a) return a;
  return (await getSigner()).account.address;
}

/**
 * Execute a call list. Smart account ⇒ ONE sponsored (or self-paid) userOp, no popup.
 * EOA ⇒ legacy: one tx per call, in order.
 */
export async function execCalls(calls: Call[]): Promise<ExecResult> {
  if (isSmartMode()) {
    const r = await aaSend(calls);
    return { txHash: r.txHash, logs: r.receipt.receipt.logs, userOp: r.userOpHash, gasMode: r.gasMode };
  }
  const w = await getSigner();
  const { createPublicClient, http } = await import("viem");
  const pc = createPublicClient({ chain: ACTIVE_CHAIN, transport: http() });
  let last: ExecResult | null = null;
  for (const c of calls) {
    const hash = await w.sendTransaction({ chain: ACTIVE_CHAIN, account: w.account.address, to: c.to, data: c.data, value: c.value });
    const rc = await pc.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`Transaction reverted (${hash})`);
    last = { txHash: hash, logs: rc.logs as ExecResult["logs"] };
  }
  return last!;
}
