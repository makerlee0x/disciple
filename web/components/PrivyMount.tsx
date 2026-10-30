"use client";
/**
 * Privy = auth + embedded EOA custody only. The embedded Ethereum wallet becomes the OWNER of the user's Alchemy
 * Modular Account v2 (lib/aa/session.ts). No Privy smart wallets, no Privy gas sponsorship, no Solana.
 * Sign-in: email, Google, X/Twitter, or an external wallet (MetaMask, Coinbase, WalletConnect…). An external wallet
 * is only the login: every player still gets an embedded wallet (createOnLogin "all-users"), and that one owns the
 * smart account, so one-tap trading signs silently the same way for every login method.
 * Robinhood Chain testnet (46630) is a custom viem defineChain (lib/chains.ts) passed as default/supported chain.
 */
import { useEffect, useRef } from "react";
import { PrivyProvider, toViemAccount, usePrivy, useWallets } from "@privy-io/react-auth";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { PRIVY_APP_ID, aaSession, registerPrivy } from "@/lib/aa/session";
import { connectPrivyOwner, disconnect } from "@/lib/wallet";
import { syncLocalIdentity } from "@/lib/profile";

function PrivyBridge() {
  const { ready, authenticated, login, logout, getAccessToken } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const linked = useRef<string | null>(null);

  // getAccessToken: Privy session for our API routes (verification requests / admin review), no wallet signature
  useEffect(() => { registerPrivy({ login, logout, getAccessToken, authenticated: ready && authenticated }); return () => registerPrivy(null); }, [login, logout, getAccessToken, ready, authenticated]);

  useEffect(() => {
    if (!ready || !walletsReady) return;
    if (!authenticated) {
      if (linked.current) { linked.current = null; if (aaSession()?.kind === "privy") disconnect().catch(() => {}); }
      return;
    }
    const w = wallets.find((x) => x.walletClientType === "privy");
    if (!w || linked.current === w.address.toLowerCase()) return;
    linked.current = w.address.toLowerCase();
    toViemAccount({ wallet: w })
      .then((owner) => connectPrivyOwner(owner))
      // the cached @name belongs to the account that claimed it: a different sign-in must not keep showing it
      .then((acct) => { void syncLocalIdentity(acct).catch(() => undefined); })
      .catch((e) => { linked.current = null; console.warn("[privy] owner setup failed", (e as Error).message); });
  }, [ready, walletsReady, authenticated, wallets]);
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
        embeddedWallets: { ethereum: { createOnLogin: "all-users" }, showWalletUIs: false },
        defaultChain: ACTIVE_CHAIN,
        supportedChains: [ACTIVE_CHAIN],
      }}
    >
      <PrivyBridge />
    </PrivyProvider>
  );
}
