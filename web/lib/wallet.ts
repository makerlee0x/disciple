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
