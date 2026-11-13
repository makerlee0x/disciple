/**
 * Browser session for the signed-in owner (Privy embedded EOA by default).
 * Gasless trades: the owner signs a Permit2 witness; the relayer pays ETH (lib/wallet.execGasless).
 * The 4337 smart-account / paymaster / one-tap session-key trade path has been removed.
 */
import { createWalletClient, custom, keccak256, type Address, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ACTIVE_CHAIN } from "../chains";
import { AAError, type GasMode } from "./core";
import { PRIVY_APP_ID, SIGNER_MODE } from "./env";
import type { TradeTiming } from "../trade/timing";

export { PRIVY_APP_ID, SIGNER_MODE };

/** Legacy constants kept so existing imports compile; the 4337 bundler/paymaster routes are deleted. */
export const PAYMASTER_URL = "/api/paymaster";
export const BUNDLER_URL = process.env.NEXT_PUBLIC_AA_BUNDLER_URL || "/api/bundler";
export const SESSION_POLICY: Address | "" = "";
export const DEV_WALLETS = process.env.NEXT_PUBLIC_DEV_WALLETS === "1";
/** Login is available on both Robinhood testnet and mainnet; no bundler required. */
export const aaAvailable = () => ACTIVE_CHAIN.id === 46630 || ACTIVE_CHAIN.id === 4663;

const SPEND_LIMIT_LS = "disciple.oneTap.spendLimitUsd";
const parseSpendLimitUsd = (v: string | undefined | null): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
export const SESSION_SPEND_LIMIT_USD: number | null = parseSpendLimitUsd(process.env.NEXT_PUBLIC_SESSION_SPEND_LIMIT_USD);
export function oneTapSpendLimitUsd(): number | null {
  try { const v = localStorage.getItem(SPEND_LIMIT_LS); if (v !== null) return parseSpendLimitUsd(v); } catch { /* SSR / private mode */ }
  return SESSION_SPEND_LIMIT_USD;
}
export function setOneTapSpendLimitUsd(usd: number | null) {
  try { localStorage.setItem(SPEND_LIMIT_LS, usd && usd > 0 ? String(usd) : "0"); } catch { /* */ }
}

const ONE_TAP_SLIP_LS = "disciple.oneTap.maxSlippageBps";
export const ONE_TAP_SLIPPAGE_CHOICES_BPS = [500, 1500, 3000, 5000] as const;
export const ONE_TAP_SLIPPAGE_DEFAULT_BPS = 1500;
export const SLIPPAGE_DEFAULT_BPS = 500;
export const SLIPPAGE_MIN_BPS = 10;
export const SLIPPAGE_MAX_BPS = 5000;
export const clampSlippageBps = (b: number) => Math.min(SLIPPAGE_MAX_BPS, Math.max(SLIPPAGE_MIN_BPS, Math.round(b) || SLIPPAGE_DEFAULT_BPS));
export function oneTapSlippageBps(): number {
  try { const v = Number(localStorage.getItem(ONE_TAP_SLIP_LS)); if (v > 0) return clampSlippageBps(v); } catch { /* SSR / private mode */ }
  return ONE_TAP_SLIPPAGE_DEFAULT_BPS;
}
export async function setOneTapSlippageBps(bps: number): Promise<void> {
  try { localStorage.setItem(ONE_TAP_SLIP_LS, String(clampSlippageBps(bps))); } catch { /* */ }
}
/** Player slippage setting (bps). No on-chain one-tap session remains; the saved picker value still clamps trades. */
export function sessionMaxSlippageBps(): number | null { return oneTapSlippageBps(); }

export type OwnerKind = "privy" | "eoa" | "local";
const LOCAL_KEY = "disciple.local.ownerKey.v1";
const LS = "disciple.aa.session.v2";
type Stored = { kind: OwnerKind; owner: Address; key?: Hex; expiresAt: number };
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let ownerAcct: LocalAccount | null = null;
let state: Stored | null = null;
const gasListeners = new Set<(m: GasMode, r?: string) => void>();
export function onGasMode(f: (m: GasMode, r?: string) => void) { gasListeners.add(f); f("self-pay"); return () => { gasListeners.delete(f); }; }
const sessListeners = new Set<() => void>();
export function onSessionChange(f: () => void) { sessListeners.add(f); return () => { sessListeners.delete(f); }; }
const changed = () => { sessListeners.forEach((f) => f()); };

function save() { try { if (state) localStorage.setItem(LS, JSON.stringify(state)); else localStorage.removeItem(LS); } catch {} }
function load(): Stored | null { try { const s = JSON.parse(localStorage.getItem(LS) || "null"); return s && s.expiresAt > Date.now() ? s : null; } catch { return null; } }

/** Privy / EOA / local owner login. Returns the owner address (the account that holds funds). */
async function startSession(kind: OwnerKind, owner: LocalAccount, key?: Hex) {
  ownerAcct = owner;
  state = { kind, owner: owner.address, key, expiresAt: Date.now() + SESSION_TTL_MS };
  save();
  changed();
  return owner.address;
}


