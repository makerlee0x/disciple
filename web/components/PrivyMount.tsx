"use client";
/**
 * Privy = auth + embedded EOA custody only. The embedded Ethereum wallet becomes the OWNER of the user's Alchemy
 * Modular Account v2 (lib/aa/session.ts). No Privy smart wallets, no Privy gas sponsorship, no Solana.
 * Sign-in: email, Google, X/Twitter, or an external wallet (MetaMask, Coinbase, WalletConnect…). An external wallet
 * is only the login: every player still gets ONE embedded wallet, and that one owns the smart account, so one-tap
 * trading signs silently the same way for every login method. One wallet per user (lee, Oct 30): createOnLogin
 * "users-without-wallets" (was "all-users", #197) and the bridge creates an embedded wallet ONLY for a user who has none
 * (an external-wallet-only login); the owner is always the user's ORIGINAL embedded wallet (lib/privyOwner).
 * Robinhood Chain testnet (46630) is a custom viem defineChain (lib/chains.ts) passed as default/supported chain.
 */
import { useEffect, useRef } from "react";
import { PrivyProvider, toViemAccount, useCreateWallet, usePrivy, useWallets } from "@privy-io/react-auth";
import { needsEmbeddedWallet, ownerWalletAddress, type LinkedLike } from "@/lib/privyOwner";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { PRIVY_APP_ID, aaSession, registerPrivy } from "@/lib/aa/session";
import { connectPrivyOwner, disconnect } from "@/lib/wallet";
import { syncLocalIdentity } from "@/lib/profile";

function PrivyBridge() {
  const { ready, authenticated, login, logout, getAccessToken, user } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { createWallet } = useCreateWallet();
  const linked = useRef<string | null>(null);
  const creating = useRef(false);
  const linkedAccounts = (user?.linkedAccounts ?? null) as ReadonlyArray<LinkedLike> | null;

  // getAccessToken: Privy session for our API routes (verification requests / admin review), no wallet signature
  useEffect(() => { registerPrivy({ login, logout, getAccessToken, authenticated: ready && authenticated }); return () => registerPrivy(null); }, [login, logout, getAccessToken, ready, authenticated]);

  useEffect(() => {
    if (!ready || !walletsReady) return;
    if (!authenticated) {
      if (linked.current) { linked.current = null; if (aaSession()?.kind === "privy") disconnect().catch(() => {}); }
      return;
    }
    // a user with NO embedded wallet (external-wallet-only login) gets exactly one; nobody gets a second
    if (user && needsEmbeddedWallet(linkedAccounts)) {
      if (!creating.current) { creating.current = true; createWallet().catch((e) => console.warn("[privy] embedded wallet create failed", (e as Error).message)).finally(() => { creating.current = false; }); }
      return;
    }
    // owner = the user's ORIGINAL embedded wallet (HD index 0 / earliest linked), not whichever the SDK lists first
    const want = ownerWalletAddress(linkedAccounts);
    const embedded = wallets.filter((x) => x.walletClientType === "privy");
    const w = (want && embedded.find((x) => x.address.toLowerCase() === want)) || (!want ? embedded[0] : undefined);
    if (embedded.length > 1) console.warn("[disciple] several embedded wallets on this login; using the original", { owner: want });
    if (!w || linked.current === w.address.toLowerCase()) return;
    linked.current = w.address.toLowerCase();
    toViemAccount({ wallet: w })
      .then((owner) => connectPrivyOwner(owner))
      // the cached @name belongs to the account that claimed it: a different sign-in must not keep showing it
      .then((acct) => { void syncLocalIdentity(acct).catch(() => undefined); })
      .catch((e) => { linked.current = null; console.warn("[privy] owner setup failed", (e as Error).message); });
  }, [ready, walletsReady, authenticated, wallets, user, linkedAccounts, createWallet]);
  return null;
}

/** Loaded lazily by PrivyProviders (own chunk). Holds no app children: the app talks to Privy via lib/aa/session. */
export default function PrivyMount() {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["email", "google", "twitter", "wallet"],
        appearance: { theme: "dark", accentColor: "#C9CED6", showWalletLoginFirst: false },
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" }, showWalletUIs: false },
        defaultChain: ACTIVE_CHAIN,
        supportedChains: [ACTIVE_CHAIN],
      }}
    >
      <PrivyBridge />
    </PrivyProvider>
  );
}
