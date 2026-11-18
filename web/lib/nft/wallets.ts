"use client";
/**
 * Holder wallets in the browser, outside Privy (Privy here is the EVM sign-in + embedded wallet for Robinhood Chain).
 *  - Solana: Wallet Standard (Phantom, Solflare, Backpack… all register themselves). Sign a message, sign a transaction.
 *  - Ethereum: EIP-6963 injected providers (MetaMask, Rabby, Coinbase…), window.ethereum as a fallback. personal_sign only.
 * On a phone browser with no wallet, /mint and Connect NFT offer to reopen the page in Phantom's own browser.
 */
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { b58encode } from "./base58";

export const SOLANA_MAINNET = "solana:mainnet";
type ConnectFeature = { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> };
type SignMessageFeature = { signMessage(...i: { account: WalletAccount; message: Uint8Array }[]): Promise<{ signature: Uint8Array }[]> };
type SignTxFeature = { signTransaction(...i: { account: WalletAccount; transaction: Uint8Array; chain?: string }[]): Promise<{ signedTransaction: Uint8Array }[]> };
const feat = <T>(w: Wallet, name: string) => (w.features as Record<string, unknown>)[name] as T | undefined;

export type SolWallet = { kind: "sol"; name: string; icon: string; w: Wallet };
export type EvmWallet = { kind: "eth"; name: string; icon: string; p: Eip1193 };
type Eip1193 = { request(a: { method: string; params?: unknown[] }): Promise<unknown> };

/** Solana wallets installed in this browser. */
export function solanaWallets(): SolWallet[] {
  if (typeof window === "undefined") return [];
  return getWallets().get()
    .filter((w) => w.chains.some((c) => c.startsWith("solana:")) && feat(w, "standard:connect") && feat(w, "solana:signMessage"))
    .map((w) => ({ kind: "sol" as const, name: w.name, icon: w.icon, w }));
}
/** Re-run `cb` when a wallet registers late (extensions inject after page load). */
export function onSolanaWallets(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const api = getWallets();
  const a = api.on("register", cb), b = api.on("unregister", cb);
  return () => { a(); b(); };
}

export async function solConnect(sw: SolWallet): Promise<WalletAccount> {
  const c = feat<ConnectFeature>(sw.w, "standard:connect");
  if (!c) throw new Error("This wallet can't connect.");
  const { accounts } = await c.connect();
  const acc = accounts.find((a) => a.chains.includes(SOLANA_MAINNET)) ?? accounts[0];
  if (!acc) throw new Error("No account in this wallet.");
  return acc;
}
/** base58 signature over the UTF-8 message. */
export async function solSignMessage(sw: SolWallet, acc: WalletAccount, msg: string): Promise<string> {
  const f = feat<SignMessageFeature>(sw.w, "solana:signMessage");
  if (!f) throw new Error("This wallet can't sign messages.");
  const [r] = await f.signMessage({ account: acc, message: new TextEncoder().encode(msg) });
  return b58encode(r.signature);
}
export async function solSignTransaction(sw: SolWallet, acc: WalletAccount, tx: Uint8Array): Promise<Uint8Array> {
  return (await solSignTransactions(sw, acc, [tx]))[0];
}
/** Several transactions in one wallet approval. */
export async function solSignTransactions(sw: SolWallet, acc: WalletAccount, txs: Uint8Array[]): Promise<Uint8Array[]> {
  const f = feat<SignTxFeature>(sw.w, "solana:signTransaction");
  if (!f) throw new Error("This wallet can't sign transactions.");
  const r = await f.signTransaction(...txs.map((transaction) => ({ account: acc, transaction, chain: SOLANA_MAINNET })));
  return r.map((x) => x.signedTransaction);
}

/* ---------------------------------------------------------------- Ethereum ---------------------------------------------------------------- */

type Announce = CustomEvent<{ info: { name: string; icon: string; rdns: string }; provider: Eip1193 }>;
/** Injected Ethereum wallets (EIP-6963), waiting a moment for announcements. */
export async function evmWallets(): Promise<EvmWallet[]> {
  if (typeof window === "undefined") return [];
  const found = new Map<string, EvmWallet>();
  const on = (e: Event) => { const d = (e as Announce).detail; if (d?.provider && d.info?.rdns) found.set(d.info.rdns, { kind: "eth", name: d.info.name, icon: d.info.icon, p: d.provider }); };
  window.addEventListener("eip6963:announceProvider", on);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, 250));
  window.removeEventListener("eip6963:announceProvider", on);
  const legacy = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!found.size && legacy) found.set("injected", { kind: "eth", name: "Browser wallet", icon: "", p: legacy });
  return [...found.values()];
}
export async function evmConnect(ew: EvmWallet): Promise<string> {
  const a = (await ew.p.request({ method: "eth_requestAccounts" })) as string[];
  if (!a?.[0]) throw new Error("No account in this wallet.");
  return a[0].toLowerCase();
}
export async function evmSignMessage(ew: EvmWallet, addr: string, msg: string): Promise<string> {
  const hex = "0x" + Array.from(new TextEncoder().encode(msg), (b) => b.toString(16).padStart(2, "0")).join("");
  return (await ew.p.request({ method: "personal_sign", params: [hex, addr] })) as string;
}

/** Reopen this page inside Phantom's browser (phones with no wallet extension). */
export const phantomBrowseUrl = (href: string) =>
  `https://phantom.app/ul/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(new URL(href).origin)}`;
export const isPhone = () => typeof navigator !== "undefined" && /iPhone|iPad|Android/i.test(navigator.userAgent);
