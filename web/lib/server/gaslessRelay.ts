import "server-only";
/**
 * Gasless swap relay (flow/gasless-permit2; GAS_SPONSORSHIP_MODE=gasless, testnet Preview/local only).
 * Copied pattern: 0x Gasless (0x-settler SettlerMetaTxn) — the Privy EOA signs a Permit2 witness, our relayer EOA pool
 * submits DiscipleRouter.buyWithPermit2 / sellWithPermit2 with eth_sendRawTransactionSync and pays the ETH.
 *
 * Login (lee, Nov 9 7:37 PM CT — "why do we have to record onchain that theyre verified? … get rid of it"): app-level
 * gating as pump.fun / FOMO do it. NO on-chain LoginGate requirement and no LoginGate.attest per session on this path:
 * the request must carry a valid Privy *identity token* (`privy-id-token`, verified locally by lib/server/gaslessSession
 * → verifyIdentityToken) whose linked wallet == the Permit2 signer. No GET api.privy.io/v1/users hop (AUDIT M2;
 * https://docs.privy.io/user-management/users/identity-tokens). Missing / invalid identity token ⇒ clean refusal.
 *
 * M3 (lee 8:25 PM CT: "accept that the old Easy test coins can't be bought gasless"): ungraduated Easy/PvE curves
 * that still check LoginGate on-chain (curve.loginGate() ≠ 0 or mode() == PVE) are refused BEFORE simulation, with
 * code LegacyLoginGate. Sells and graduated (v4) coins never checked; the loginGate()/mode values are immutable and
 * cached in the shared KV and read in the SAME MGET as the ban/strike/revoke keys (no extra RTT). A KV miss
 * reads on-chain in parallel with simulate and writes back. The exact-sim NotVerified path stays as a backstop only.
 *
 * Kept from the self-bundler (same modules, same keys): permanent ban (relay:banned:<wallet|did>) + 600 s revoke
 * marker + strike window (wallet and Privy DID; requireNotRevokedOrStruck), per-IP limit (relay:ip), per-sender cap +
 * global quota (Kv.relayBudget, charged only after a passing exact simulation, global unit refunded if nothing was
 * signed), exact eth_call simulation of the relayer tx before signing, relayer pool lease + nonce rules, and the
 * relayer-loss breaker (lib/server/relayBreaker, from flow/queue-a-e): included reverts trip it ⇒ sends pause, notSent.
 *
 * Order (lee, 7:52 PM CT: "Run them in parallel, 384 ms"): [shape + $3 minimum + local signature recovery, no RPC] →
 * [Privy identity token (local crypto) ∥ revoke/ban/strike gate (after did, ~1 ms) ∥ per-IP limit ∥ relayer warm ∥
 * exact simulation (starts once the token and relayer are ready; skipped if a cached legacy-PVE buy) ∥ wallet/invite
 * match ∥ curve loginGate/mode (cached / parallel)] → budget → sign + sync send.
 * Pattern: speculative parallel validation, commit only after all gates pass (0x Gasless / Settler meta-tx relayers
 * validating off-chain before submit). A banned / revoked / struck player is still refused BEFORE any budget charge,
 * cap reservation, breaker accounting or send — a completed simulation is discarded. Nothing is charged or signed
 * unless every admission check passed.
 */
