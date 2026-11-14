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
import { useEffect, useMemo, useRef } from "react";
import { PrivyProvider, getIdentityToken, toViemAccount, useCreateWallet, useExportWallet, useFundWallet, useMfaEnrollment, usePrivy, useWallets } from "@privy-io/react-auth";
import { deployment, isDeployed } from "@/lib/chains";
import { useDepositAddress } from "@privy-io/react-auth/hooks";
import { DEPOSIT_ACK_EVENT, DEPOSIT_CALL_EVENT, DEPOSIT_REPLY_EVENT, type DepositAddress, type DepositCall, type DepositOutcome, type DepositReply } from "@/lib/deposit";
import { FUND_ACK_EVENT, FUND_COPY, FUND_DEFAULT_USD, FUND_DONE_EVENT, FUND_EVENT, fundErrorLine, type FundRequest, type FundResult } from "@/lib/fund";
const FUND_CLOSED = FUND_COPY.closed;
import { currentInApp } from "@/lib/inAppBrowser";
import { needsEmbeddedWallet, ownerWalletAddress, type LinkedLike } from "@/lib/privyOwner";
import { ACTIVE_CHAIN } from "@/lib/chains";
import { PRIVY_APP_ID, aaSession, registerPrivy, type PrivyAccountInfo, type PrivySecurity } from "@/lib/aa/session";
import { connectPrivyOwner, disconnect } from "@/lib/wallet";
import { withPrivyTxType } from "@/lib/aa/privyTx";
import { syncLocalIdentity } from "@/lib/profile";
import { withBase } from "@/lib/base-path";
import { SIGN_IN_COPY, SIGN_IN_FAILED_EVENT } from "@/lib/walletCta";

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

  const { exportWallet } = useExportWallet();
  const { showMfaEnrollmentModal, unenrollWithTotp, unenrollWithPasskey } = useMfaEnrollment();
  // Settings → Export key / Two-factor authentication: Privy's own modals (useExportWallet, useMfaEnrollment); the key
  // is shown inside Privy's iframe, never in the app. Export targets the owner embedded wallet (the one the app trades with).
  const security = useMemo<PrivySecurity | null>(() => {
    if (!user) return null;
    const owner = ownerWalletAddress(linkedAccounts);
    return {
      exportWallet: owner ? () => exportWallet({ address: owner }) : null,
      mfaEnrolled: ((user as { mfaMethods?: string[] }).mfaMethods ?? []).slice(),
      enrollMfa: () => showMfaEnrollmentModal(),
      unenrollMfa: (m) => (m === "totp" ? unenrollWithTotp() : unenrollWithPasskey()),
    };
  }, [user, linkedAccounts, exportWallet, showMfaEnrollmentModal, unenrollWithTotp, unenrollWithPasskey]);

  // getAccessToken: Privy session for our API routes (verification requests / admin review), no wallet signature
  useEffect(() => { registerPrivy({ ready, login, logout, getAccessToken, getIdentityToken, authenticated: ready && authenticated, account: accountInfo(user), security }); return () => registerPrivy(null); }, [login, logout, getAccessToken, ready, authenticated, user, security]);

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
      // Privy's wallet RPC needs the numeric tx type (2), not viem's "eip1559" (lib/aa/privyTx)
      .then((owner) => connectPrivyOwner(withPrivyTxType(owner)))
      // the cached @name belongs to the account that claimed it: a different sign-in must not keep showing it
      .then((acct) => { void syncLocalIdentity(acct).catch(() => undefined); })
      .catch((e) => { linked.current = null; console.warn("[privy] owner setup failed", (e as Error).message); dispatchEvent(new Event(SIGN_IN_FAILED_EVENT)); });
  }, [ready, walletsReady, authenticated, wallets, user, linkedAccounts, createWallet]);
  return null;
}

/** Card / Apple Pay on-ramp (lib/fund): opens Privy's funding flow for the player's cash address, buying USDG on the
 *  active chain. Answers every request with FUND_DONE_EVENT so Cash can show what happened. */
