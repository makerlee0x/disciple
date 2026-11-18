"use client";
/**
 * Metaplex Umi for /mint and /admin/mint: RPC through our /api/solana/rpc proxy (the Helius key stays on the server),
 * the player's Wallet Standard wallet as the signer. Loaded only on those pages (dynamic import), never in the main bundle.
 * Confirmation polls getSignatureStatuses (the proxy has no websocket).
 */
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mplCandyMachine } from "@metaplex-foundation/mpl-candy-machine";
import { mplTokenMetadata } from "@metaplex-foundation/mpl-token-metadata";
import { publicKey, signerIdentity, type Signer, type Transaction, type TransactionBuilder, type Umi } from "@metaplex-foundation/umi";
import type { WalletAccount } from "@wallet-standard/base";
import { withBase } from "../base-path";
import { b58encode } from "./base58";
import { solSignTransaction, solSignTransactions, type SolWallet } from "./wallets";

export function walletSigner(umi: Umi, sw: SolWallet, acc: WalletAccount): Signer {
  const signTransaction = async (tx: Transaction) => umi.transactions.deserialize(await solSignTransaction(sw, acc, umi.transactions.serialize(tx)));
  return {
    publicKey: publicKey(acc.address),
    signMessage: async () => { throw new Error("Message signing isn't used for mints."); },
    signTransaction,
    signAllTransactions: async (txs: Transaction[]) =>
      (await solSignTransactions(sw, acc, txs.map((t) => umi.transactions.serialize(t)))).map((b) => umi.transactions.deserialize(b)),
  };
}

export function makeUmi(sw: SolWallet, acc: WalletAccount): Umi {
  const umi = createUmi(new URL(withBase("/api/solana/rpc"), window.location.origin).toString(), { commitment: "confirmed" })
    .use(mplTokenMetadata()).use(mplCandyMachine());
  umi.use(signerIdentity(walletSigner(umi, sw, acc)));
  return umi;
}

async function waitFor(umi: Umi, sig: string, timeoutMs: number): Promise<string> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 1500));
    const [st] = await umi.rpc.call<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [[sig]]).then((r) => r.value).catch(() => [null]);
    if (st?.err) throw new Error(`Transaction failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
  }
  throw new Error("Timed out waiting for the network. Check your wallet before trying again.");
}

/** Sign many independent builders in ONE wallet approval, send them all, then confirm. onEach(i) after each confirms. */
export async function sendAllAndWait(umi: Umi, bs: TransactionBuilder[], onEach?: (i: number) => void): Promise<string[]> {
  const bh = await umi.rpc.getLatestBlockhash({ commitment: "confirmed" });
  const signed = await umi.identity.signAllTransactions(bs.map((b) => b.setBlockhash(bh).build(umi)));
  // send all first (the blockhash lives ~60 s), then confirm; these batches don't depend on each other
  const sigs: string[] = [];
  for (const t of signed) sigs.push(b58encode(await umi.rpc.sendTransaction(t, { skipPreflight: false, commitment: "confirmed" })));
  for (let i = 0; i < sigs.length; i++) { await waitFor(umi, sigs[i], 90_000); onEach?.(i); }
  return sigs;
}

/** Send a builder and wait until it's confirmed (or fails / times out). Resolves the base58 signature. */
export async function sendAndWait(umi: Umi, b: TransactionBuilder, timeoutMs = 90_000): Promise<string> {
  const sig = b58encode(await b.send(umi, { skipPreflight: false, commitment: "confirmed" }));
  return waitFor(umi, sig, timeoutMs);
}