import { createPublicClient, encodeFunctionData, parseAbi, toFunctionSelector, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { ACTIVE_CHAIN, DEPLOYMENTS, robinhoodTestnet } from "../chains";
import { gaslessMode } from "../aa/sponsorshipMode";
import type { RelayReceipt } from "../aa/relayTypes";
import { checkGaslessRequest, encodeGaslessCall, gaslessTxGasLimit, GaslessReject, parseGaslessRequest, tradeTypedData, type GaslessRequest } from "../trade/gaslessPermit2";
import { usdgBuyFillsCurve, usdgBuyGraduates } from "../trade/gradNeed";
import { bondingCurveAbi } from "../abi/BondingCurve";
import { relaySendBudget, requireNotRevokedOrStruck } from "./relayLockdown";
import { relayReadTransport } from "./relayReadTransport";
import { requireSessionWallet, verifySessionToken } from "./gaslessSession";
import { directRelayer, sendDirect, simulateDirect, strikeSender, type DirectRelayer, type OnPending } from "./fastRelay";
import { relayBreaker } from "./relayBreaker";
import type { RelayMetrics } from "./relayMetrics";
import { kv } from "./kv";

const timed = <T>(m: RelayMetrics | undefined, stage: string, task: () => Promise<T>) => m ? m.span(stage, task) : task();
const notSent = (e: unknown) => Object.assign(e as Error, { notSent: true });

/** Same environment fence as the self-bundler (requireSelfBundlerMode): testnet 46630, Preview or local, mode=gasless. */
export function requireGaslessMode() {
  const preview = process.env.VERCEL_ENV === "preview";
  const local = (!process.env.VERCEL_ENV || process.env.VERCEL_ENV === "development") && (!process.env.VERCEL || process.env.VERCEL_ENV === "development") && process.env.NODE_ENV !== "production";
  if (!gaslessMode() || ACTIVE_CHAIN.id !== 46630 || (!preview && !local)) throw notSent(new Error("gasless relay disabled: local or Preview testnet only"));
  if (/^0x0{40}$/i.test(DEPLOYMENTS[46630].gaslessRouter)) throw notSent(new Error("gasless router not configured"));
}

export type GaslessConfirmed = { kind: "confirmed"; txHash: Hex; success: boolean; receipt: RelayReceipt; gasUsed: number; via: string;
  t: { admission: number; budget: number; send: number; total: number } };
export type GaslessDeps = { ipGate?: Promise<void>; onPending?: OnPending; metrics?: RelayMetrics; nowSec?: number;
  /** Privy identity token from the `privy-id-token` header (or cookie). Required for trades. */
  idToken?: string | null };

/** BondingCurve.NotVerified() — backstop only; ungraduated Easy/PvE buys are refused before simulation (M3). */
export const NOT_VERIFIED_SELECTOR = toFunctionSelector("error NotVerified()");
export const LEGACY_PVE_CODE = "LegacyLoginGate";
export const LEGACY_LOGIN_MESSAGE = "this coin's curve still requires an on-chain LoginGate login (pre-redeploy Easy curve); gasless buys aren't available";
const legacyPve = () => Object.assign(new Error(LEGACY_LOGIN_MESSAGE), { notSent: true, code: LEGACY_PVE_CODE, legacyLogin: true });
const legacyLogin = (e: unknown) => {
  const x = e as { data?: unknown; message?: string };
  if ((typeof x.data === "string" && x.data.toLowerCase().startsWith(NOT_VERIFIED_SELECTOR)) || /NotVerified/.test(x.message ?? ""))
    return Object.assign(new Error(LEGACY_LOGIN_MESSAGE), { notSent: true, code: LEGACY_PVE_CODE, data: x.data, legacyLogin: true });
  return e;
};

/**
 * Immutable market status, shared KV, one key per coin (curveOf is write-once; loginGate/mode are immutable).
 *   none              — no curve, or the curve does not check LoginGate (TRENCH/PVP): gasless buys OK, no chain read
 *   login:0x<curve>   — Easy/PvE curve that checks LoginGate on ungraduated buys: only a fresh graduated() read
 *   grad:0x<curve>    — same curve, observed graduated (one-way): gasless buys OK, no chain read
 * Read in the SAME MGET as ban/strike/revoke (no extra RTT). Written back on an on-chain miss (no TTL).
 */
export const marketStatusKey = (coin: string) => `relay:market:${coin.toLowerCase()}`;
export const MARKET_NONE = "none";
export const MARKET_NOCURVE = "nocurve";
export const MARKET_LOGIN = "login";
export const MARKET_GRAD = "grad";
const parseMarket = (raw: string | null | undefined): { kind: "none" | "login" | "grad"; curve?: Address; empty?: boolean } | undefined => {
  if (!raw) return undefined;
  if (raw === MARKET_NOCURVE) return { kind: "none", empty: true };
  if (raw === MARKET_NONE) return { kind: "none" }; // legacy: may be a TRENCH/PVP curve (upgrade on the fill check)
  const m = /^(none|login|grad):(0x[0-9a-fA-F]{40})$/.exec(raw);
  return m ? { kind: m[1] as "none" | "login" | "grad", curve: m[2] as Address } : undefined;
};
type MarketHint = "legacy" | "ok";
const marketMemo = new Map<string, { v: MarketHint; until: number; status?: string }>();
export const gaslessMarketCache = { clear() { marketMemo.clear(); } };
export const peekGaslessMarket = (coin: string, isBuy: boolean): MarketHint | undefined => {
  if (!isBuy) return "ok";
  const hit = marketMemo.get(coin.toLowerCase());
  return hit && hit.until > Date.now() ? hit.v : undefined;
};
const peekMarketStatus = (coin: string): string | undefined => {
  const hit = marketMemo.get(coin.toLowerCase());
  return hit && hit.until > Date.now() ? hit.status : undefined;
};
const remember = (coin: string, v: MarketHint, ttlMs: number, status?: string) => {
  const k = coin.toLowerCase();
  const prev = marketMemo.get(k);
  marketMemo.set(k, { v, until: Date.now() + ttlMs, status: status ?? prev?.status });
};
const persistMarket = (coin: string, value: string) => { void kv().set(marketStatusKey(coin), value).catch(() => undefined); };
const marketPc = createPublicClient({ chain: robinhoodTestnet, transport: relayReadTransport(5000, 0) });
const marketAbi = parseAbi(["function curveOf(address) view returns (address)", "function loginGate() view returns (address)", "function mode() view returns (uint8)", "function graduated() view returns (bool)"]);
const isZeroAddr = (a: unknown) => typeof a === "string" && /^0x0{40}$/i.test(a);

/** Fresh graduated() only — loginGate/mode already known. Graduation is one-way; persist `grad:` when we see it. */
async function assertUngraduatedPve(coin: Address, curve: Address): Promise<void> {
  let grad = false;
  try { grad = Boolean(await marketPc.readContract({ address: curve, abi: marketAbi, functionName: "graduated" })); }
  catch { throw legacyPve(); }
  if (grad) { remember(coin, "ok", 3_600_000, `${MARKET_GRAD}:${curve.toLowerCase()}`); persistMarket(coin, `${MARKET_GRAD}:${curve.toLowerCase()}`); return; }
  remember(coin, "legacy", 15_000);
  throw legacyPve();
}

/** Refuse an ungraduated Easy/PvE buy. `kvStatus` is the value from the gate MGET (undefined ⇒ not fetched). */
export async function assertGaslessMarket(coin: Address, isBuy: boolean, kvStatus?: string | null): Promise<void> {
  const peek = peekGaslessMarket(coin, isBuy);
  if (peek === "ok") return;
  if (peek === "legacy") throw legacyPve();
  if (!isBuy) return;
  const hit = parseMarket(kvStatus);
  if (hit?.kind === "none" || hit?.kind === "grad") { remember(coin, "ok", 3_600_000, kvStatus ?? undefined); return; }
  if (hit?.kind === "login" && hit.curve) return assertUngraduatedPve(coin, hit.curve);
  const lp = DEPLOYMENTS[46630].launchpad;
  let curve: Address;
  try { curve = await marketPc.readContract({ address: lp, abi: marketAbi, functionName: "curveOf", args: [coin] }); }
  catch { return; }   // unreadable registry: let the exact sim / router decide
  if (!curve || isZeroAddr(curve)) { remember(coin, "ok", 3_600_000, MARKET_NOCURVE); persistMarket(coin, MARKET_NOCURVE); return; }
  let gate: Address | undefined, mode = 0;
  try {
    const [g, m] = await Promise.all([
      marketPc.readContract({ address: curve, abi: marketAbi, functionName: "loginGate" }),
      marketPc.readContract({ address: curve, abi: marketAbi, functionName: "mode" }).catch(() => 0),
    ]);
    gate = g; mode = Number(m);
  } catch { return; }
  const checksLogin = !isZeroAddr(gate) || mode === 1;   // BondingCurve: mode 1 = PVE/Easy, loginGate set ⇒ _pveOnBuy
  if (!checksLogin) {
    const status = `${MARKET_NONE}:${(curve as string).toLowerCase()}`;
    remember(coin, "ok", 3_600_000, status); persistMarket(coin, status); return;
  }
  persistMarket(coin, `${MARKET_LOGIN}:${curve.toLowerCase()}`);
  await assertUngraduatedPve(coin, curve);
}

/** Admission + exact simulation of ONE relayer tx; throws (notSent) in priority order session → gate → market → sim. */

/** Whether a USDG-paid buy fills the curve. Reuses memo / gate MGET so a known no-curve or graduated market does no extra RPC. */
async function fillFromCurve(curve: Address, usdgIn: bigint): Promise<boolean> {
  const dep = DEPLOYMENTS[46630];
  try {
    const [graduated, quote] = await Promise.all([
      marketPc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "graduated" }),
      marketPc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quote" }),
    ]);
    if (graduated) return false;
    if (typeof quote === "string" && quote.toLowerCase() === dep.usdg.toLowerCase()) {
      const r = await marketPc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quoteBuy", args: [usdgIn] });
      return Boolean((r as { graduates?: boolean }).graduates);
    }
    return await usdgBuyGraduates(marketPc, { router: dep.gaslessRouter, curve, quote: quote as Address, usdgIn });
  } catch { return false; }
}

