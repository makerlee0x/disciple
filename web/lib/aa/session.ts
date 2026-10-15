/**
 * Browser session for the embedded smart account.
 *  - "email"/"google": Alchemy Account Kit signer (embedded, no popups) owns the LightAccount directly.
 *  - "eoa": the user's existing wallet signs ONE message; a session key is derived from it
 *    (deterministic, so the same smart account comes back every time) and owns the LightAccount.
 *    The key is cached for SESSION_TTL_MS (24h), then the wallet is asked to sign again.
 * Every userOp passes the session policy (aa/policy.ts) first.
 */
import { createPublicClient, createWalletClient, custom, http, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ACTIVE_CHAIN, MINTABLE_TEST_TOKENS, deployment } from "../chains";
import { AAError, DEFAULT_GAS_POLICY_ID, LightSmartAccount, alchemyBundler, type Call, type GasMode, type OwnerSigner } from "./core";
import { SESSION_TTL_MS, checkCalls, recordSpend, type SessionState } from "./policy";

export const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY || "";
export const GAS_POLICY_ID = process.env.NEXT_PUBLIC_ALCHEMY_GAS_POLICY_ID || DEFAULT_GAS_POLICY_ID;
/** Alchemy supports RH testnet as robinhood-testnet (bundler + gas manager). */
/** Bundler goes through our server proxy (/api/bundler); override with NEXT_PUBLIC_AA_BUNDLER_URL. */
export const BUNDLER_URL = process.env.NEXT_PUBLIC_AA_BUNDLER_URL || "/api/bundler";
/** Paymaster behind a flag; testnet default is self-paid gas (+ one-time /api/drip top-up). */
export const SPONSOR = process.env.NEXT_PUBLIC_AA_SPONSOR === "1";
/** Dev-only: show external-wallet options (EOA owner / plain wallet). */
export const DEV_WALLETS = process.env.NEXT_PUBLIC_DEV_WALLETS === "1";
export const aaAvailable = () => !!BUNDLER_URL && ACTIVE_CHAIN.id === 46630;
const publicClient = () => createPublicClient({ chain: ACTIVE_CHAIN, transport: http() }) as PublicClient;
const SESSION_LIMIT = BigInt(process.env.NEXT_PUBLIC_SESSION_SPEND_LIMIT_WEI || "1000000000000000000000000"); // 1M tokens (18 dec)

export type OwnerKind = "email" | "google" | "eoa" | "local";
/** "local" (default, testnet): random key in this browser. "alchemy": Account Kit email/Google signer (needs Smart Wallets config). */
export const SIGNER_MODE = process.env.NEXT_PUBLIC_AA_SIGNER === "alchemy" ? "alchemy" : "local";
const LOCAL_KEY = "disciple.local.ownerKey.v1";
const LS = "disciple.aa.session.v1";
type Stored = SessionState & { kind: OwnerKind; owner: Address; key?: Hex };

let sa: LightSmartAccount | null = null;
let state: Stored | null = null;
const gasListeners = new Set<(m: GasMode, r?: string) => void>();
export function onGasMode(f: (m: GasMode, r?: string) => void) { gasListeners.add(f); return () => { gasListeners.delete(f); }; }

function save() { try { if (state) localStorage.setItem(LS, JSON.stringify(state)); else localStorage.removeItem(LS); } catch {} }
function load(): Stored | null { try { const s = JSON.parse(localStorage.getItem(LS) || "null"); return s && s.expiresAt > Date.now() ? s : null; } catch { return null; } }

function makeAccount(owner: OwnerSigner) {
  return new LightSmartAccount({
    pc: publicClient(), chainId: ACTIVE_CHAIN.id, bundler: alchemyBundler(BUNDLER_URL), owner, policyId: GAS_POLICY_ID, sponsor: SPONSOR,
    onGasMode: (m, r) => gasListeners.forEach((f) => f(m, r)),
  });
}

/* ---------- Alchemy embedded signer (email OTP / Google) ---------- */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let alchemySigner: any = null;
async function getAlchemySigner() {
  if (alchemySigner) return alchemySigner;
  if (!ALCHEMY_KEY) throw new Error("Email login needs NEXT_PUBLIC_ALCHEMY_API_KEY.");
  const { AlchemyWebSigner } = await import("@account-kit/signer");
  let el = document.getElementById("alchemy-signer-iframe");
  if (!el) { el = document.createElement("div"); el.id = "alchemy-signer-iframe"; el.style.display = "none"; document.body.appendChild(el); }
  alchemySigner = new AlchemyWebSigner({
    client: { connection: { apiKey: ALCHEMY_KEY }, iframeConfig: { iframeContainerId: "alchemy-signer-iframe" }, enablePopupOauth: true },
    sessionConfig: { storage: "localStorage", sessionKey: "disciple.alchemy.signer", expirationTimeMs: SESSION_TTL_MS },
  });
  return alchemySigner;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function alchemyOwner(s: any, address: Address): OwnerSigner {
  return { address, signMessage: ({ message }) => s.signMessage(message) };
}

async function startSession(kind: OwnerKind, owner: OwnerSigner, key?: Hex) {
  sa = makeAccount(owner);
  state = { kind, owner: owner.address, key, expiresAt: Date.now() + SESSION_TTL_MS, spent: {} };
  save();
  const a = await sa.address();
  drip(a);
  return a;
}
/** One-time server top-up of test ETH for gas (self-pay). Fire-and-forget. */
export function drip(a: Address) {
  if (SPONSOR || ACTIVE_CHAIN.id !== 46630) return;
  fetch("/api/drip", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: a }) }).catch(() => {});
}