/** Format a unix-second expiry for leftover one-tap UI (always off after the 4337 path was removed). */
export function fmtSessionExpiry(validUntilSec: number, nowMs = Date.now(), locale?: string, timeZone?: string): string {
  const leftSec = Math.round(validUntilSec - nowMs / 1000);
  if (leftSec <= 0) return "expired";
  const h = Math.floor(leftSec / 3600), m = Math.floor((leftSec % 3600) / 60);
  const left = h >= 1 ? `${h}h${m ? ` ${m}m` : ""}` : `${Math.max(1, m)}m`;
  const at = new Date(validUntilSec * 1000).toLocaleString(locale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone });
  return `${left} left (until ${at})`;
}
export const oneTapAvailable = () => false;
export function oneTapStatus(): { on: boolean; settingUp: boolean; error: string; needsCash: boolean } {
  return { on: false, settingUp: false, error: "", needsCash: false };
}
export async function enableOneTap(_opts: { maxSlippageBps?: number; ttlSec?: number; spendLimitUsd?: number | null } = {}) {
  throw new AAError("Policy", "One-tap session keys were removed; trades are gasless Permit2 from your wallet.");
}
export async function endOneTap() { return null; }
export async function restartOneTap(maxSlippageBps: number) { await setOneTapSlippageBps(maxSlippageBps); return null; }
export function maybeAutoOneTap(_why: string, _opt: { urgent?: boolean } = {}) { /* 4337 one-tap setup removed */ }
export async function syncSessionFromChain() { /* no on-chain session */ }

/** Read-only facts about the signed-in Privy user (profile Settings "Signed in with", Edit profile X row). Never a token. */
export type PrivyAccountInfo = { method: "Email" | "Google" | "X" | "a wallet" | null; email: string | null; xUsername: string | null };
/** Privy MFA (2FA) methods the app offers: authenticator app (TOTP) and passkey. Privy has no PIN method. */
export type PrivyMfaMethod = "totp" | "passkey";
/** Privy's own account-security actions (Settings): export the embedded wallet key, enroll in / remove MFA. */
export type PrivySecurity = {
  /** Opens Privy's export modal for the owner embedded wallet (the key loads in Privy's iframe; the app never sees it). */
  exportWallet: (() => Promise<void>) | null;
  /** MFA methods this user has enrolled (Privy user.mfaMethods). */
  mfaEnrolled: string[];
  /** Opens Privy's MFA enrollment modal (methods offered = the ones enabled for the app in the Privy dashboard). */
  enrollMfa: () => void;
  unenrollMfa: (m: PrivyMfaMethod) => Promise<void>;
};
type PrivyHooks = { /** Privy finished loading (usePrivy().ready) */ ready?: boolean; login: () => void; logout: () => Promise<void>; getAccessToken?: () => Promise<string | null>; getIdentityToken?: () => Promise<string | null>; authenticated?: boolean; account?: PrivyAccountInfo | null; security?: PrivySecurity | null };
let privyHooks: PrivyHooks | null = null;
const privySubs = new Set<() => void>();
export async function setPrivyOwner(owner: LocalAccount): Promise<Address> {
  if (state?.kind === "privy" && state.owner.toLowerCase() === owner.address.toLowerCase() && ownerAcct) return owner.address;
  return startSession("privy", owner);
}
export function registerPrivy(h: PrivyHooks | null) { privyHooks = h; privySubs.forEach((f) => f()); }
export function privyReady() { return !!privyHooks; }
export function onPrivy(f: () => void) { privySubs.add(f); return () => { privySubs.delete(f); }; }
export const privyAuthenticated = () => !!privyHooks?.authenticated;
/** Privy has loaded and knows whether this visitor is signed in. */
export const privyLoaded = () => !!privyHooks?.ready;
/** The signed-in Privy user's login method / email / linked X username, or null (signed out, or not a Privy login). */
export const privyAccount = (): PrivyAccountInfo | null => (privyHooks?.authenticated ? privyHooks.account ?? null : null);
/** Export key / 2FA actions for the signed-in Privy user, or null (signed out, or not a Privy login). */
export const privySecurity = (): PrivySecurity | null => (privyHooks?.authenticated ? privyHooks.security ?? null : null);
export async function privyAccessToken(): Promise<string | null> {
  try { return (await privyHooks?.getAccessToken?.()) ?? null; } catch { return null; }
}
export async function privyIdentityToken(): Promise<string | null> {
  try { return (await privyHooks?.getIdentityToken?.()) ?? null; } catch { return null; }
}
export function privyLogin() {
  if (!privyHooks) throw new Error("Login is still loading — try again in a second.");
  privyHooks.login();
}

export const SESSION_MESSAGE = (owner: Address) =>
  `DISCIPLE sign-in\n\nSign once to unlock your DISCIPLE wallet on ${ACTIVE_CHAIN.name}.\n\nOwner: ${owner}\nVersion: 2`;