async function gaslessFillsCurve(coin: Address, usdgIn: bigint, kvStatus?: string | null): Promise<boolean> {
  const dep = DEPLOYMENTS[46630];
  const hit = parseMarket(kvStatus);
  if (hit?.kind === "grad" || hit?.kind === "login" || hit?.empty) return false;
  if (hit?.kind === "none" && hit.curve) return fillFromCurve(hit.curve, usdgIn);
  // No status, or a legacy bare "none" that may hide a TRENCH/PVP curve: one curveOf, then persist the precise key.
  try {
    const curve = await marketPc.readContract({ address: dep.launchpad, abi: marketAbi, functionName: "curveOf", args: [coin] });
    if (typeof curve !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(curve) || isZeroAddr(curve)) {
      remember(coin, "ok", 3_600_000, MARKET_NOCURVE);
      persistMarket(coin, MARKET_NOCURVE);
      return false;
    }
    const status = `${MARKET_NONE}:${curve.toLowerCase()}`;
    remember(coin, "ok", 3_600_000, status);
    persistMarket(coin, status);
    return fillFromCurve(curve as Address, usdgIn);
  } catch {
    return usdgBuyFillsCurve(marketPc, { launchpad: dep.launchpad, router: dep.gaslessRouter, usdg: dep.usdg, token: coin, usdgIn });
  }
}

