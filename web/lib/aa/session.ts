/**
 * Browser session for the embedded smart account (Alchemy Modular Account v2, self-pay gas).
 *  - "privy" (default when NEXT_PUBLIC_PRIVY_APP_ID is set): the Privy embedded EOA (toViemAccount) is the MAv2 owner.
 *    Login/UI lives in components/PrivyProviders.tsx, which hands us the owner via setPrivyOwner().
 *  - "eoa" (dev, NEXT_PUBLIC_DEV_WALLETS=1): an injected wallet signs ONE message; the derived key owns the MAv2.
 *  - "local" (NEXT_PUBLIC_AA_SIGNER=local, or no Privy app id): random key in this browser owns the MAv2 (testnet dev).
 * One-tap trading: the owner installs ONE on-chain session (SingleSigner session key + DiscipleSessionPolicy hooks,
 * PR #53) with a user-chosen max slippage; trade userOps are then signed locally by the session key (no prompt).
 * Without a deployed policy (NEXT_PUBLIC_SESSION_POLICY unset) trades fall back to owner-signed userOps
 * (Privy signs silently: showWalletUIs=false). aa/policy.ts stays as a client-side UX pre-check.
 */
import { createPublicClient, createWalletClient, custom, keccak256, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ACTIVE_CHAIN, MINTABLE_TEST_TOKENS, deployment } from "../chains";
import { ANON_ADDONS } from "../anon";
import { AAError, type Call, type GasMode } from "./core";
import type { Mav2Account, UsdgGasOpts } from "./mav2"; // aa-sdk is loaded lazily (makeAccount) to keep it out of first-load JS
import { newPressId, tagPress, type SendCallsOpts, type SendOpts } from "./fastPath";
import { derivedGasReserve, fallbackUsdgDecimals, type GasOpKind } from "./gasReserve";
import { policyHasPaymaster, policyHasUsdg, SESSION_POLICY_MODULE_ID, cachedSessionUsable, moduleIdAbi, type CachedSession, referralAttributionOn, sessionEligible, sessionPermissions, sessionPolicyFor, usdCapRaw, sessionHasHeadroom, addSpent, parseSpendLimitUsd, SESSION_NO_CAP } from "./oneTap";
import { quotePricerAbi } from "../abi";
import { usdgPriceWadPer1e18Raw } from "../usdg";
import { SESSION_TTL_MS, checkCalls, recordSpend, type SessionState } from "./policy";
import { PRIVY_APP_ID, SIGNER_MODE } from "./env";
import type { TradeTiming } from "../trade/timing";
import { SESSION_PENDING } from "../trade/reservations";
import { SPEND_LIMIT_MSG } from "./relayOp";
import { WATCH_MS } from "../trade/pendingWatch";
import { appReadTransport, withinBudget } from "../rpc/readTransport";
import { cachedHealth, createLoginSetup, isOneTapOff, onchainHealth, renewalDelayMs, setOneTapOff, storageLease, tradeSigner, type SessionHealth } from "./loginSetup";

/** Bundler goes through our server proxy (/api/bundler → Alchemy, no gas policy); override with NEXT_PUBLIC_AA_BUNDLER_URL. */
export const BUNDLER_URL = process.env.NEXT_PUBLIC_AA_BUNDLER_URL || "/api/bundler";
/** Privy app id + signer mode live in ./env (dependency-free, safe for the root layout); re-exported here. */
export { PRIVY_APP_ID, SIGNER_MODE };
/**
 * Deployed DiscipleSessionPolicy: NEXT_PUBLIC_SESSION_POLICY, else the per-chain default from the deployments json
 * (testnet v4: 0x3d36…6e27, moduleId 1.3.0). "" ⇒ no on-chain session keys; owner signs every op (silently with Privy).
 */
export const SESSION_POLICY = sessionPolicyFor(ACTIVE_CHAIN.id);
/** Dev-only: show external-wallet options (EOA owner / plain wallet). */
export const DEV_WALLETS = process.env.NEXT_PUBLIC_DEV_WALLETS === "1";
export const aaAvailable = () => !!BUNDLER_URL && ACTIVE_CHAIN.id === 46630;
/** policy / session reads before a send (checkCalls, getCode, sessionOf): direct RPC with /api/rpc failover */
const publicClient = () => createPublicClient({ chain: ACTIVE_CHAIN, transport: appReadTransport(ACTIVE_CHAIN.rpcUrls.default.http[0]) }) as PublicClient;
/**
 * One-tap session spend limit. Maker (spec 05-gasless-wallet-pill): NO cap by default ⇒ cap0 = cap1 = uint128 max on both
 * quote slots (STRATEGY, USDG). The 5% on-chain price protection (maxSlippageBps) is unaffected. A user can opt in to a
 * $ limit in the wallet menu's Advanced section (saved in this browser; converted to raw units via QuotePricer at install).
 * NEXT_PUBLIC_SESSION_SPEND_LIMIT_USD (optional) sets a deployment-wide default limit; unset = no cap.
 */
const SPEND_LIMIT_LS = "disciple.oneTap.spendLimitUsd";
export const SESSION_SPEND_LIMIT_USD: number | null = parseSpendLimitUsd(process.env.NEXT_PUBLIC_SESSION_SPEND_LIMIT_USD);
/** The opt-in $ limit for new sessions (null = no cap). */
export function oneTapSpendLimitUsd(): number | null {
  try { const v = localStorage.getItem(SPEND_LIMIT_LS); if (v !== null) return parseSpendLimitUsd(v); } catch { /* SSR / private mode */ }
  return SESSION_SPEND_LIMIT_USD;
}
/** Save the opt-in limit (null / 0 = no cap). Applies to the NEXT session (enable / restart). */
export function setOneTapSpendLimitUsd(usd: number | null) {
  try { localStorage.setItem(SPEND_LIMIT_LS, usd && usd > 0 ? String(usd) : "0"); } catch { /* */ }
}
/**
 * Player setting (lee, Oct 30 11:03 CDT): the one-tap session's max price move per trade. DiscipleSessionPolicy stores it
 * per session at install (SessionConfig.maxSlippageBps; 10..MAX_SLIPPAGE_BPS_LIMIT = 5000 on-chain; 0 = its 5% default),
 * so there is no "no limit": the top choice is the contract's ceiling, 50%. Default 15%. Saved in this browser.
 */
