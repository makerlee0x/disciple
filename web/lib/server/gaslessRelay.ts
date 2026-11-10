import "server-only";
/**
 * Gasless swap relay (flow/gasless-permit2; GAS_SPONSORSHIP_MODE=gasless, testnet Preview/local only).
 * Copied pattern: 0x Gasless (0x-settler SettlerMetaTxn) — the Privy EOA signs a Permit2 witness, our relayer EOA pool
 * submits DiscipleRouter.buyWithPermit2 / sellWithPermit2 with eth_sendRawTransactionSync and pays the ETH.
 *
 * Login (lee, Nov 9 7:37 PM CT — "why do we have to record onchain that theyre verified? … get rid of it"): app-level
 * gating as pump.fun / FOMO do it. NO on-chain LoginGate requirement and no LoginGate.attest per session on this path:
 * the request must carry a valid Privy session (Authorization: Bearer <access token>, verified server-side by
 * lib/server/gaslessSession → lib/server/privyAuth) whose linked wallet == the Permit2 signer.
 * Existing (pre-redeploy) PvE curves still check LoginGate on-chain in routerBuy (BondingCurve._pveOnBuy): that is
 * detected by the exact eth_call simulation (it reverts NotVerified), surfaced as a clear notSent error — no extra RPC on
 * the hot path, and new curves (no on-chain check) just pass. PvP curves, sells and graduated (v4) coins never checked.
 *
 * Kept from the self-bundler (same modules, same keys): revoke marker + strike window (requireNotRevokedOrStruck),
 * per-IP limit (relay:ip), per-sender cap + global quota (Kv.relayBudget, charged only after a passing exact
 * simulation, global unit refunded if nothing was signed), exact eth_call simulation of the relayer tx before signing,
 * relayer pool lease + nonce rules, and the relayer-loss breaker (lib/server/relayBreaker, from flow/queue-a-e):
 * included reverts trip it ⇒ sends pause, notSent.
 *
 * Order (lee, 7:52 PM CT: "Run them in parallel, 384 ms"): [shape + $3 minimum + local signature recovery, no RPC] →
 * [Privy token (local crypto) ∥ revoke/strike/blocklist gate ∥ per-IP limit ∥ relayer warm ∥ exact simulation (starts
 * once the token and relayer are ready) ∥ Privy user/wallet match (60 s cache)] → budget → sign + sync send.
 * Pattern: speculative parallel validation, commit only after all gates pass (0x Gasless / Settler meta-tx relayers
 * validating off-chain before submit). A revoked / struck / blocklisted player is still refused BEFORE any budget
 * charge, cap reservation, breaker accounting or send — a completed simulation is discarded. The token check (local
 * crypto) still gates the eth_call so a missing/forged session never spends an RPC. Nothing is charged or signed
 * unless every admission check passed.
 */
import { encodeFunctionData, parseAbi, toFunctionSelector, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { ACTIVE_CHAIN, DEPLOYMENTS, robinhoodTestnet } from "../chains";
import { gaslessMode } from "../aa/sponsorshipMode";
import type { RelayReceipt } from "../aa/relayTypes";
import { checkGaslessRequest, encodeGaslessCall, GASLESS_GAS_LIMIT, GaslessReject, parseGaslessRequest, tradeTypedData, type GaslessRequest } from "../trade/gaslessPermit2";
import { relaySendBudget, requireNotRevokedOrStruck } from "./relayLockdown";
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
  /** Privy access token from `Authorization: Bearer …` (route). Required for trades. */
  authToken?: string | null };

/** BondingCurve.NotVerified() — only existing PvE curves still check LoginGate on-chain (buys). */
export const NOT_VERIFIED_SELECTOR = toFunctionSelector("error NotVerified()");
export const LEGACY_LOGIN_MESSAGE = "this coin's curve still requires an on-chain LoginGate login (pre-redeploy Easy curve); nothing sent";
const legacyLogin = (e: unknown) => {
  const x = e as { data?: unknown; message?: string };
  if ((typeof x.data === "string" && x.data.toLowerCase().startsWith(NOT_VERIFIED_SELECTOR)) || /NotVerified/.test(x.message ?? ""))
    return Object.assign(new Error(LEGACY_LOGIN_MESSAGE), { notSent: true, data: x.data, legacyLogin: true });
  return e;
};

/** Admission + exact simulation of ONE relayer tx; throws (notSent) in priority order session → gate → sim. */
async function admit(signer: Address, to: Hex, data: Hex, d: GaslessDeps, extra: Promise<unknown>[] = []): Promise<DirectRelayer> {
  const m = d.metrics;
  const relayer = directRelayer(m);
  const did = timed(m, "authSession", () => verifySessionToken(d.authToken));
  const owner = did.then(x => timed(m, "authSessionWallet", () => requireSessionWallet(x, signer)));
  const gate = timed(m, "revokeStrikeGate", () => requireNotRevokedOrStruck(signer));
  // Speculative sim ∥ revoke/strike/blocklist read. The eth_call starts once the token (local crypto) and the relayer
  // (needed for `from`) are ready — it does not wait for the gate. admit() still joins every gate before returning, so
  // commit (budget / cap / breaker / send) cannot run if the gate (or token, or wallet match) failed; a finished
  // simulation is then discarded. Gate is listed before sim in `all` so a revoke/strike error wins the throw if both fail.
  const sim = Promise.all([relayer, did]).then(([r]) => timed(m, "simulate", () => simulateDirect(r.address, to, data).catch(e => { throw legacyLogin(e); })));
  const all = [did, owner, gate, d.ipGate ?? Promise.resolve(), ...extra, sim, relayer];
  const res = await timed(m, "admissionSimulationWall", () => Promise.allSettled(all));
  for (const x of res) if (x.status === "rejected") throw notSent(x.reason);
  return (res[res.length - 1] as PromiseFulfilledResult<DirectRelayer>).value;
}

/** Budget (after the exact simulation passed) → sign + sync send → strike / breaker on an included revert. */
async function commit(signer: Address, to: Hex, data: Hex, gas: bigint, r: DirectRelayer, d: GaslessDeps, t0: number, tAdm: number): Promise<GaslessConfirmed> {
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
    strikeSender(signer);
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
  const r = await admit(q.signer, router, data, d);
  return commit(q.signer, router, data, GASLESS_GAS_LIMIT, r, d, t0, Date.now() - t0);
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
