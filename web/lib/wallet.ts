/**
 * Signer seam. No custody: the user's Privy embedded wallet owns their MAv2 smart account
 * (components/PrivyProviders.tsx → connectPrivyOwner). The plain-EOA path below (injected wallet,
 * window.ethereum) is the legacy / dev fallback.
 */
import { _emitWallet } from "./walletState";
import { createWalletClient, custom, type Address, type WalletClient } from "viem";
import { ACTIVE_CHAIN } from "./chains";
import { REJECTED_MSG } from "./aa/relayOp";
import { noteReceipt } from "./flight/tradeSpeed";

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
export function canTransact(): boolean { return isSmartMode() || !!plainWallet || !!gaslessSigner(); }

/** Explicit connect (wallet button). Returns the address. */
export async function connectWallet(): Promise<Address> {
  const s = await getSigner();
  plainWallet = s.account.address;
  emit(s.account.address);
  return s.account.address;
}

/** Tiny pub/sub so UI bits (wallet button, ammo bar) share the connected address. */
// address + listeners live in ./walletState (no viem) so light UI can subscribe without loading the wallet stack
const emit = (a: Address | null) => _emitWallet(a);
export { connectedAddress, onWallet } from "./walletState";

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
import { aaAddress, aaAvailable, aaGasReservePerOp, aaLogout, aaOwnerAccount, aaPeekGasReservePerOp, aaSession, eoaLogin, localImport, localReset, localStart, privyLogin, restore, setPrivyOwner } from "./aa/session";
import { clientGaslessMode } from "./aa/sponsorshipMode";
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
export async function connectPrivyOwner(owner: LocalAccount) { const a = await setPrivyOwner(owner); const shown = clientGaslessMode() ? owner.address : a; emit(shown); return shown; }
/** Gasless mode: the owner EOA that signs Permit2 trades (null ⇒ not gasless / signed out). */
export function gaslessSigner(): LocalAccount | null { return clientGaslessMode() ? aaOwnerAccount() : null; }
export async function restoreSmart() { if (!aaAvailable()) return null; const a = await restore(); const shown = (a && gaslessSigner()?.address) || a; if (shown) emit(shown); return shown; }
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
  const g = gaslessSigner();
  if (g) return g.address;   // gasless: the Privy EOA holds funds and trades (no smart account on the trade path)
  const a = await aaAddress();
  if (a) return a;
  if (plainWallet) return (await getSigner()).account.address;
  throw new SignInRequired();
}

/**
 * Rapid taps (GAME): USDG base units one pending trade may still take for network fees — SYNC, never awaits.
 *   reserve = liveCash − Σ pending (amountIn + gasReservePerOp())
 * USDG-paid smart-account gas reserves are computed synchronously; EOAs use native ETH.
 */
export function gasReservePerOp(kind: GasOpKind = "trade"): bigint { return isSmartMode() && !clientGaslessMode() ? aaGasReservePerOp(kind) : BigInt(0); }
// SITE #144 (lib/trade/reservations, not in this base yet) — at rebase add, once at module scope here:
//   import { setGasReserveSource } from "@/lib/trade/reservations";
//   setGasReserveSource(() => gasReservePerOp());   // raw USDG base units (18 dec testnet mUSDG, 6 mainnet); 0n ⇒ ETH gas
/** Same, but null while cold (no fresh allowance yet) instead of the derived value. */
export function peekGasReservePerOp(kind: GasOpKind = "trade"): bigint | null { return isSmartMode() && !clientGaslessMode() ? aaPeekGasReservePerOp(kind) : BigInt(0); }
export type { GasOpKind } from "./aa/gasReserve";

/**
 * Execute a call list. Smart account ⇒ ONE sponsored (or self-paid) userOp, no popup.
 * EOA ⇒ legacy: one tx per call, in order.
 */
/** GAME trade speed hand-off (SITE conditions): synchronous, no await, no RPC (logs passed as returned), NEVER throws, so a
 *  failing hand-off can't break or delay the trade return (TradeBridge then just falls back to polling the receipt). */