const ONE_TAP_SLIP_LS = "disciple.oneTap.maxSlippageBps";
export const ONE_TAP_SLIPPAGE_CHOICES_BPS = [500, 1500, 3000, 5000] as const;
export const ONE_TAP_SLIPPAGE_DEFAULT_BPS = 1500;
/** The chosen max price move for one-tap sessions (bps). */
export function oneTapSlippageBps(): number {
  try { const v = Number(localStorage.getItem(ONE_TAP_SLIP_LS)); if (v > 0) return clampSlippageBps(v); } catch { /* SSR / private mode */ }
  return ONE_TAP_SLIPPAGE_DEFAULT_BPS;
}
/** Save the choice. A live session with a different limit is replaced now (one owner-signed op, same as a renewal). */
export async function setOneTapSlippageBps(bps: number): Promise<void> {
  const b = clampSlippageBps(bps);
  try { localStorage.setItem(ONE_TAP_SLIP_LS, String(b)); } catch { /* */ }
  if (onchain && onchain.validUntil * 1000 > Date.now() + 30_000 && onchain.maxSlippageBps !== b) await restartOneTap(b);
}
/** Auto-install the one-tap session after sign-in (owner signs it silently). NEXT_PUBLIC_ONE_TAP_AUTO=0 disables. */
const ONE_TAP_AUTO = process.env.NEXT_PUBLIC_ONE_TAP_AUTO !== "0";
const sessionOfAbi = [{ type: "function", name: "sessionOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }, { name: "entityId", type: "uint32" }], outputs: [{ type: "tuple", components: [
  { name: "cfg", type: "tuple", components: [
    { name: "validUntil", type: "uint48" }, { name: "validAfter", type: "uint48" }, { name: "permissions", type: "uint256" }, { name: "router", type: "address" },
    { name: "launchpad", type: "address" }, { name: "anonLauncher", type: "address" }, { name: "trampWallManager", type: "address" }, { name: "quote0", type: "address" },
    { name: "quote1", type: "address" }, { name: "cap0", type: "uint128" }, { name: "cap1", type: "uint128" }, { name: "maxSlippageBps", type: "uint16" }, { name: "stealthOwner", type: "address" }] },
  { name: "spent0", type: "uint128" }, { name: "spent1", type: "uint128" }, { name: "active", type: "bool" }] }] }] as const;

/** Slippage the session allows (on-chain maxSlippageBps). Default 5%, user range 0.1%..50%. */
export const SLIPPAGE_DEFAULT_BPS = 500;
export const SLIPPAGE_MIN_BPS = 10;
export const SLIPPAGE_MAX_BPS = 5000;
export const clampSlippageBps = (b: number) => Math.min(SLIPPAGE_MAX_BPS, Math.max(SLIPPAGE_MIN_BPS, Math.round(b) || SLIPPAGE_DEFAULT_BPS));

export type OwnerKind = "privy" | "eoa" | "local";
const LOCAL_KEY = "disciple.local.ownerKey.v1";
const LS = "disciple.aa.session.v2";
const SK = "disciple.aa.sessionKey.v2"; // per-account on-chain session key (testnet; never sent anywhere)
type Stored = SessionState & { kind: OwnerKind; owner: Address; key?: Hex };
type StoredSessionKey = CachedSession;

let sa: Mav2Account | null = null;
let ownerAcct: LocalAccount | null = null;
let state: Stored | null = null;
let onchain: StoredSessionKey | null = null;
const gasListeners = new Set<(m: GasMode, r?: string) => void>();
export function onGasMode(f: (m: GasMode, r?: string) => void) { gasListeners.add(f); f("self-pay"); return () => { gasListeners.delete(f); }; }
const sessListeners = new Set<() => void>();
export function onSessionChange(f: () => void) { sessListeners.add(f); return () => { sessListeners.delete(f); }; }
const changed = () => { sessListeners.forEach((f) => f()); scheduleRenewal(); };

function save() { try { if (state) localStorage.setItem(LS, JSON.stringify(state)); else localStorage.removeItem(LS); } catch {} }
function load(): Stored | null { try { const s = JSON.parse(localStorage.getItem(LS) || "null"); return s && s.expiresAt > Date.now() ? s : null; } catch { return null; } }
function loadSessionKey(account: Address): StoredSessionKey | null {
  try {
    const s = JSON.parse(localStorage.getItem(SK) || "null") as StoredSessionKey | null;
    if (cachedSessionUsable(s, { account, policy: SESSION_POLICY })) return s;
    if (s) localStorage.removeItem(SK); // stale: expired, other account, or an older policy (e.g. 1.1.0) ⇒ reinstall
    return null;
  } catch { return null; }
}

/** ERC-7677 paymaster endpoint (our /api/paymaster); override with NEXT_PUBLIC_PAYMASTER_URL. */
export const PAYMASTER_URL = process.env.NEXT_PUBLIC_PAYMASTER_URL || "/api/paymaster";
/**
 * USDG gas via DisciplePaymaster when the chain has one (NEXT_PUBLIC_RHT_PAYMASTER); unset ⇒ ETH prefund (self-pay).
 * Session keys use it only on a policy that knows the paymaster (moduleId ≥ 1.4.0); older sessions keep paying ETH.
 */
export function usdgGasConfig(): UsdgGasOpts | undefined {
  const d = deployment();
  const pm = d.paymaster, usdg = d.usdg;
  if (!pm || /^0x0{40}$/i.test(pm) || !usdg || /^0x0{40}$/i.test(usdg)) return undefined;
  return { paymaster: pm, usdg, url: PAYMASTER_URL, session: policyHasPaymaster() };
}

async function makeAccount(owner: LocalAccount) {
  const { Mav2Account } = await import("./mav2");
  return new Mav2Account({ chain: ACTIVE_CHAIN, pc: publicClient(), bundlerUrl: BUNDLER_URL, usdgGas: usdgGasConfig() }, owner);
}

async function startSession(kind: OwnerKind, owner: LocalAccount, key?: Hex) {
  sa = await makeAccount(owner);
  ownerAcct = owner;
  state = { kind, owner: owner.address, key, expiresAt: Date.now() + SESSION_TTL_MS, spent: {} };
  save();
  const a = await sa.address();
  curAccount = a;
  userEndedOneTap = isOneTapOff(lsStore(), a);   // the player's own "one-tap off" survives reloads
  void sa.warmGasReserve().catch(() => undefined);   // rapid taps: gasReservePerOp is warm before the first tap
  onchain = loadSessionKey(a);
  if (onchain) { await sa.useSession(onchain.entityId, privateKeyToAccount(onchain.key)); void syncSessionFromChain(); }
  void dripOnce(a);
  // decision 3: deploy + one-tap (new account) or renew (deployed) at sign-in, in the background — never awaited here
  void maybeAutoOneTap("login");
  watchSetupTriggers();
  changed();
  return a;
}
function saveSessionKey() { try { if (onchain) localStorage.setItem(SK, JSON.stringify(onchain)); else localStorage.removeItem(SK); } catch {} }
/**
 * Mirror the on-chain session (caps, spent, active) into the cached key. An inactive / revoked session on chain is
 * dropped here, so the UI never says "one-tap on" for a session the policy would reject (bug #5: stale session check).
 */
