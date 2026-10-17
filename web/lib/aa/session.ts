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
import { createPublicClient, createWalletClient, custom, http, keccak256, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ACTIVE_CHAIN, MINTABLE_TEST_TOKENS, deployment } from "../chains";
import { ANON_ADDONS } from "../anon";
import { AAError, type Call, type GasMode } from "./core";
import type { Mav2Account } from "./mav2"; // aa-sdk is loaded lazily (makeAccount) to keep it out of first-load JS
import { policyHasUsdg, SESSION_POLICY_MODULE_ID, cachedSessionUsable, moduleIdAbi, type CachedSession, referralAttributionOn, sessionEligible, sessionPermissions } from "./oneTap";
import { SESSION_TTL_MS, checkCalls, recordSpend, type SessionState } from "./policy";

/** Bundler goes through our server proxy (/api/bundler → Alchemy, no gas policy); override with NEXT_PUBLIC_AA_BUNDLER_URL. */
export const BUNDLER_URL = process.env.NEXT_PUBLIC_AA_BUNDLER_URL || "/api/bundler";
/** Privy app id. Vercel previews use a separate dev app (NEXT_PUBLIC_PRIVY_APP_ID_PREVIEW) — see PR #59 notes. */
export const PRIVY_APP_ID = (process.env.NEXT_PUBLIC_VERCEL_ENV === "preview" && process.env.NEXT_PUBLIC_PRIVY_APP_ID_PREVIEW) || process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";
/** Deployed DiscipleSessionPolicy (PR #53). Unset ⇒ no on-chain session keys yet; owner signs every op. */
export const SESSION_POLICY = (/^0x[0-9a-fA-F]{40}$/.test(process.env.NEXT_PUBLIC_SESSION_POLICY || "") ? process.env.NEXT_PUBLIC_SESSION_POLICY : "") as Address | "";
/** Dev-only: show external-wallet options (EOA owner / plain wallet). */
export const DEV_WALLETS = process.env.NEXT_PUBLIC_DEV_WALLETS === "1";
export const aaAvailable = () => !!BUNDLER_URL && ACTIVE_CHAIN.id === 46630;
const publicClient = () => createPublicClient({ chain: ACTIVE_CHAIN, transport: http() }) as PublicClient;
const SESSION_LIMIT = BigInt(process.env.NEXT_PUBLIC_SESSION_SPEND_LIMIT_WEI || "1000000000000000000000000"); // 1M tokens (18 dec)

/** Slippage the session allows (on-chain maxSlippageBps). Default 5%, user range 0.1%..50%. */
export const SLIPPAGE_DEFAULT_BPS = 500;
export const SLIPPAGE_MIN_BPS = 10;
export const SLIPPAGE_MAX_BPS = 5000;
export const clampSlippageBps = (b: number) => Math.min(SLIPPAGE_MAX_BPS, Math.max(SLIPPAGE_MIN_BPS, Math.round(b) || SLIPPAGE_DEFAULT_BPS));

export type OwnerKind = "privy" | "eoa" | "local";
export const SIGNER_MODE: "privy" | "local" = PRIVY_APP_ID && process.env.NEXT_PUBLIC_AA_SIGNER !== "local" ? "privy" : "local";
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
const changed = () => sessListeners.forEach((f) => f());

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

async function makeAccount(owner: LocalAccount) {
  const { Mav2Account } = await import("./mav2");
  return new Mav2Account({ chain: ACTIVE_CHAIN, pc: publicClient(), bundlerUrl: BUNDLER_URL }, owner);
}

async function startSession(kind: OwnerKind, owner: LocalAccount, key?: Hex) {
  sa = await makeAccount(owner);
  ownerAcct = owner;
  state = { kind, owner: owner.address, key, expiresAt: Date.now() + SESSION_TTL_MS, spent: {} };
  save();
  const a = await sa.address();
  onchain = loadSessionKey(a);
  if (onchain) await sa.useSession(onchain.entityId, privateKeyToAccount(onchain.key));
  drip(a);
  changed();
  return a;
}
/** One-time server top-up of test ETH for gas (self-pay, existing drip faucet). Fire-and-forget. */
export function drip(a: Address) {
  if (ACTIVE_CHAIN.id !== 46630) return;
  fetch("/api/drip", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: a }) }).catch(() => {});
}

/* ---------- Privy embedded wallet owner ---------- */
/** Called by PrivyProviders once the embedded wallet is ready (owner = toViemAccount(wallet)). */
export async function setPrivyOwner(owner: LocalAccount): Promise<Address> {
  if (sa && state?.kind === "privy" && state.owner.toLowerCase() === owner.address.toLowerCase()) return sa.address();
  return startSession("privy", owner);
}
type PrivyHooks = { login: () => void; logout: () => Promise<void> };
let privyHooks: PrivyHooks | null = null;
export function registerPrivy(h: PrivyHooks | null) { privyHooks = h; }
export function privyReady() { return !!privyHooks; }
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
  state = null; sa = null; ownerAcct = null; onchain = null; save(); changed();
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
  const reserve = ((blk.baseFeePerGas ?? BigInt(0)) * BigInt(2) + BigInt(1_000_000)) * BigInt(800_000); // worst-case gas for this op
  if (lb.eth > reserve * BigInt(2)) calls.push({ to, data: "0x", value: lb.eth - reserve });
  if (!calls.length) throw new AAError("FundAccount", "Old account only holds gas dust — nothing worth sweeping.");
  const old = new LightSmartAccount({ pc, chainId: ACTIVE_CHAIN.id, bundler: alchemyBundler(BUNDLER_URL), owner: ownerAcct });
  return old.sendCalls(calls);
}