function handOffLogs(txHash: Hex | undefined, logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[] | undefined) {
  try { noteReceipt(txHash, logs); } catch { /* never break the trade */ }
}
export async function execCalls(calls: Call[], o: SendOpts = {}): Promise<ExecResult> {
  const owner = gaslessSigner();
  /**
   * WITHDRAW / CLAIMS / SEND FLAG: Cash withdraw (and claims, tramp walls, creator transfer) is a plain USDG (or
   * contract) send via execCalls. It previously used the 4337 userOp/paymaster path (aaSend) so the player needed no
   * ETH. That path is deleted. This now sends from the Privy owner EOA (the address that holds funds in gasless mode)
   * with a normal EIP-1559 tx — it REQUIRES ETH on that EOA for gas. No new gasless withdraw was built.
   * The injected-wallet fallback (getSigner / MetaMask) is only used for an explicitly connected plainWallet.
   */
  if (!owner && !plainWallet) throw new SignInRequired();
  const { createWalletClient, createPublicClient, http } = await import("viem");
  const pc = createPublicClient({ chain: ACTIVE_CHAIN, transport: http() });
  let last: ExecResult | null = null;
  if (owner) {
    const w = createWalletClient({ chain: ACTIVE_CHAIN, account: owner, transport: http() });
    for (const c of calls) {
      const hash = await w.sendTransaction({ chain: ACTIVE_CHAIN, account: owner, to: c.to, data: c.data, value: c.value ?? BigInt(0) });
      const rc = await pc.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") {
        console.warn("[disciple] send reverted", { txHash: hash });
        throw Object.assign(new Error(REJECTED_MSG), { txHash: hash });
      }
      last = { txHash: hash, logs: rc.logs as ExecResult["logs"] };
      handOffLogs(hash, last.logs);
    }
    return last!;
  }
  const w = await getSigner();
  for (const c of calls) {
    const hash = await w.sendTransaction({ chain: ACTIVE_CHAIN, account: w.account.address, to: c.to, data: c.data, value: c.value });
    const rc = await pc.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") {
      console.warn("[disciple] trade reverted", { txHash: hash });
      throw Object.assign(new Error(REJECTED_MSG), { txHash: hash });
    }
    last = { txHash: hash, logs: rc.logs as ExecResult["logs"] };
    handOffLogs(hash, last.logs);
  }
  return last!;
}

/* ---------------- gasless (Permit2 witness) seam — flow/gasless-permit2 ---------------- */
/**
 * One gasless trade from the owner EOA (gaslessSigner): sign the Permit2 witness (+ the one-time EIP-2612 approval of
 * PERMIT2) silently and POST /api/gasless. Errors are AAErrors so the trade path's existing rules apply unchanged:
 * "Estimate" = refused before sending (exact simulation / admission; nothing sent), "Reverted" = included and reverted
 * (sent), "Timeout" = may still land (never resent).
 */
export async function execGasless(a: { coin: Address; isBuy: boolean; amountIn: bigint; minOut: bigint; pressId?: string }): Promise<ExecResult> {
  const owner = gaslessSigner();
  if (!owner) throw new SignInRequired();
  const { deployment } = await import("./chains");
  const { createPublicClient, http } = await import("viem");
  const { signGaslessTrade, submitGasless, resetGaslessNonces, GaslessError } = await import("./trade/gaslessClient");
  const { AAError } = await import("./aa/core");
  const d = deployment();
  const pc = createPublicClient({ chain: ACTIVE_CHAIN, transport: http() });
  // Privy identity token (linked accounts; cached/auto-refreshed by Privy) fetched in parallel with signing.
  const tokenP = import("./aa/session").then(m => m.privyIdentityToken()).catch(() => null);
  const q = await signGaslessTrade(pc as never, owner, { router: d.gaslessRouter, usdg: d.usdg, coin: a.coin, isBuy: a.isBuy, amountIn: a.amountIn, minOut: a.minOut });
  try {
    const r = await submitGasless(q, "/api/gasless", fetch, await tokenP);
    handOffLogs(r.txHash, r.logs);
    return { txHash: r.txHash, logs: r.logs, gasMode: "gasless", pressId: a.pressId };
  } catch (e) {
    if (!(e instanceof GaslessError)) throw e;
    if (e.data.unclear) throw new AAError("Timeout", e.message, { txHash: e.data.txHash });
    if (e.data.txHash && e.data.notSent !== true) throw new AAError("Reverted", e.message, { txHash: e.data.txHash });
    if (/InvalidNonce|0x756688fe/i.test(e.message + (e.data.revert ?? ""))) resetGaslessNonces(owner.address);
    throw new AAError("Estimate", e.message, { revertData: e.data.revert, notSent: true });
  }
}