async function admit(signer: Address, to: Hex, data: Hex, d: GaslessDeps, coin: Address, isBuy: boolean, amountIn: bigint, extra: Promise<unknown>[] = []): Promise<{ relayer: DirectRelayer; did: string; fillsCurve: boolean }> {
  const m = d.metrics;
  const relayer = directRelayer(m);
  const session = timed(m, "authSession", () => verifySessionToken(d.idToken));
  const owner = session.then(x => timed(m, "authSessionWallet", () => requireSessionWallet(x, signer)));
  // Gate starts after the identity token (~1 ms, local) so it can key ban/revoke/strike on the Privy DID (AUDIT M1).
  // The immutable market-status key is in the SAME MGET (no extra RTT). On a hit, no curveOf/loginGate/mode RPC.
  const peek = peekGaslessMarket(coin, isBuy);
  if (peek === "legacy") throw legacyPve();
  const mkey = isBuy && peek !== "ok" ? marketStatusKey(coin) : undefined;
  const gate = session.then(x => timed(m, "revokeStrikeGate", () => requireNotRevokedOrStruck(signer, Date.now(), x.did, mkey)));
  const market = peek === "ok" ? Promise.resolve() : gate.then(status => timed(m, "legacyMarketGate", () => assertGaslessMarket(coin, isBuy, status)));
  // Speculative sim ∥ revoke/ban/strike + market reads. The eth_call starts once the token (local crypto) and the
  // relayer (needed for `from`) are ready — it does not wait for the gate. A cached legacy-PVE buy never starts it.
  // admit() still joins every gate before returning, so commit cannot run if a gate failed; a finished simulation is
  // then discarded. Gate / market are listed before sim in `all` so those errors win the throw if both fail.
  const sim = Promise.all([relayer, session]).then(([r]) => timed(m, "simulate", () => simulateDirect(r.address, to, data).catch(e => { throw legacyLogin(e); })));
  // Graduation-fill check in parallel with sim (readContract only on the happy path; never fails admission).
  // Graduation-fill check ∥ sim. Starts after the gate MGET so a cached login:curve is reused (no extra curveOf).
  // Never fails admission. Sells and already-graduated markets skip the reads.
  const fillsP = !isBuy ? Promise.resolve(false)
    : timed(m, "gradFillCheck", () => {
      const memo = peekMarketStatus(coin);
      if (memo !== undefined) return gaslessFillsCurve(coin, amountIn, memo);
      return gate.then(status => gaslessFillsCurve(coin, amountIn, status as string | null | undefined)).catch(() => false);
    }).catch(() => false);
  const all = [session, owner, gate, market, d.ipGate ?? Promise.resolve(), ...extra, sim, relayer, fillsP];
  const res = await timed(m, "admissionSimulationWall", () => Promise.allSettled(all));
  for (const x of res) if (x.status === "rejected") throw notSent(x.reason);
  return {
    relayer: (res[all.indexOf(relayer)] as PromiseFulfilledResult<DirectRelayer>).value,
    did: (res[all.indexOf(session)] as PromiseFulfilledResult<{ did: string }>).value.did,
    fillsCurve: (res[all.indexOf(fillsP)] as PromiseFulfilledResult<boolean>).value,
  };
}