/* ---------- on-chain one-tap session (DiscipleSessionPolicy, PR #53) ---------- */
export const oneTapAvailable = () => !!SESSION_POLICY && ACTIVE_CHAIN.id === 46630;

/**
 * Owner approves ONE userOp: installValidation(SingleSigner(sessionKey) + DiscipleSessionPolicy hooks).
 * After this, aaSend signs trades with the session key (no Privy prompt) until validUntil.
 */
export async function enableOneTap(opts: { maxSlippageBps?: number; ttlSec?: number } = {}) {
  if (!sa || !state) throw new AAError("Policy", "Sign in first.");
  if (!SESSION_POLICY) throw new AAError("Policy", "One-tap sessions aren't live yet (session policy not deployed).");
  const sk = await import("@disciple/session-keys");
  const { getDefaultSingleSignerValidationModuleAddress, getDefaultTimeRangeModuleAddress } = await import("@account-kit/smart-contracts/experimental");
  const d = deployment();
  const id = await publicClient().readContract({ address: SESSION_POLICY, abi: moduleIdAbi, functionName: "moduleId" }).catch(() => "");
  if (id !== SESSION_POLICY_MODULE_ID) throw new AAError("Policy", `Session policy at ${SESSION_POLICY} reports "${id || "?"}", expected ${SESSION_POLICY_MODULE_ID}.`);
  const key = generatePrivateKey();
  const maxSlippageBps = clampSlippageBps(opts.maxSlippageBps ?? SLIPPAGE_DEFAULT_BPS);
  const account = await sa.address();
  const s = sk.buildCreateSession({
    modules: { policy: SESSION_POLICY, singleSigner: getDefaultSingleSignerValidationModuleAddress(ACTIVE_CHAIN), timeRange: getDefaultTimeRangeModuleAddress(ACTIVE_CHAIN) },
    targets: { router: d.router, launchpad: d.launchpad, anonLauncher: ANON_ADDONS[ACTIVE_CHAIN.id]?.anonLauncher, trampWallManager: d.trampWallManager },
    sessionSigner: privateKeyToAccount(key).address,
    caps: [{ token: d.defaultQuote, cap: SESSION_LIMIT }, { token: d.usdg, cap: SESSION_LIMIT }],
    ttlSec: opts.ttlSec ?? SESSION_TTL_MS / 1000, maxSlippageBps,
    permissions: sessionPermissions(sk.TRADE_PERMS), // + P_REFERRAL when NEXT_PUBLIC_REFERRAL_ATTRIBUTE=1
  });
  const r = await sa.sendCalls([{ to: account, data: s.data }], "owner");
  onchain = { account, entityId: s.entityId, key, validUntil: s.validUntil, maxSlippageBps, policy: SESSION_POLICY };
  try { localStorage.setItem(SK, JSON.stringify(onchain)); } catch {}
  await sa.useSession(s.entityId, privateKeyToAccount(key));
  changed();
  return { ...r, entityId: s.entityId, validUntil: s.validUntil, maxSlippageBps };
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
  onchain = null; sa.clearSession();
  try { localStorage.removeItem(SK); } catch {}
  changed();
  return r;
}

/** Keep the smart account hot: clients + deployment status + fee cache (client) and relayer nonce/fees (server). */
export async function aaWarm() {
  if (!sa) return;
  await Promise.all([
    sa.warm(),
    fetch("/api/bundler", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "disciple_warm", params: [await sa.address().catch(() => undefined)] }) }).catch(() => undefined),
  ]);
}

async function canUseSessionKey(calls: Call[]) {
  if (!sa?.hasSession || !onchain || onchain.validUntil * 1000 < Date.now() + 30_000) return false;
  return sessionEligible(calls, { referral: referralAttributionOn(), registry: deployment().referralRegistry, usdg: policyHasUsdg() ? deployment().usdg : undefined, router: deployment().router });
}

/** One userOp for the whole call list, pre-checked against the client policy. Session key if eligible, else owner. */
export async function aaSend(calls: Call[]) {
  if (!sa || !state) throw new AAError("Policy", "Sign in first.");
  const d = deployment();
  const me = await sa.address();
  const delta = await checkCalls(publicClient(), {
    launchpad: d.launchpad, router: d.router, trampWallManager: d.trampWallManager,
    mintable: MINTABLE_TEST_TOKENS.map((t) => t.address), defaultLimit: SESSION_LIMIT, spendTokens: [d.defaultQuote, d.usdg],
    usdg: policyHasUsdg() ? d.usdg : undefined,
  }, state, calls, me);
  const r = await sa.sendCalls(calls, (await canUseSessionKey(calls)) ? "session" : "owner");
  gasListeners.forEach((f) => f("self-pay"));
  state = { ...state, ...recordSpend(state, delta) }; save();
  return r;
}