export async function syncSessionFromChain() {
  const s0 = onchain; if (!s0 || !SESSION_POLICY) return;
  try {
    const r = await publicClient().readContract({ address: SESSION_POLICY, abi: sessionOfAbi, functionName: "sessionOf", args: [s0.account, s0.entityId] });
    if (onchain !== s0) return;   // changed meanwhile
    if (!r.active) { onchain = null; sa?.clearSession(); saveSessionKey(); changed(); void maybeAutoOneTap("inactive"); return; }
    // Sessions installed against AnonLauncher v1 (before v2 became the default): drop the cached key and reinstall in
    // the background (owner signs silently). Trades keep working meanwhile: no session ⇒ the owner signs them.
    const al = ANON_ADDONS[ACTIVE_CHAIN.id]?.anonLauncher;
    if (al && r.cfg.anonLauncher.toLowerCase() !== al.toLowerCase()) { onchain = null; sa?.clearSession(); saveSessionKey(); changed(); void maybeAutoOneTap("anon-launcher-v2"); return; }
    const caps: Record<string, string> = {}, spent: Record<string, string> = {};
    if (!/^0x0{40}$/i.test(r.cfg.quote0)) { caps[r.cfg.quote0.toLowerCase()] = r.cfg.cap0.toString(); spent[r.cfg.quote0.toLowerCase()] = r.spent0.toString(); }
    if (!/^0x0{40}$/i.test(r.cfg.quote1)) { caps[r.cfg.quote1.toLowerCase()] = r.cfg.cap1.toString(); spent[r.cfg.quote1.toLowerCase()] = r.spent1.toString(); }
    onchain = { ...s0, caps, spent }; saveSessionKey(); changed();
  } catch { /* RPC hiccup: keep the cache; headroom without caps ⇒ owner signs */ }
}

/**
 * New-player cash fix: with USDG gas (DisciplePaymaster) the install op needs cash in the account. A $0 account used to
 * attempt the silent install, fail "not enough USDG" and never retry. Now: no cash ⇒ no attempt, the UI shows
 * "Add cash first to turn on one-tap." (oneTapStatus().needsCash), and a watcher (every 15s + window focus / tab
 * visible + CASH_ARRIVED_EVENT from "Get test cash") retries as soon as the balance goes above `cashFloor`
 * (0, or the balance a USDG-short attempt failed at, so a too-small balance doesn't retry every tick).
 */
let needsCash = false;
let cashFloor = BigInt(0);
let stopCashWatch: (() => void) | null = null;
const CASH_WATCH_MS = 15_000;
const usdgBalAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }] as const;
function watchForCash() {
  if (stopCashWatch || typeof window === "undefined") return;
  const tick = () => { if (!needsCash || !sa) { stopCashWatch?.(); return; } void maybeAutoOneTap("cash-arrived"); };
  const vis = () => { if (document.visibilityState === "visible") tick(); };
  const i = window.setInterval(tick, CASH_WATCH_MS);
  window.addEventListener("focus", tick);
  window.addEventListener("disciple:cash", tick);   // lib/testCash CASH_ARRIVED_EVENT
  document.addEventListener("visibilitychange", vis);
  stopCashWatch = () => {
    window.clearInterval(i); window.removeEventListener("focus", tick); window.removeEventListener("disciple:cash", tick);
    document.removeEventListener("visibilitychange", vis); stopCashWatch = null;
  };
}
function setNeedsCash(floor: bigint, why: string) {
  if (!needsCash) console.warn(`[disciple] one-tap: skipping silent session install (${why}): USDG balance ${floor} raw covers no gas; waiting for cash`);
  needsCash = true; cashFloor = floor;
  watchForCash();
}
function clearNeedsCash() { needsCash = false; cashFloor = BigInt(0); stopCashWatch?.(); }
/* ---------- automatic one-tap: set up at sign-in (bug #5, lee's decision 3) ----------
 * lib/aa/loginSetup does the deciding (dedupe per account, cross-tab lease, failure backoff, cool-down); this wires
 * it to the account: not deployed ⇒ ONE owner-signed op = deploy + install session (enableOneTap → sendCalls("owner")
 * carries the factory while undeployed, same relay path as every one-tap install); deployed ⇒ renew a session that is
 * missing / expired / expiring / inactive / installed on another policy address. Logs only via console.warn.
 */