/** Budget (after the exact simulation passed) → sign + sync send → strike / breaker on an included revert. */
async function commit(signer: Address, to: Hex, data: Hex, gas: bigint, r: DirectRelayer, d: GaslessDeps, t0: number, tAdm: number, did?: string): Promise<GaslessConfirmed> {
  const m = d.metrics;
  const tb = Date.now();
  const refund = await relaySendBudget(signer, m).catch(e => { throw notSent(e); });
  const budget = Date.now() - tb;
  let res;
  try { res = await sendDirect(r, to, data, gas, d.onPending, m); }
  catch (e) { if ((e as { notSent?: boolean }).notSent) await refund().catch(() => undefined); throw e; }
  const success = res.rc.status === "0x1";
  const gasUsed = Number(BigInt(res.rc.gasUsed));
  if (!success) {
    strikeSender(signer, did);
    const price = res.rc.effectiveGasPrice ? BigInt(res.rc.effectiveGasPrice) : BigInt(0);
    await relayBreaker.record({ reverted: true, lossWei: BigInt(res.rc.gasUsed) * price }).catch(() => false);
  }
  return { kind: "confirmed", txHash: res.txHash, success, receipt: res.rc, gasUsed, via: String(res.via),
    t: { admission: tAdm, budget, send: res.sendMs + res.minedMs, total: Date.now() - t0 } };
}

/** disciple_gaslessTrade: one signed Permit2-witness trade → one relayer tx to the gasless router. */
export async function relayGaslessTrade(raw: unknown, d: GaslessDeps = {}): Promise<GaslessConfirmed> {
  const t0 = Date.now();
  let q: GaslessRequest, router: Hex;
  try {
    requireGaslessMode();
    relayBreaker.assertClosed();
    const dep = DEPLOYMENTS[46630];
    router = dep.gaslessRouter;
    q = parseGaslessRequest(raw);
    checkGaslessRequest(q, { usdg: dep.usdg, usdgDecimals: dep.usdgDecimals, nowSec: d.nowSec ?? Math.floor(Date.now() / 1000) });
    // Local, RPC-free: the witness signature must be the signer's (the router re-checks via Permit2).
    const who = await recoverTypedDataAddress({ ...tradeTypedData(robinhoodTestnet.id, router, q.permit, q.trade), signature: q.signature });
    if (who.toLowerCase() !== q.signer.toLowerCase()) throw new GaslessReject("signature is not the signer's");
  } catch (e) { throw notSent(e); }
  const data = encodeGaslessCall(q);
  const { relayer, did, fillsCurve } = await admit(q.signer, router, data, d, q.trade.coin, q.trade.isBuy, q.trade.amountIn);
  return commit(q.signer, router, data, gaslessTxGasLimit(fillsCurve), relayer, d, t0, Date.now() - t0, did);
}

