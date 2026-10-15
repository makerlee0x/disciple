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

export async function getSigner(): Promise<Signer> {
  const eth = provider || ((globalThis as { ethereum?: unknown }).ethereum as Eip1193 | undefined);
  if (!eth) throw Object.assign(new Error("Connect a wallet first (Privy embedded wallet)."), { code: "NoWallet" });
  const w = createWalletClient({ chain: ACTIVE_CHAIN, transport: custom(eth) });
  const [address] = await w.requestAddresses();
  try {
    if ((await w.getChainId()) !== ACTIVE_CHAIN.id) await w.switchChain({ id: ACTIVE_CHAIN.id });
  } catch {
    /* embedded wallets are pinned to the configured chain; injected may refuse → tx will fail loudly */
  }
  return Object.assign(w, { account: { address } }) as Signer;
}
