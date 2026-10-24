/**
 * Signer seam. No custody: the user's Privy embedded wallet owns their MAv2 smart account
 * (components/PrivyProviders.tsx → connectPrivyOwner). The plain-EOA path below (injected wallet,
 * window.ethereum) is the legacy / dev fallback.
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

/**
 * Plain injected-wallet (EOA) trading is a legacy/dev path. It is allowed ONLY after an explicit connectWallet() from
 * the wallet menu (dev builds, or chains without the smart-account stack). Bug #3: before this, any write while signed
 * out fell back to window.ethereum, so MetaMask could launch a rocket (and trade) without a DISCIPLE sign-in — the
 * launch, the First BOOST and its tokens all landed on the MetaMask EOA instead of the user's embedded account.
 */
let plainWallet: Address | null = null;
export class SignInRequired extends Error { code = "SignIn"; constructor(m = "Sign in to trade or launch (Email / Google) — your DISCIPLE wallet signs for you.") { super(m); } }
/** May writes go through right now? Smart session (signed in), or an explicitly connected plain wallet. */
export function canTransact(): boolean { return isSmartMode() || !!plainWallet; }

/** Explicit connect (wallet button). Returns the address. */
export async function connectWallet(): Promise<Address> {
  const s = await getSigner();
  plainWallet = s.account.address;
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
import type { SendOpts } from "./aa/fastPath";
import type { GasOpKind } from "./aa/gasReserve";
import { aaAddress, aaAvailable, aaGasReservePerOp, aaLogout, aaPeekGasReservePerOp, aaSend, aaSession, eoaLogin, localImport, localReset, localStart, privyLogin, restore, setPrivyOwner } from "./aa/session";
import type { Hex, LocalAccount } from "viem";

export type ExecResult = { txHash: Hex; logs: { address: Address; data: Hex; topics: Hex[] }[]; userOp?: Hex; gasMode?: string; /** GAME reservation id (SendOpts.pressId) */ pressId?: string };

/** Smart-account mode is on when a session exists; otherwise the legacy EOA path is used. */
export const isSmartMode = () => !!aaSession();
export { aaAvailable };

/** Sign in once with an existing wallet (EOA owner). */
export async function connectSmartWithWallet(): Promise<Address> {
  const eth = provider || ((globalThis as { ethereum?: unknown }).ethereum as Eip1193 | undefined);
  if (!eth) throw Object.assign(new Error("No browser wallet found."), { code: "NoWallet" });
  const a = await eoaLogin(eth); emit(a); return a;
}
/** Open the Privy login modal (email / Google). The address is emitted once the embedded wallet is ready. */
export function connectPrivy() { privyLogin(); }
/** Called by PrivyProviders with toViemAccount(embeddedWallet). */
export async function connectPrivyOwner(owner: LocalAccount) { const a = await setPrivyOwner(owner); emit(a); return a; }
export async function restoreSmart() { if (!aaAvailable()) return null; const a = await restore(); if (a) emit(a); return a; }
export async function connectLocal() { const a = await localStart(); emit(a); return a; }
export async function importLocal(k: string) { const a = await localImport(k); emit(a); return a; }
export async function resetLocal() { await localReset(); emit(null); }
export async function disconnect() { plainWallet = null; await aaLogout(); emit(null); }

/**
 * #103: off-chain proofs (chat login, username claim) sign with the injected wallet ONLY after an explicit
 * connectWallet() for that address. A Privy / smart-account user is never sent to window.ethereum (MetaMask).
 */
export async function plainWalletSigner(expect?: string): Promise<Signer> {
  if (!plainWallet || (expect && plainWallet.toLowerCase() !== expect.toLowerCase())) throw new SignInRequired();
  const s = await getSigner();
  if (s.account.address.toLowerCase() !== plainWallet.toLowerCase()) throw new SignInRequired();
  return s;
}
/** The address that holds funds/trades: the smart account when signed in, else an explicitly connected plain wallet. */
export async function activeAddress(): Promise<Address> {
  const a = await aaAddress();
  if (a) return a;
  if (plainWallet) return (await getSigner()).account.address;
  throw new SignInRequired();
}

/**
 * Rapid taps (GAME): USDG base units one pending trade may still take for network fees — SYNC, never awaits.
 *   reserve = liveCash − Σ pending (amountIn + gasReservePerOp())
 * Warm: the fresh allowance's real maxTokenCost (never min'd with an estimate); cold: derived (lib/aa/gasReserve:
 * gas limit × the allowance's maxFee formula at the live gas price × the paymaster rate ≈ $0.3–0.5/trade today);
 * 0n when gas isn't paid in USDG (EOA / ETH). kind: "trade" (buy / sell, default) | "gradBuy".
 */
export function gasReservePerOp(kind: GasOpKind = "trade"): bigint { return isSmartMode() ? aaGasReservePerOp(kind) : BigInt(0); }
// SITE #144 (lib/trade/reservations, not in this base yet) — at rebase add, once at module scope here:
//   import { setGasReserveSource } from "@/lib/trade/reservations";
//   setGasReserveSource(() => gasReservePerOp());   // raw USDG base units (18 dec testnet mUSDG, 6 mainnet); 0n ⇒ ETH gas
/** Same, but null while cold (no fresh allowance yet) instead of the derived value. */
export function peekGasReservePerOp(kind: GasOpKind = "trade"): bigint | null { return isSmartMode() ? aaPeekGasReservePerOp(kind) : BigInt(0); }
export type { GasOpKind } from "./aa/gasReserve";

/**
 * Execute a call list. Smart account ⇒ ONE sponsored (or self-paid) userOp, no popup.
 * EOA ⇒ legacy: one tx per call, in order.
 */
export async function execCalls(calls: Call[], o: SendOpts = {}): Promise<ExecResult> {
  if (!isSmartMode() && !plainWallet) throw new SignInRequired();
  if (isSmartMode()) {
    const r = await aaSend(calls, o);
    return { txHash: r.txHash, logs: r.receipt.receipt.logs, userOp: r.userOpHash, gasMode: r.gasMode, pressId: r.pressId };
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