const loginGateAbi = parseAbi(["function attest(address wallet, uint64 expiry, bytes sig)"]);
export const GASLESS_LOGIN_PER_WALLET = { limit: 3, windowSec: 3600 } as const;
/** OFF (lee 7:37 PM CT: no on-chain login record; AUDIT never signed off on server-paid attest gas). Only
 *  GASLESS_LOGIN_RELAY=1 re-enables it (no env sets it). TODO(lee): delete disciple_gaslessLogin + relayGaslessLogin +
 *  wallet.ensureGaslessLogin once the off-chain session gate ships. */
export const gaslessLoginRelayEnabled = () => process.env.GASLESS_LOGIN_RELAY === "1";
/**
 * disciple_gaslessLogin: relay LoginGate.attest(wallet, expiry, sig) for a Privy EOA with no ETH. The attestation is
 * only ever issued by /api/pve/attest after Privy auth (attester key server-side); relaying it changes nothing about who
 * may log in. Same gates as a trade minus LoginGate itself, + 3 per wallet per hour. NEEDS lee/AUDIT sign-off: today's
 * rule (lib/pve.ts) is "users pay the attest gas, no server relay".
 */
export async function relayGaslessLogin(raw: unknown, d: GaslessDeps = {}): Promise<GaslessConfirmed> {
  const t0 = Date.now();
  let wallet: Address, data: Hex;
  const gate = DEPLOYMENTS[46630].loginGate;
  try {
    requireGaslessMode();
    if (!gaslessLoginRelayEnabled()) throw new Error("gasless login relay is off (login is checked off-chain)");
    relayBreaker.assertClosed();
    const o = (raw ?? {}) as { wallet?: unknown; expiry?: unknown; signature?: unknown };
    if (typeof o.wallet !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(o.wallet)) throw new GaslessReject("bad wallet");
    if (typeof o.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(o.signature)) throw new GaslessReject("bad attestation");
    const exp = Number(o.expiry), now = d.nowSec ?? Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(exp) || exp <= now || exp > now + 31 * 86400) throw new GaslessReject("bad expiry");
    wallet = o.wallet as Address;
    data = encodeFunctionData({ abi: loginGateAbi, functionName: "attest", args: [wallet, BigInt(exp), o.signature as Hex] });
  } catch (e) { throw notSent(e); }
  const perWallet = timed(d.metrics, "rateLimitStore", async () => {
    const n = await kv().incrEx(`gasless:login:${wallet.toLowerCase()}`, GASLESS_LOGIN_PER_WALLET.windowSec);
    if (n > GASLESS_LOGIN_PER_WALLET.limit) throw new Error("login relay rate limited");
  });
  // No LoginGate admission here (this IS the login); revoke/strike gate, IP limit, per-wallet limit and the exact
  // simulation (attest reverts on a bad / stale-epoch signature) all still run.
  const m = d.metrics;
  const relayer = directRelayer(m);
  const res = await Promise.allSettled([timed(m, "revokeStrikeGate", () => requireNotRevokedOrStruck(wallet)), d.ipGate ?? Promise.resolve(), perWallet,
    relayer.then(r => timed(m, "simulate", () => simulateDirect(r.address, gate, data))), relayer]);
  for (const x of res) if (x.status === "rejected") throw notSent(x.reason);
  return commit(wallet, gate, data, BigInt(200_000), (res[4] as PromiseFulfilledResult<DirectRelayer>).value, d, t0, Date.now() - t0);
}

/** disciple_gaslessWarm: lease a relayer key, warm nonce / base fee / sequencer TLS (no admission state is cached). */
export async function warmGasless(signer: unknown, metrics?: RelayMetrics) {
  requireGaslessMode();
  if (typeof signer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(signer)) throw notSent(new Error("warm requires a wallet"));
  const r = await directRelayer(metrics);
  return { relayer: r.address };
}