export async function eoaLogin(eth: Parameters<typeof custom>[0]): Promise<Address> {
  const w = createWalletClient({ chain: ACTIVE_CHAIN, transport: custom(eth) });
  const [owner] = await w.requestAddresses();
  const sig = await w.signMessage({ account: owner, message: SESSION_MESSAGE(owner) });
  const key = keccak256(sig);
  return startSession("eoa", privateKeyToAccount(key), key);
}

export function localKey(): Hex | null { try { const k = localStorage.getItem(LOCAL_KEY); return k && /^0x[0-9a-fA-F]{64}$/.test(k) ? (k as Hex) : null; } catch { return null; } }
export async function localStart(): Promise<Address> {
  let k = localKey();
  if (!k) { k = generatePrivateKey(); localStorage.setItem(LOCAL_KEY, k); }
  return startSession("local", privateKeyToAccount(k));
}
export async function localImport(k: string): Promise<Address> {
  const key = k.trim().startsWith("0x") ? k.trim() : `0x${k.trim()}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Not a valid private key (64 hex chars).");
  localStorage.setItem(LOCAL_KEY, key);
  return startSession("local", privateKeyToAccount(key as Hex));
}
export function localExport(): Hex | null { return localKey(); }
export async function localReset() { try { localStorage.removeItem(LOCAL_KEY); } catch {} await aaLogout(); }

export async function restore(): Promise<Address | null> {
  if (SIGNER_MODE === "local") { const k = localKey(); if (!k) return null; return startSession("local", privateKeyToAccount(k)); }
  const s = load();
  if (s?.kind === "eoa" && s.key) { try { return await startSession("eoa", privateKeyToAccount(s.key), s.key); } catch { return null; } }
  return null;
}

/** A saved, unexpired session in this browser (before restore runs): the best guess at "signed in" for the first paint. */
export function hasSavedSession(): boolean {
  try {
    const v = JSON.parse(localStorage.getItem(LS) || "null") as Stored | null;
    return !!v?.owner && (!v.expiresAt || v.expiresAt > Date.now());
  } catch { return false; }
}

export function aaSession() {
  return state && ownerAcct ? {
    kind: state.kind, owner: state.owner, expiresAt: state.expiresAt, gasMode: "gasless" as const,
    oneTap: null as null | { entityId: number; validUntil: number; maxSlippageBps: number },
  } : null;
}
export async function aaLogout() {
  const kind = state?.kind;
  state = null; ownerAcct = null; save(); changed();
  if (kind === "privy") { try { await privyHooks?.logout(); } catch {} }
}
/** Owner signs a raw hash (stealth seed / proofs). */
export async function aaOwnerSign(raw: Hex): Promise<{ owner: Address; sig: Hex } | null> {
  if (!ownerAcct) return null;
  const sig = await ownerAcct.sign!({ hash: raw });
  return { owner: ownerAcct.address, sig };
}
/** EOA personal_sign. In gasless mode the shown address is the owner, so identity/chat verify this signature. */
export async function aaSignMessage(message: string): Promise<{ owner: Address; sig: Hex } | null> {
  if (!ownerAcct) return null;
  const sig = await ownerAcct.signMessage({ message });
  return { owner: ownerAcct.address, sig };
}
/** The signed-in owner address (funds + identity in gasless mode). */
export async function aaAddress() { return ownerAcct ? ownerAcct.address : null; }
export function aaOwnerAccount(): LocalAccount | null { return ownerAcct; }

export type LegacyBalances = { account: Address; eth: bigint; tokens: { address: Address; symbol: string; amount: bigint }[] };
/** 4337 LightAccount sweep depended on MAv2; left as a no-op so WalletButton still compiles. */
export async function legacyBalances(): Promise<LegacyBalances | null> { return null; }
export async function sweepLegacy(): Promise<Hex | null> { return null; }

export function aaPeekGasReservePerOp(_kind: "trade" | "gradBuy" = "trade"): bigint | null { return BigInt(0); }
export function aaGasReservePerOp(_kind: "trade" | "gradBuy" = "trade"): bigint { return BigInt(0); }
export async function aaWarm() { /* 4337 warmup removed */ }
export function usdgGasConfig(): undefined { return undefined; }

export const ONE_TAP_SETTING_UP_MSG = "One-tap trading is getting ready. Try again in a few seconds.";
export const ONE_TAP_REFRESH_MSG = "Refreshing one-tap trading. Try again in a few seconds.";

type TradeCtx = { trade?: boolean; timing?: TradeTiming };
let tradeCtx: TradeCtx | undefined;
export function asTrade<T>(timing: TradeTiming | undefined, fn: () => Promise<T>): Promise<T> {
  tradeCtx = { trade: true, timing };
  try { return fn(); } finally { tradeCtx = undefined; }
}

/** Removed with the 4337 trade path. Non-trade sends go through lib/wallet.execCalls (plain EOA, needs ETH). */
export async function aaSend(_calls: unknown, _o0?: unknown, _opts?: unknown): Promise<never> {
  throw new AAError("Policy", "The 4337 trade path has been removed. Use gasless Permit2 trades, or a plain send with ETH for gas.");
}