/** The signer API answers 401 without CORS headers when the Alchemy app has no Smart Wallets/Account Kit config, so the browser only sees "Failed to fetch". */
function signerErr(e: unknown): Error {
  const m = (e as Error)?.message || String(e);
  if (/failed to fetch|networkerror|load failed|must be authenticated|enablePopupOauth/i.test(m))
    return new Error("Login service unavailable: the Alchemy app's Smart Wallets (Account Kit) login isn't enabled for this site yet.");
  return e as Error;
}
export async function emailStart(email: string) {
  const s = await getAlchemySigner();
  try { await s.authenticate({ type: "email", emailMode: "otp", email }); } catch (e) { throw signerErr(e); }
}
export async function emailVerify(otpCode: string): Promise<Address> {
  const s = await getAlchemySigner();
  try { await s.authenticate({ type: "otp", otpCode }); } catch (e) { throw signerErr(e); }
  return startSession("email", alchemyOwner(s, (await s.getAddress()) as Address));
}
export async function googleLogin(): Promise<Address> {
  const s = await getAlchemySigner();
  try { await s.authenticate({ type: "oauth", authProviderId: "google", mode: "popup" }); } catch (e) { throw signerErr(e); }
  return startSession("google", alchemyOwner(s, (await s.getAddress()) as Address));
}

export const SESSION_MESSAGE = (owner: Address) =>
  `DISCIPLE one-tap trading\n\nSign once to unlock your DISCIPLE smart account on ${ACTIVE_CHAIN.name}.\nThis creates a session key scoped to DISCIPLE contracts.\n\nOwner: ${owner}\nVersion: 1`;

/** Existing wallet as owner: one signature ⇒ deterministic session key ⇒ same smart account every time. */
export async function eoaLogin(eth: Parameters<typeof custom>[0]): Promise<Address> {
  const w = createWalletClient({ chain: ACTIVE_CHAIN, transport: custom(eth) });
  const [owner] = await w.requestAddresses();
  const sig = await w.signMessage({ account: owner, message: SESSION_MESSAGE(owner) });
  const key = keccak256(sig);
  return startSession("eoa", privateKeyToAccount(key), key);
}

/* ---------- local browser-key owner (testnet) ---------- */
export function localKey(): Hex | null { try { const k = localStorage.getItem(LOCAL_KEY); return k && /^0x[0-9a-fA-F]{64}$/.test(k) ? (k as Hex) : null; } catch { return null; } }
/** Create (or reuse) the browser key and start a session. Zero popups. */
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

/** Restore a live session on reload (no prompts). */
export async function restore(): Promise<Address | null> {
  if (SIGNER_MODE === "local") { const k = localKey(); if (!k) return null; return startSession("local", privateKeyToAccount(k)); }
  const s = load();
  if (!s) return null;
  try {
    if (s.kind === "eoa" && s.key) { state = s; sa = makeAccount(privateKeyToAccount(s.key)); return sa.address(); }
    const signer = await getAlchemySigner();
    const u = await signer.getAuthDetails().catch(() => null);
    if (!u) return null;
    state = s; sa = makeAccount(alchemyOwner(signer, u.address)); const a = await sa.address(); drip(a); return a;
  } catch { return null; }
}

export function aaSession() { return state && sa ? { kind: state.kind, owner: state.owner, expiresAt: state.expiresAt, gasMode: sa.gasMode } : null; }
export async function aaLogout() { state = null; sa = null; save(); try { await alchemySigner?.disconnect(); } catch {} }
export async function aaAddress() { return sa ? sa.address() : null; }

/** One userOp for the whole call list, checked against the session policy. */
export async function aaSend(calls: Call[]) {
  if (!sa || !state) throw new AAError("Policy", "Sign in first.");
  const d = deployment();
  const me = await sa.address();
  const delta = await checkCalls(publicClient(), {
    launchpad: d.launchpad, router: d.router, trampWallManager: d.trampWallManager,
    mintable: MINTABLE_TEST_TOKENS.map((t) => t.address), defaultLimit: SESSION_LIMIT,
  }, state, calls, me);
  const r = await sa.sendCalls(calls);
  state = { ...state, ...recordSpend(state, delta) }; save();
  return r;
}