let curAccount: Address | null = null;
const lsStore = () => { try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; } };
const TAB_ID = Math.random().toString(36).slice(2);
/** One gas top-up per account per page (self-pay): the deploy op waits for it; the plain login drip shares it. */
const dripping = new Map<string, Promise<boolean>>();
function dripOnce(a: Address): Promise<boolean> {
  const k = a.toLowerCase();
  let p = dripping.get(k);
  if (!p) { p = refillGas(a); dripping.set(k, p); }
  return p;
}
/** Session health for a deployed account: cached key (policy address + expiry), then sessionOf on the CONFIGURED policy. */
async function sessionHealthFor(a: Address): Promise<SessionHealth> {
  if (!sa) return "missing";
  if (!onchain) {
    // another tab may have installed one meanwhile (shared localStorage): adopt it instead of installing a second
    let raw: StoredSessionKey | null = null;
    try { raw = JSON.parse(localStorage.getItem(SK) || "null"); } catch { /* */ }
    const h = cachedHealth(raw, { account: a, policy: SESSION_POLICY });
    if (h !== "live" && h !== "expiring") {
      if (raw) console.warn("[disciple] one-tap: cached session not usable", { health: h, cachedPolicy: raw.policy, policy: SESSION_POLICY });
      return h;
    }
    const k = loadSessionKey(a);
    if (k) { onchain = k; await sa.useSession(k.entityId, privateKeyToAccount(k.key)); changed(); }
    else return "missing";
  }
  const s0 = onchain!;
  const cached = cachedHealth(s0, { account: a, policy: SESSION_POLICY });
  let chain: { active: boolean; validUntil?: number } | undefined;
  if (cached === "live" || cached === "expiring") {
    try {
      const r = await publicClient().readContract({ address: SESSION_POLICY as Address, abi: sessionOfAbi, functionName: "sessionOf", args: [s0.account, s0.entityId] });
      chain = { active: r.active, validUntil: Number(r.cfg.validUntil) || undefined };
    } catch { chain = undefined; }
  }
  let h = onchainHealth(cached, chain, { policy: SESSION_POLICY });
  // a live session at a different max price move than the player's setting (e.g. an old 5% session) is renewed like an
  // expiring one: the background setup installs a new session at the setting (old key stays until replaced)
  if (h === "live" && s0.maxSlippageBps !== oneTapSlippageBps()) {
    console.warn("[disciple] one-tap: session slippage differs from the setting; renewing", { session: s0.maxSlippageBps, setting: oneTapSlippageBps() });
    h = "expiring";
  }
  if (h !== "live" && h !== "expiring" && onchain === s0) {
    // dead key (expired / inactive / other policy): drop it so the UI and the trade path don't use it meanwhile
    console.warn("[disciple] one-tap: session needs renewing", { health: h, cachedPolicy: s0.policy, policy: SESSION_POLICY });
    onchain = null; sa?.clearSession(); saveSessionKey(); changed();
  }
  return h;
}
const loginSetup = createLoginSetup({
  now: () => Date.now(),
  enabled: () => ONE_TAP_AUTO && oneTapAvailable() && !!sa && !!state && state.kind !== "eoa",
  oneTapOff: (a) => userEndedOneTap || isOneTapOff(lsStore(), a),
  deployed: async (a) => {
    if (!sa) return undefined;
    if (sa.deployed === true) return true;   // set by our own landed op: no public-RPC read right after it (may lag)
    // viem getCode resolves undefined for an address with no code (not deployed); only a failed read is "unknown"
    const code = await publicClient().getCode({ address: a as Address }).catch(() => null);
    if (code === null) return undefined;
    sa.deployed = !!code && code !== "0x";
    return sa.deployed;
  },
  health: (a) => sessionHealthFor(a as Address),
  prepare: (a) => dripOnce(a as Address),
  install: async (a, o) => {
    const acct = sa;
    if (!acct || (await acct.address()).toLowerCase() !== a.toLowerCase()) throw new Error("signed out meanwhile");
    console.warn("[disciple] one-tap setup at sign-in", { why: o.why, deploy: o.deploy, health: o.health ?? "undeployed" });
    // renew uses the player's one-tap max price move setting (default 15%); spend limit from their saved setting (unchanged)
    await enableOneTap({ maxSlippageBps: oneTapSlippageBps() });
  },
  lease: storageLease(lsStore(), TAB_ID),
  warn: (m, d) => console.warn(m, d),
  schedule: (ms, run) => { if (typeof window !== "undefined") setTimeout(run, Math.min(ms, 2 ** 31 - 1)); },
  onChange: () => changed(),
});
/** Background one-tap setup / renewal for the signed-in account. Idempotent, deduped, never throws. */
export function maybeAutoOneTap(why: string, opt: { urgent?: boolean } = {}) {
  const acct = sa;
  if (!acct) return;
  void acct.address().then(async (a) => {
    if (sa !== acct) return;
    // USDG gas: the install op is paid from cash ⇒ no cash, no attempt (needsCash + watcher above retry when it lands)
    const usdgGas = usdgGasConfig();
    if (usdgGas) {
      const bal = await publicClient().readContract({ address: usdgGas.usdg, abi: usdgBalAbi, functionName: "balanceOf", args: [a] }).catch(() => null);
      if (bal === null || sa !== acct) return;   // RPC hiccup: the next trigger (login, trade, cash watcher) retries
      if (bal <= cashFloor) { setNeedsCash(cashFloor, why); return; }
    }
    const out = await loginSetup.ensure(a, why, why === "cash-arrived" ? { ...opt, urgent: true } : opt);
    if (out === "deployed+installed" || out === "renewed") clearNeedsCash();
    else if (out === "failed" && usdgGas && /not enough usdg|FundAccount/i.test(loginSetup.lastError(a))) {
      // cash too low for the install's network cost: wait for MORE cash (not every tick at the same balance)
      const bal = await publicClient().readContract({ address: usdgGas.usdg, abi: usdgBalAbi, functionName: "balanceOf", args: [a] }).catch(() => BigInt(0));
      setNeedsCash(bal, `${why}: ${loginSetup.lastError(a)}`);
    }
  }).catch(() => undefined);
}
/** Re-check on tab refocus (deduped) and renew ahead of expiry while the tab stays open (FLOW's scheduleRenewal shape). */
let triggersOn = false;
function watchSetupTriggers() {
  if (triggersOn || typeof document === "undefined") return;
  triggersOn = true;
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") maybeAutoOneTap("refocus"); });
}
let renewTimer: ReturnType<typeof setTimeout> | undefined;
let renewFor = 0;
function scheduleRenewal() {
  if (typeof window === "undefined") return;
  const vu = onchain?.validUntil ?? 0;
  if (vu === renewFor) return;
  if (renewTimer) clearTimeout(renewTimer);
  renewTimer = undefined; renewFor = vu;
  if (!vu || !ONE_TAP_AUTO || userEndedOneTap) return;
  renewTimer = setTimeout(() => { if (onchain?.validUntil === vu) maybeAutoOneTap("renew-ahead"); }, Math.min(renewalDelayMs(vu), 2 ** 31 - 1));
}
/**
 * One-tap state for the UI: on (session key signs), setting-up (auto install in flight), needsCash (no cash yet: show
 * "Add cash first to turn on one-tap." + Deposit), or off (owner signs, silently).
 */
export function oneTapStatus(): { on: boolean; settingUp: boolean; error: string; needsCash: boolean } {
  return { on: !!onchain, settingUp: loginSetup.busy(curAccount), error: needsCash ? "" : loginSetup.lastError(curAccount), needsCash: !onchain && needsCash };
}
/**
 * AA21 fix: the account pays every op's gas PREFUND (gas × maxFee ≈ 0.00011 ETH per trade) from its balance + EntryPoint
 * deposit. Once that's below one prefund every trade fails "AA21 didn't pay prefund" (nothing is sent). Ask /api/drip for
 * a refill (server checks balance + deposit < low-water mark and rate-limits), wait for it to land, and retry ONCE with a
 * fresh nonce key. No refill available ⇒ the original FundAccount error.
 */
async function sendWithGasRefill(calls: Call[], as: "owner" | "session", me: Address, o: SendCallsOpts = {}) {
  try { return await sa!.sendCalls(calls, { ...o, as }); }
  catch (e) {
    // a USDG shortfall (USDG-paid network cost) can't be fixed by an ETH refill: surface "Not enough USDG" as is
    if ((e as AAError).code !== "FundAccount" || (e as AAError).extra?.usdg || !(await refillGas(me))) throw e;
    return sa!.sendCalls(calls, { ...o, as });
  }
}
/** Awaited refill (see sendWithGasRefill). true ⇒ a top-up landed. */
export async function refillGas(a: Address): Promise<boolean> {
  if (ACTIVE_CHAIN.id !== 46630) return false;
  try {
    const r = await fetch("/api/drip", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: a }) });
    const j = await r.json().catch(() => ({})) as { ok?: boolean; txHash?: Hex };
    if (!j.ok || !j.txHash) return false;
    await publicClient().waitForTransactionReceipt({ hash: j.txHash, timeout: 20_000 });
    return true;
  } catch { return false; }
}
/** One-time server top-up of test ETH for gas (self-pay, existing drip faucet). Fire-and-forget. */
export function drip(a: Address) {
  if (ACTIVE_CHAIN.id !== 46630) return;
  void dripOnce(a);   // shared with the sign-in deploy (one top-up request per account per page)
}

/* ---------- Privy embedded wallet owner ---------- */
/** Called by PrivyProviders once the embedded wallet is ready (owner = toViemAccount(wallet)). */
export async function setPrivyOwner(owner: LocalAccount): Promise<Address> {
  if (sa && state?.kind === "privy" && state.owner.toLowerCase() === owner.address.toLowerCase()) return sa.address();
  return startSession("privy", owner);
}
type PrivyHooks = { login: () => void; logout: () => Promise<void>; getAccessToken?: () => Promise<string | null>; authenticated?: boolean };
let privyHooks: PrivyHooks | null = null;
const privySubs = new Set<() => void>();
export function registerPrivy(h: PrivyHooks | null) { privyHooks = h; privySubs.forEach((f) => f()); }
export function privyReady() { return !!privyHooks; }
/** Privy session state changes (ready / login / logout). */
export function onPrivy(f: () => void) { privySubs.add(f); return () => { privySubs.delete(f); }; }
export const privyAuthenticated = () => !!privyHooks?.authenticated;
/** Current Privy access token (auto-refreshed by Privy) for our own API routes; null when logged out / no Privy. */
export async function privyAccessToken(): Promise<string | null> {
  try { return (await privyHooks?.getAccessToken?.()) ?? null; } catch { return null; }
}
/** Opens the Privy login modal (email / Google). The address arrives via setPrivyOwner when the wallet is ready. */
export function privyLogin() {
  if (!privyHooks) throw new Error("Login is still loading — try again in a second.");
  privyHooks.login();
}