function FundBridge() {
  const done = (r: FundResult) => dispatchEvent(new CustomEvent<FundResult>(FUND_DONE_EVENT, { detail: r }));
  // closing the window says nothing about a payment that's still settling, so Cash shows the neutral "closed" line
  const { fundWallet } = useFundWallet({ onUserExited: () => done({ ok: false, message: FUND_CLOSED }) });
  const fundRef = useRef(fundWallet); fundRef.current = fundWallet;
  useEffect(() => {
    const on = (e: Event) => {
      const req = (e as CustomEvent<FundRequest>).detail;
      dispatchEvent(new Event(FUND_ACK_EVENT));
      if (!req?.address) return done({ ok: false });
      const usd = String(req.usd && req.usd > 0 ? req.usd : FUND_DEFAULT_USD);
      const usdg = isDeployed() ? (deployment().usdg as `0x${string}` | undefined) : undefined;
      fundRef.current({
        address: req.address,
        options: usdg
          ? { chain: ACTIVE_CHAIN, amount: usd, asset: { erc20: usdg }, defaultFundingMethod: "card", uiConfig: { receiveFundsTitle: "Add cash" } }
          : { chain: ACTIVE_CHAIN, amount: usd, defaultFundingMethod: "card" },
      }).then(() => done({ ok: true })).catch((err) => done({ ok: false, message: fundErrorLine(err) }));
    };
    addEventListener(FUND_EVENT, on);
    return () => removeEventListener(FUND_EVENT, on);
  }, []);
  return null;
}

/** "Send crypto instead" (lib/deposit): Privy's deposit addresses. Answers each DEPOSIT_CALL_EVENT with a
 *  DEPOSIT_REPLY_EVENT of the same id: the live config, a fresh address for one send, or the deposit's outcome. */
function DepositBridge() {
  const dep = useDepositAddress();
  const ref = useRef(dep); ref.current = dep;
  useEffect(() => {
    const reply = (r: DepositReply) => dispatchEvent(new CustomEvent<DepositReply>(DEPOSIT_REPLY_EVENT, { detail: r }));
    const on = (e: Event) => {
      const c = (e as CustomEvent<DepositCall>).detail;
      if (!c?.id) return;
      dispatchEvent(new CustomEvent(DEPOSIT_ACK_EVENT, { detail: { id: c.id } }));
      const d = ref.current;
      const run = async (): Promise<unknown> => {
        if (c.op === "config") return d.getConfig();
        if (c.op === "address") {
          const q = await d.generateDepositAddress({ sourceChain: c.sourceChain, sourceCurrency: c.sourceCurrency, destinationChain: c.destinationChain,
            destinationCurrency: c.destinationCurrency, destinationAddress: c.destinationAddress });
          return { id: q.id, address: q.deposit_address, createdAt: q.created_at, etaSec: q.time_estimate_seconds } satisfies DepositAddress;
        }
        const got = await d.waitForDeposit({ depositAddressId: c.depositAddressId, quoteCreatedAt: c.quoteCreatedAt });
        if (got.status !== "success") return { status: "timeout" } satisfies DepositOutcome;
        const fin = got.order.status === "completed" ? got : await d.waitForCompletion({ orderId: got.order.id });
        if (fin.status !== "success") return { status: "timeout" } satisfies DepositOutcome;
        const o = fin.order;
        return (o.status === "completed" ? { status: "completed", amount: o.destination_amount } : { status: o.status === "refunded" ? "refunded" : "failed" }) satisfies DepositOutcome;
      };
      run().then((data) => reply({ id: c.id, ok: true, data })).catch((err) => reply({ id: c.id, ok: false, message: String((err as Error)?.message ?? err) }));
    };
    addEventListener(DEPOSIT_CALL_EVENT, on);
    return () => removeEventListener(DEPOSIT_CALL_EVENT, on);
  }, []);
  return null;
}

/** Google refuses sign-in inside app browsers (X, Telegram, Instagram…): don't offer a button that can't work there. */
const IN_APP = !!currentInApp();

/** Loaded lazily by PrivyProviders (own chunk). Holds no app children: the app talks to Privy via lib/aa/session. */
export default function PrivyMount() {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["email", "google", "twitter", "wallet"].filter((m) => m !== "google" || !IN_APP) as ("email" | "google" | "twitter" | "wallet")[],
        // step 5 board "Sign in, account menu, Hangar signed out": the window in DISCIPLE gold with our mark and words
        appearance: {
          theme: "#14151B", accentColor: "#F2C14E", showWalletLoginFirst: false,
          logo: withBase("/brand/disciple-mark-light.svg"),
          landingHeader: SIGN_IN_COPY.header, loginMessage: SIGN_IN_COPY.line,
        },
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" }, showWalletUIs: false },
        defaultChain: ACTIVE_CHAIN,
        supportedChains: [ACTIVE_CHAIN],
      }}
    >
      <PrivyBridge />
      <FundBridge />
      <DepositBridge />
    </PrivyProvider>
  );
}
