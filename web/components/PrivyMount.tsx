"use client";
/**
 * Privy = auth + embedded EOA custody only. The embedded Ethereum wallet becomes the OWNER of the user's Alchemy
 * Modular Account v2 (lib/aa/session.ts). No Privy smart wallets, no Privy gas sponsorship, no Solana.
 * Robinhood Chain testnet (46630) is a custom viem defineChain (lib/chains.ts) passed as default/supported chain.
 */
import { useEffect, useRef } from "react";
import { PrivyProvider, toViemAccount, usePrivy, useWallets } from "@privy-io/react-auth";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { PRIVY_APP_ID, aaSession, registerPrivy } from "@/lib/aa/session";
import { connectPrivyOwner, disconnect } from "@/lib/wallet";

function PrivyBridge() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const linked = useRef<string | null>(null);

  useEffect(() => { registerPrivy({ login, logout }); return () => registerPrivy(null); }, [login, logout]);

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
        loginMethods: ["email", "google"],
        appearance: { theme: "dark", accentColor: "#ffe7a3", showWalletLoginFirst: false },
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" }, showWalletUIs: false },
        defaultChain: ACTIVE_CHAIN,
        supportedChains: [ACTIVE_CHAIN],
      }}
    >
      <PrivyBridge />
    </PrivyProvider>
  );
}
