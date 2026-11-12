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
import { PrivyProvider, getIdentityToken, toViemAccount, useCreateWallet, usePrivy, useWallets } from "@privy-io/react-auth";
import { needsEmbeddedWallet, ownerWalletAddress, type LinkedLike } from "@/lib/privyOwner";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { PRIVY_APP_ID, aaSession, registerPrivy, type PrivyAccountInfo } from "@/lib/aa/session";
import { connectPrivyOwner, disconnect } from "@/lib/wallet";
import { syncLocalIdentity } from "@/lib/profile";

type AccountLike = { type?: string; latestVerifiedAt?: Date | string | null; walletClientType?: string; email?: string; address?: string; username?: string | null };
const METHOD: Record<string, PrivyAccountInfo["method"]> = { email: "Email", google_oauth: "Google", twitter_oauth: "X", wallet: "a wallet" };
/** Read-only summary of the Privy user for Settings / Edit profile: the most recently used login, its email, the linked X username. */
function accountInfo(user: { linkedAccounts?: unknown[] } | null | undefined): PrivyAccountInfo | null {
  if (!user) return null;
  const all = (user.linkedAccounts ?? []) as AccountLike[];
  const logins = all.filter((a) => a.type && a.type in METHOD && !(a.type === "wallet" && a.walletClientType === "privy"));
  const at = (a: AccountLike) => (a.latestVerifiedAt ? new Date(a.latestVerifiedAt).getTime() : 0);
  const last = logins.sort((a, b) => at(b) - at(a))[0];
  const x = all.find((a) => a.type === "twitter_oauth");
  const mail = last?.type === "google_oauth" || last?.type === "email" ? last : all.find((a) => a.type === "email" || a.type === "google_oauth");
  const email = (mail?.type === "email" ? mail.address : mail?.email) ?? null;
  return { method: last?.type ? METHOD[last.type] ?? null : null, email, xUsername: x?.username ?? null };
}

function PrivyBridge() {
  const { ready, authenticated, login, logout, getAccessToken, user } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { createWallet } = useCreateWallet();
  const linked = useRef<string | null>(null);
  const creating = useRef(false);
  const linkedAccounts = (user?.linkedAccounts ?? null) as ReadonlyArray<LinkedLike> | null;

  // getAccessToken: Privy session for our API routes (verification requests / admin review), no wallet signature
  useEffect(() => { registerPrivy({ login, logout, getAccessToken, getIdentityToken, authenticated: ready && authenticated, account: accountInfo(user) }); return () => registerPrivy(null); }, [login, logout, getAccessToken, ready, authenticated, user]);

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