export const SESSION_MESSAGE = (owner: Address) =>
  `DISCIPLE one-tap trading\n\nSign once to unlock your DISCIPLE smart account on ${ACTIVE_CHAIN.name}.\nThis creates a session key scoped to DISCIPLE contracts.\n\nOwner: ${owner}\nVersion: 1`;

/** Dev: existing wallet as owner — one signature ⇒ deterministic key ⇒ same smart account every time. */
export async function eoaLogin(eth: Parameters<typeof custom>[0]): Promise<Address> {
  const w = createWalletClient({ chain: ACTIVE_CHAIN, transport: custom(eth) });
  const [owner] = await w.requestAddresses();
  const sig = await w.signMessage({ account: owner, message: SESSION_MESSAGE(owner) });
  const key = keccak256(sig);
  return startSession("eoa", privateKeyToAccount(key), key);
}

/* ---------- local browser-key owner (testnet dev) ---------- */
export function localKey(): Hex | null { try { const k = localStorage.getItem(LOCAL_KEY); return k && /^0x[0-9a-fA-F]{64}$/.test(k) ? (k as Hex) : null; } catch { return null; } }
export async function localStart(): Promise<Address> {
  let k = localKey();
  if (!k) { k = generatePrivateKey(); localStorage.setItem(LOCAL_KEY, k); }
  return startSession("local", privateKeyToAccount(k));
}
export async function localImport(k: string): Promise<Address> {
  const key = k.trim().startsWith("0x") ? k.trim() : `0x${k.trim()}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Not a valid private key (64 hex chars).");
  privateKeyToAccount(key as Hex);
  localStorage.setItem(LOCAL_KEY, key);
  return startSession("local", privateKeyToAccount(key as Hex));
}
export function localExport(): Hex | null { return localKey(); }
export async function localReset() { try { localStorage.removeItem(LOCAL_KEY); } catch {} await aaLogout(); }

/** Restore a live session on reload (no prompts). Privy sessions are restored by PrivyProviders. */
export async function restore(): Promise<Address | null> {
  if (SIGNER_MODE === "local") { const k = localKey(); if (!k) return null; return startSession("local", privateKeyToAccount(k)); }
  const s = load();
  if (s?.kind === "eoa" && s.key) { try { return await startSession("eoa", privateKeyToAccount(s.key), s.key); } catch { return null; } }
  return null;
}

export function aaSession() {
  return state && sa ? {
    kind: state.kind, owner: state.owner, expiresAt: state.expiresAt, gasMode: sa.gasMode,
    oneTap: onchain ? { entityId: onchain.entityId, validUntil: onchain.validUntil, maxSlippageBps: onchain.maxSlippageBps } : null,
  } : null;
}
export async function aaLogout() {
  const kind = state?.kind;
  state = null; sa = null; ownerAcct = null; onchain = null; loginSetup.reset(); curAccount = null; clearNeedsCash(); save(); changed();
  if (kind === "privy") { try { await privyHooks?.logout(); } catch {} }
}
/** Owner signs a raw hash (chat login / username proof). Null when no smart session. */
export async function aaOwnerSign(raw: Hex): Promise<{ owner: Address; sig: Hex } | null> { return sa ? { owner: sa.ownerAddress, sig: await sa.signOwnerRaw(raw) } : null; }
/**
 * Smart-account signature over a plain message: ERC-1271 once deployed, ERC-6492-wrapped while counterfactual.
 * Servers verify it with viem verifyMessage (lib/aa/verify.ts). `owner` is sent for legacy compatibility only.
 */
export async function aaSignMessage(message: string): Promise<{ owner: Address; sig: Hex } | null> {
  return sa ? { owner: sa.ownerAddress, sig: await sa.signMessage(message) } : null;
}
export async function aaAddress() { return sa ? sa.address() : null; }

/* ---------- TEMP (testnet): sweep the pre-Privy LightAccount v2 of the SAME owner key into the new MAv2 ---------- */
// Remove once testnet users have migrated. Only "local"/"eoa" owners can match: Turnkey-owned accounts have a different key.
export type LegacyBalances = { account: Address; eth: bigint; tokens: { address: Address; symbol: string; amount: bigint }[] };
const sweepTokens = () => {
  const d = deployment();
  const seen = new Set<string>(); const out: { address: Address; symbol: string }[] = [];
  for (const t of [...MINTABLE_TEST_TOKENS, { address: d.defaultQuote, symbol: "STRATEGY" }, { address: d.usdg, symbol: "USDG" }])
    if (!seen.has(t.address.toLowerCase()) && !/^0x0{40}$/i.test(t.address)) { seen.add(t.address.toLowerCase()); out.push({ address: t.address, symbol: t.symbol }); }
  return out;
};
const balAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }] as const;
/** Old LightAccount for the current owner, with balances; null if none / empty / not testnet. */
export async function legacyBalances(): Promise<LegacyBalances | null> {
  if (!ownerAcct || !sa || ACTIVE_CHAIN.id !== 46630) return null;
  const pc = publicClient();
  const { LIGHT_ACCOUNT_V2_FACTORY, factoryAbi } = await import("./core");
  const account = await pc.readContract({ address: LIGHT_ACCOUNT_V2_FACTORY, abi: factoryAbi, functionName: "getAddress", args: [ownerAcct.address, BigInt(0)] });
  if (account.toLowerCase() === (await sa.address()).toLowerCase()) return null;
  const [eth, ...amts] = await Promise.all([pc.getBalance({ address: account }), ...sweepTokens().map((t) => pc.readContract({ address: t.address, abi: balAbi, functionName: "balanceOf", args: [account] }).catch(() => BigInt(0)))]);
  const tokens = sweepTokens().map((t, i) => ({ ...t, amount: amts[i] as bigint })).filter((t) => t.amount > BigInt(0));
  return eth > BigInt(0) || tokens.length ? { account, eth, tokens } : null;
}
/** Old account (self-pay, owner-signed) sends known tokens + ETH (minus a gas reserve) to the new MAv2 in ONE userOp. */
export async function sweepLegacy() {
  const lb = await legacyBalances();
  if (!lb || !ownerAcct || !sa) return null;
  const { LightSmartAccount, alchemyBundler } = await import("./core");
  const { encodeFunctionData, parseAbi } = await import("viem");
  const to = await sa.address();
  const pc = publicClient();
  const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
  const calls: Call[] = lb.tokens.map((t) => ({ to: t.address, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [to, t.amount] }) }));
  const blk = await pc.getBlock();
  const { clientFees } = await import("./gasPolicy");
  const reserve = clientFees(blk.baseFeePerGas ?? BigInt(0)).maxFeePerGas * BigInt(800_000); // worst-case gas for this op (same fee formula as LightSmartAccount.selfPayGas)
  if (lb.eth > reserve * BigInt(2)) calls.push({ to, data: "0x", value: lb.eth - reserve });
  if (!calls.length) throw new AAError("FundAccount", "Your old account is empty — nothing to move over.");
  const old = new LightSmartAccount({ pc, chainId: ACTIVE_CHAIN.id, bundler: alchemyBundler(BUNDLER_URL), owner: ownerAcct });
  return old.sendCalls(calls);
}

/* ---------- on-chain one-tap session (DiscipleSessionPolicy, PR #53) ---------- */
export const oneTapAvailable = () => !!SESSION_POLICY && ACTIVE_CHAIN.id === 46630;

/**
 * Owner approves ONE userOp: installValidation(SingleSigner(sessionKey) + DiscipleSessionPolicy hooks).
 * After this, aaSend signs trades with the session key (no Privy prompt) until validUntil.
 */
export async function enableOneTap(opts: { maxSlippageBps?: number; ttlSec?: number; spendLimitUsd?: number | null } = {}) {
  if (!sa || !state) throw new AAError("Policy", "Sign in first.");
  if (!SESSION_POLICY) throw new AAError("Policy", "One-tap sessions aren't live yet (session policy not deployed).");
  const sk = await import("@disciple/session-keys");
  const { getDefaultSingleSignerValidationModuleAddress, getDefaultTimeRangeModuleAddress } = await import("@account-kit/smart-contracts/experimental");
  const d = deployment();
  const id = await publicClient().readContract({ address: SESSION_POLICY, abi: moduleIdAbi, functionName: "moduleId" }).catch(() => "");
  if (id !== SESSION_POLICY_MODULE_ID) throw new AAError("Policy", `Session policy at ${SESSION_POLICY} reports "${id || "?"}", expected ${SESSION_POLICY_MODULE_ID}.`);
  const key = generatePrivateKey();
  const maxSlippageBps = clampSlippageBps(opts.maxSlippageBps ?? oneTapSlippageBps());
  const account = await sa.address();
  const caps = await sessionCaps(opts.spendLimitUsd !== undefined ? opts.spendLimitUsd : oneTapSpendLimitUsd());
  // AUDIT #148 M-1: validUntil from the chain's clock (latest block), not the browser's; Date.now() only if the RPC fails.
  const now = await sk.chainNow(publicClient());
  const s = sk.buildCreateSession({
    now,
    modules: { policy: SESSION_POLICY, singleSigner: getDefaultSingleSignerValidationModuleAddress(ACTIVE_CHAIN), timeRange: getDefaultTimeRangeModuleAddress(ACTIVE_CHAIN) },
    targets: { router: d.router, launchpad: d.launchpad, anonLauncher: ANON_ADDONS[ACTIVE_CHAIN.id]?.anonLauncher, trampWallManager: d.trampWallManager },
    sessionSigner: privateKeyToAccount(key).address,
    caps: [{ token: caps[0].token, cap: caps[0].cap }, { token: caps[1].token, cap: caps[1].cap }],
    ttlSec: opts.ttlSec ?? SESSION_TTL_MS / 1000, maxSlippageBps,
    permissions: sessionPermissions(sk.TRADE_PERMS), // + P_REFERRAL when NEXT_PUBLIC_REFERRAL_ATTRIBUTE=1
  });
  const r = await sa.sendCalls([{ to: account, data: s.data }], "owner");
  onchain = { account, entityId: s.entityId, key, validUntil: s.validUntil, maxSlippageBps, policy: SESSION_POLICY,
    caps: Object.fromEntries(caps.map((c) => [c.token.toLowerCase(), c.cap.toString()])), spent: {} };
  saveSessionKey(); userEndedOneTap = false; setOneTapOff(lsStore(), account, false);
  await sa.useSession(s.entityId, privateKeyToAccount(key));
  changed();
  return { ...r, entityId: s.entityId, validUntil: s.validUntil, maxSlippageBps };
}

/**
 * Raw caps for both quote slots (STRATEGY, USDG). No limit (default) ⇒ SESSION_NO_CAP (uint128 max) on BOTH: a zero cap or
 * zero quote address would block spending on-chain. Opt-in $ limit ⇒ $ → raw via QuotePricer.quotePriceUsd and decimals
 * (USDG falls back to $1 if the pricer can't price it).
 */
async function sessionCaps(limitUsd: number | null): Promise<[{ token: Address; cap: bigint }, { token: Address; cap: bigint }]> {
  const d = deployment(), pc = publicClient();
  if (!limitUsd) return [{ token: d.defaultQuote, cap: SESSION_NO_CAP }, { token: d.usdg, cap: SESSION_NO_CAP }];
  // px = USD WAD per 1e18 raw (decimal-agnostic), so the cap needs no decimals() read — and no guessed-18 fallback
  const one = async (token: Address, fallbackUsdWad?: bigint) => {
    const px = await pc.readContract({ address: d.quotePricer, abi: quotePricerAbi, functionName: "quotePriceUsd", args: [token] })
      .then((v) => v as bigint).catch(() => fallbackUsdWad ?? BigInt(0));
    return { token, cap: usdCapRaw(limitUsd, px) };
  };
  // USDG falls back to $1 = 10^(36 − usdgDecimals) (QuotePricer units: USD WAD per 1e18 raw)
  const out = await Promise.all([one(d.defaultQuote), one(d.usdg, usdgPriceWadPer1e18Raw())] as const);
  if (out.some((c) => c.cap <= BigInt(0))) throw new AAError("Policy", "Couldn't price your spend limit right now — try again in a moment.");
  return out;
}

/** Active on-chain session's max slippage (bps), or null (no session / policy not deployed ⇒ no clamp). */
export function sessionMaxSlippageBps(): number | null {
  return onchain && onchain.validUntil * 1000 > Date.now() + 30_000 ? onchain.maxSlippageBps : null;
}
/** Replace the session with one allowing a higher max slippage (owner signs: uninstall old, install new). */
export async function restartOneTap(maxSlippageBps: number) {
  await endOneTap();
  return enableOneTap({ maxSlippageBps });
}

/** Owner removes the session (validation + hooks, storage cleared). */
export async function endOneTap() {
  if (!sa || !onchain || !SESSION_POLICY) return null;
  const sk = await import("@disciple/session-keys");
  const { getDefaultSingleSignerValidationModuleAddress, getDefaultTimeRangeModuleAddress } = await import("@account-kit/smart-contracts/experimental");
  const data = sk.buildUninstallSession(onchain.entityId, { policy: SESSION_POLICY, singleSigner: getDefaultSingleSignerValidationModuleAddress(ACTIVE_CHAIN), timeRange: getDefaultTimeRangeModuleAddress(ACTIVE_CHAIN) });
  const r = await sa.sendCalls([{ to: await sa.address(), data }], "owner");
  onchain = null; sa.clearSession(); userEndedOneTap = true;   // the user ended it on purpose: no auto-reinstall, on this page or after a reload
  setOneTapOff(lsStore(), await sa.address(), true);
  saveSessionKey();
  changed();
  return r;
}

/**
 * Rapid taps (GAME cash reservation), SYNC, USDG base units: what one pending op may still take for gas.
 *   reserve = liveCash − Σ pending (amountIn + aaGasReservePerOp())
 * peek: the WARM value (fresh allowance: its real maxTokenCost; grad buys: the per-op bound) or null while cold;
 * 0n when gas isn't paid in USDG. kind: "trade" (buy / sell, default) | "gradBuy". See lib/aa/gasReserve.
 */
export function aaPeekGasReservePerOp(kind: GasOpKind = "trade"): bigint | null {
  if (sa) return sa.peekGasReservePerOp(kind);
  return usdgGasConfig() ? null : BigInt(0);
}
/** Never null: warm value, else derived from gas limit × allowance-formula maxFee(gas price) × rate (config before any RPC). */
export function aaGasReservePerOp(kind: GasOpKind = "trade"): bigint {
  if (sa) return sa.gasReservePerOp(kind);
  return usdgGasConfig() ? derivedGasReserve({ kind, decimals: fallbackUsdgDecimals(ACTIVE_CHAIN.id) }) : BigInt(0);
}

/** Keep the smart account hot: clients + deployment status + fee cache (client) and relayer nonce/fees (server). */
export async function aaWarm() {
  if (!sa) return;
  await Promise.all([
    sa.warm(),
    fetch("/api/bundler", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "disciple_warm", params: [await sa.address().catch(() => undefined)] }) }).catch(() => undefined),
  ]);
}

/** The cached session key is installed, unexpired (30 s margin) and loaded in the account client. */
function sessionLive() {
  return !!(sa?.hasSession && onchain && onchain.validUntil * 1000 >= Date.now() + 30_000);
}
/** The session policy (client mirror) would accept these calls — independent of whether a session exists right now. */
async function sessionCallsEligible(calls: Call[]) {
  return sessionEligible(calls, { referral: referralAttributionOn(), registry: deployment().referralRegistry, usdg: policyHasUsdg() ? deployment().usdg : undefined, router: deployment().router });
}

/* ---------- session-only trades (latency plan #6) ----------
 * Trades sign with the one-tap session key only: no silent fallback to the Privy owner (an extra signing hop, and
 * after a rejected session pre-flight a whole second send). When the session is missing / expired / inactive the
 * trade is refused with a plain line, one-tap is (re)installed in the background (owner-signed install, same policy,
 * same caps — nothing widens), and the next tap goes through. A brand-new account no longer owner-signs its first
 * (deploying) trade: one-tap is set up at sign-in (deploy + session in one op, lee's decision 3), and a tap that beats
 * that setup gets the same "getting ready" line instead of an owner-signed trade. Kept on the owner (lee's decision 4):
 *  - a player who turned one-tap off themselves (endOneTap; persisted per account);
 *  - calls the session policy doesn't cover at all, and a player-chosen spend limit that's used up (bug #1: never
 *    refuse for the spend limit) — both logged to the console;
 *  - NEXT_PUBLIC_TRADE_OWNER_FALLBACK=1 (escape hatch: the old behaviour), no session policy on this chain,
 *    NEXT_PUBLIC_ONE_TAP_AUTO=0, or a deployment status we can't read (RPC hiccup: never block on it).
 * The decision itself is lib/aa/loginSetup tradeSigner (unit-tested).
 */
// Approved copy (lee, decision 2)
export const ONE_TAP_SETTING_UP_MSG = "One-tap trading is getting ready. Try again in a few seconds.";
// Copy approved by lee 2026-10-24
export const ONE_TAP_REFRESH_MSG = "Refreshing one-tap trading. Try again in a few seconds.";
const TRADE_OWNER_FALLBACK = process.env.NEXT_PUBLIC_TRADE_OWNER_FALLBACK === "1";
let userEndedOneTap = false;
/** Session-only mode for this signer, and the account's deployment status (undefined = can't tell right now). */
async function strictSessionTrades(me: Address): Promise<{ strict: boolean; deployed: boolean | undefined }> {
  if (TRADE_OWNER_FALLBACK || !ONE_TAP_AUTO || !oneTapAvailable() || !sa || !state || state.kind === "eoa" || userEndedOneTap) return { strict: false, deployed: sa?.deployed };
  if (sa.deployed === undefined) {
    // bounded (job 9): unknown after 1 s ⇒ stays undefined (re-asked next tap), never a stalled tap
    const code = await withinBudget(publicClient().getCode({ address: me }), 1000, "getCode").catch(() => null);   // undefined = no code (viem)
    if (code !== null) sa.deployed = !!code && code !== "0x";
  }
  return { strict: true, deployed: sa.deployed };
}
/** Drop a dead session (expired / inactive) and start (or join) the background setup — urgent: a player is waiting. */
function renewOneTap(why: string) {
  if (onchain && onchain.validUntil * 1000 < Date.now() + 30_000) { onchain = null; sa?.clearSession(); saveSessionKey(); changed(); }
  maybeAutoOneTap(why, { urgent: true });
}
/** Quote the batch moves out of the account (capped quotes only), from its exact approvals (raw, lowercase token). */
function quoteSpend(delta: Record<string, bigint>): Record<string, bigint> {
  const d = deployment(), q = new Set([d.defaultQuote, d.usdg].map((a) => a.toLowerCase()));
  return Object.fromEntries(Object.entries(delta).filter(([t]) => q.has(t.toLowerCase())));
}
/** Policy reverts we can recover from by letting the owner sign instead (nothing landed: pre-flight/simulation). */
const SPEND_CAP_REVERT = /SpendCapExceeded|b92251e1/i;
const POLICY_RECOVERABLE = /0xa6dfc94a|0xf9be14df|0x1fd05a4a|0x74a1a72c|SpendCapExceeded|SessionInactive|SessionExpired|PreExecHookReverted|AA2[234]/i;

/**
 * Trade context without touching lib/wallet.execCalls (GAME #138 hooks those lines): asTrade() sets it, calls fn
 * synchronously, and clears it before returning; execCalls → aaSend runs synchronously up to aaSend's first line,
 * which takes it. Anything that isn't a trade (withdraw, claims, one-tap install, mints) never sees it.
 */
type TradeCtx = { trade?: boolean; timing?: TradeTiming };
let tradeCtx: TradeCtx | undefined;
function takeTradeCtx() { const c = tradeCtx; tradeCtx = undefined; return c; }
export function asTrade<T>(timing: TradeTiming | undefined, fn: () => Promise<T>): Promise<T> {
  tradeCtx = { trade: true, timing };
  try { return fn(); } finally { tradeCtx = undefined; }
}

/**
 * One userOp for the whole call list. Signer: the one-tap session key when the policy allows the calls AND the session
 * budget has headroom; otherwise the owner (Privy embedded wallet, signs silently). Never refuses for "spend limit":
 * an exhausted session just means the owner signs (bug #1). Trades (`opts.trade`) are session-only once the account is
 * deployed — see "session-only trades" above.
 */
/**
 * opts: trade context from asTrade() (session-only trades, timing), taken when not passed.
 * GAME: `o0.pressId` is the caller's reservation id (optional; generated when absent). It is reused on every retry
 * (fee floor, TRANSIENT_SIM rebuild, gas refill, owner fallback) and echoed on every "disciple:op" event
 * (submitted/confirmed/error), on SendResult.pressId, and on every thrown error (AAError.extra.pressId / err.pressId).
 */
export async function aaSend(calls: Call[], o0: SendOpts = {}, opts: TradeCtx = takeTradeCtx() ?? {}) {
  const o: SendOpts = { ...o0, pressId: o0.pressId ?? newPressId() };   // one press: refill retry + owner fallback share it
  try { return await aaSend1(calls, o, opts); } catch (e) { tagPress(e, o.pressId!); throw e; }
}
async function aaSend1(calls: Call[], o: SendOpts, opts: TradeCtx) {
  if (!sa || !state) throw new AAError("Policy", "Sign in first.");
  const d = deployment();
  const me = await sa.address();
  // Client mirror of the session policy: decides whether the SESSION KEY may sign. A call outside it (withdraw transfer,
  // claims on other contracts, …) is not an error — the owner signs it (it's the account's owner).
  let policyOk = true;
  const delta = await checkCalls(publicClient(), {
    launchpad: d.launchpad, router: d.router, trampWallManager: d.trampWallManager,
    mintable: MINTABLE_TEST_TOKENS.map((t) => t.address), spendTokens: [d.defaultQuote, d.usdg],
    usdg: policyHasUsdg() ? d.usdg : undefined,
    feeRouter: d.feeRouter,
    usdgDepositNotifier: /^0x0{40}$/i.test(d.usdgDepositNotifier) ? undefined : d.usdgDepositNotifier,
    referralRegistry: /^0x0{40}$/i.test(d.referralRegistry) ? undefined : d.referralRegistry,
  }, state, calls, me).catch((e) => { if ((e as { code?: string }).code !== "SessionPolicy") throw e; policyOk = false; return {} as Record<string, bigint>; });
  const spend = quoteSpend(delta);
  const eligible = policyOk && (await sessionCallsEligible(calls));
  const live = sessionLive();
  const mode = opts.trade && eligible ? await strictSessionTrades(me) : { strict: false, deployed: sa.deployed };
  const strict = !!opts.trade && eligible && mode.strict && mode.deployed !== undefined;
  // Rapid-tap spec #9 (#144): session spend still in flight counts against the cap. Headroom check → pick → hold run
  // with NO await in between, so two concurrent taps can't both pass on the same headroom.
  const headroom = sessionHasHeadroom(onchain, spend, SESSION_PENDING.total());
  const capRace = !headroom && SESSION_PENDING.size > 0 && sessionHasHeadroom(onchain, spend);
  const pick = tradeSigner({ trade: !!opts.trade, eligible, live, headroom, strictMode: mode.strict, deployed: mode.deployed, capRace });
  const asSession = pick.as === "session";
  if (pick.as === "refuse" && capRace) {
    console.warn("[disciple] trade refused: session spend limit reached with trades in flight", { inFlight: SESSION_PENDING.size, why: pick.why });
    throw new AAError("Policy", SPEND_LIMIT_MSG, { spendLimit: true, tradeError: "spend_limit" });
  }
  if (pick.as === "refuse") {
    const settingUp = loginSetup.busy(me), failed = !!loginSetup.lastError(me);
    console.warn("[disciple] trade refused: one-tap session not ready (no owner fallback)", { why: pick.why, settingUp, deployed: mode.deployed });
    // a brand-new account (setup not finished) or a first install ⇒ "getting ready"; a dead or failed session ⇒ "refreshing"
    const msg = mode.deployed && (onchain || failed) ? ONE_TAP_REFRESH_MSG : ONE_TAP_SETTING_UP_MSG;
    renewOneTap("trade");
    throw new AAError("Policy", msg, { sessionRequired: true });
  }
  if (opts.trade && !asSession) console.info("[disciple] trade signed by the owner", { why: pick.why, strict: mode.strict });
  let r;
  const hold = asSession ? SESSION_PENDING.hold(spend) : undefined;
  try { r = await sendWithGasRefill(calls, asSession ? "session" : "owner", me, { ...o, tt: opts.timing }); }
  catch (e) {
    const ae = e as AAError;
    if (hold && ae?.code === "Timeout") {
      // sent, outcome unknown: the spend stays held while lib/trade/pendingWatch looks for it (≤ WATCH_MS), then the
      // cap is re-read from the chain (a landed op is in its `spent`, a dropped one isn't), so nothing is double counted
      setTimeout(() => { SESSION_PENDING.drop(hold); void syncSessionFromChain(); }, WATCH_MS);
      throw e;
    }
    if (hold) SESSION_PENDING.drop(hold);   // refund: nothing was spent
    // session pre-flight rejected (stale/inactive session, cap race): nothing landed
    if (asSession && ae.code === "Estimate" && POLICY_RECOVERABLE.test(`${ae.message} ${String(ae.extra?.revertData ?? "")}`)) {
      void syncSessionFromChain();
      if (strict && SPEND_CAP_REVERT.test(`${ae.message} ${String(ae.extra?.revertData ?? "")}`)) {
        // the policy's own cap check (a race with another device / tab, or a stale cached `spent`): plain spend-limit line
        console.warn("[disciple] trade refused: session spend limit reached (policy pre-flight)", { revertData: ae.extra?.revertData });
        throw new AAError("Policy", SPEND_LIMIT_MSG, { spendLimit: true, tradeError: "spend_limit", revertData: ae.extra?.revertData });
      }
      if (strict) {
        // session-only trades: no second, owner-signed send — refresh the session and let the player tap again
        console.warn("[disciple] trade refused: session rejected by the policy pre-flight (no owner fallback)", { revertData: ae.extra?.revertData });
        throw new AAError("Policy", ONE_TAP_REFRESH_MSG, { sessionRequired: true, revertData: ae.extra?.revertData });
      }
      r = await sa.sendCalls(calls, { ...o, as: "owner", tt: opts.timing });   // owner signs the same calls once
    } else throw e;
  }
  if (hold) SESSION_PENDING.drop(hold);   // landed: moves into `spent` below
  gasListeners.forEach((f) => f("self-pay"));
  state = { ...state, ...recordSpend(state, delta) }; save();
  if (asSession && onchain) { onchain = addSpent(onchain, spend); saveSessionKey(); }
  else void maybeAutoOneTap("trade");   // first owner-signed trade deployed the account ⇒ set up one-tap now
  return r;
}
