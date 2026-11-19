import "server-only";
/**
 * Anon launch pool relay (lib/anonPool). Three JSON-RPC methods on /api/gasless:
 *   disciple_anonPoolBalance [{ wallet }]                      → { balance } (raw USDG), settling any unclear spends first
 *   disciple_anonPoolCredit  [{ wallet, txHash }]              → credits a top-up (USDG transfer / gasless withdraw to the pool)
 *   disciple_anonPoolLaunch  [{ wallet, usdgIn, launch }]      → the site signs a PoolLaunch, a relayer sends AnonLaunchPool.launch
 *   disciple_anonPoolPayout  [{ wallet, to, amount }]          → cash out the anon balance
 * Same admission as every relayed action: Privy identity token, the session's wallet, revoke / strike / blocklist, the IP
 * gate, relayer pool, exact simulation, budget after simulation, breaker. `wallet` is used ONLY off-chain (the session
 * check, the send budget and strikes). It is never in the launch transaction: that holds the relayer, the pool, the
 * launcher and the stealth owner.
 *
 * Money rule: the anon balance is debited before the send and credited back on any path where the pool did not pay
 * (not sent, simulation failed, included revert). The part of a First BOOST the Launchpad refunded (partial fill) is
 * credited back from the PoolLaunched event. A send whose outcome is unclear leaves a hold that the next balance read
 * settles from the chain (usedNonce + PoolLaunched / PaidOut logs).
 */
import { createPublicClient, decodeEventLog, encodeFunctionData, parseAbiItem, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ACTIVE_CHAIN, deployment } from "../chains";
import { ANON_ADDONS } from "../anon";
import { ANON_ANY_MODE_LIVE } from "../anonModes";
import { anonPoolAbi, anonPoolAddress, anonPoolDomain, PAYOUT_TYPES, POOL_LAUNCH_TYPES, poolLaunchHash, type PoolLaunchArgs } from "../anonPool";
import { creatorFeeRoutingAvailable } from "../quickLaunch";
import { ANON_LAUNCH_LIMITS, ANON_LAUNCH_TX_GAS_LIMIT, anonLaunchTooLong } from "../trade/gaslessAnonLaunch";
import { GaslessReject, GASLESS_MAX_DEADLINE_SEC } from "../trade/gaslessPermit2";
import { AnonPoolLedger } from "./anonPoolLedger";
import { kv } from "./kv";
import { requireGaslessMode, type GaslessConfirmed, type GaslessDeps } from "./gaslessRelay";
import { requireSessionWallet, verifySessionToken } from "./gaslessSession";
import { requireNotRevokedOrStruck, relaySendBudget } from "./relayLockdown";
import { directRelayer, sendDirect, simulateDirect, strikeSender, type DirectRelayer } from "./fastRelay";
import { relayBreaker } from "./relayBreaker";
import { shouldStrikeIncludedRevert } from "./gaslessStrike";
import { relayReadTransport } from "./relayReadTransport";

const notSent = (e: unknown) => Object.assign(e as Error, { notSent: true });
const pc = createPublicClient({ chain: ACTIVE_CHAIN, transport: relayReadTransport(5000, 0) });
const PAYOUT_GAS = BigInt(200_000);
/** Signed spends live this long; the relay sends at once, so this only bounds a stuck tx. */
const SPEND_TTL_SEC = 120;
const HOLD_TTL_SEC = 7 * 24 * 3600;

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const isZero = (a: string) => /^0x0{40}$/i.test(a);
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const addr = (v: unknown, what: string): Address => {
  if (typeof v !== "string" || !ADDR.test(v) || isZero(v)) throw new GaslessReject(`bad ${what}`);
  return v as Address;
};
const big = (v: unknown, what: string): bigint => {
  if ((typeof v === "string" && /^[0-9]{1,78}$/.test(v)) || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) return BigInt(v);
  throw new GaslessReject(`bad ${what}`);
};
const hex = (v: unknown, what: string): Hex => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v) || v.length % 2) throw new GaslessReject(`bad ${what}`);
  return v as Hex;
};
const small = (v: unknown, what: string): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (n === 0 || n === 1 || n === 2) return n;
  throw new GaslessReject(`bad ${what}`);
};
const str = (v: unknown, what: string): string => { if (typeof v !== "string") throw new GaslessReject(`bad ${what}`); return v; };

export function poolAddress(chainId = ACTIVE_CHAIN.id): Address {
  const a = anonPoolAddress(chainId);
  if (!a) throw notSent(new GaslessReject("anon launches aren't available on this chain yet"));
  return a;
}

function spendSigner() {
  const k = process.env.ANON_POOL_SIGNER_KEY;
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw notSent(new Error("anon pool signer isn't configured"));
  return privateKeyToAccount(k as Hex);
}

const randomNonce = (): bigint => {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return BigInt("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));
};

export const ledger = () => new AnonPoolLedger(ACTIVE_CHAIN.id);

// ───────── holds: a spend whose outcome was unclear (settled on the next balance read) ─────────

type Hold = { kind: "launch" | "payout"; nonce: string; amount: string; deadline: number };
const holdsKey = (did: string) => `anonpool:holds:${ACTIVE_CHAIN.id}:${did}`;
const holdKey = (did: string, nonce: bigint) => `anonpool:hold:${ACTIVE_CHAIN.id}:${did}:${nonce.toString()}`;

async function addHold(did: string, h: Hold) {
  await kv().setNX(holdKey(did, BigInt(h.nonce)), JSON.stringify(h), HOLD_TTL_SEC);
  await kv().sadd(holdsKey(did), h.nonce);
}

const POOL_LAUNCHED = parseAbiItem("event PoolLaunched(address indexed token, address indexed curve, uint256 indexed nonce, uint256 usdgIn, uint256 spent)");
const PAID_OUT = parseAbiItem("event PaidOut(uint256 indexed nonce, address indexed to, uint256 amount)");

/** Settle unclear spends once their signed deadline has passed: unused nonce ⇒ refund all; used ⇒ refund what the pool kept. */
export async function settleHolds(did: string, nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
  const pool = poolAddress();
  for (const n of await kv().smembers(holdsKey(did))) {
    const nonce = BigInt(n);
    const raw = await kv().get(holdKey(did, nonce));
    if (!raw) continue;
    const h = JSON.parse(raw) as Hold;
    if (nowSec <= h.deadline + 30) continue; // still could land
    const used = await pc.readContract({ address: pool, abi: anonPoolAbi, functionName: "usedNonce", args: [nonce] });
    let refund = BigInt(h.amount);
    if (used) {
      if (h.kind === "payout") refund = BigInt(0);
      else {
        const logs = await pc.getLogs({ address: pool, event: POOL_LAUNCHED, args: { nonce }, fromBlock: deployment().fromBlock, toBlock: "latest" });
        if (!logs.length) continue; // used but not found yet: try again later
        refund = BigInt(h.amount) - (logs[0].args.spent ?? BigInt(h.amount));
      }
    }
    if ((await kv().getDel(holdKey(did, nonce))) === null) continue; // someone else settled it
    if (refund > BigInt(0)) await ledger().credit(did, refund);
  }
}

// ───────── admission ─────────

async function admit(wallet: Address, d: GaslessDeps): Promise<{ did: string }> {
  const session = await verifySessionToken(d.idToken);
  await Promise.all([requireSessionWallet(session, wallet), requireNotRevokedOrStruck(wallet, Date.now(), session.did), d.ipGate ?? Promise.resolve()]);
  return { did: session.did };
}

async function send(wallet: Address, did: string, to: Address, data: Hex, gas: bigint, r: DirectRelayer, d: GaslessDeps, t0: number): Promise<GaslessConfirmed> {
  const tAdm = Date.now() - t0;
  const tb = Date.now();
  const refundBudget = await relaySendBudget(wallet, d.metrics).catch((e) => { throw notSent(e); });
  const budget = Date.now() - tb;
  let res;
  try { res = await sendDirect(r, to, data, gas, d.onPending, d.metrics); }
  catch (e) { if ((e as { notSent?: boolean }).notSent) await refundBudget().catch(() => undefined); throw e; }
  const success = res.rc.status === "0x1";
  if (!success) {
    let revertData: string | undefined;
    try { await simulateDirect(r.address, to, data, gas); } catch (e) { revertData = (e as { data?: string }).data; }
    if (shouldStrikeIncludedRevert({ revertData, gasUsed: BigInt(res.rc.gasUsed), gasLimit: gas })) strikeSender(wallet, did);
    const price = res.rc.effectiveGasPrice ? BigInt(res.rc.effectiveGasPrice) : BigInt(0);
    await relayBreaker.record({ reverted: true, lossWei: BigInt(res.rc.gasUsed) * price }).catch(() => false);
  }
  return { kind: "confirmed", txHash: res.txHash, success, receipt: res.rc, gasUsed: Number(BigInt(res.rc.gasUsed)), via: String(res.via),
    t: { admission: tAdm, budget, send: res.sendMs + res.minedMs, total: Date.now() - t0 } };
}

/** Debit → sign → simulate → send, crediting back on every path where the pool did not pay. */
async function spend(o: {
  kind: Hold["kind"]; wallet: Address; did: string; amount: bigint; nonce: bigint; deadline: number;
  data: Hex; gas: bigint; d: GaslessDeps; t0: number; refundOnSuccess: (c: GaslessConfirmed) => bigint;
}): Promise<GaslessConfirmed> {
  const pool = poolAddress();
  const L = ledger();
  await L.debit(o.did, o.amount);
  let r: DirectRelayer;
  try {
    r = await directRelayer(o.d.metrics);
    await simulateDirect(r.address, pool, o.data, o.gas);
  } catch (e) { await L.credit(o.did, o.amount); throw notSent(e); }
  let c: GaslessConfirmed;
  try { c = await send(o.wallet, o.did, pool, o.data, o.gas, r, o.d, o.t0); }
  catch (e) {
    if ((e as { notSent?: boolean }).notSent) await L.credit(o.did, o.amount);
    else await addHold(o.did, { kind: o.kind, nonce: o.nonce.toString(), amount: o.amount.toString(), deadline: o.deadline });
    throw e;
  }
  const back = c.success ? o.refundOnSuccess(c) : o.amount;
  if (back > BigInt(0)) await L.credit(o.did, back);
  return c;
}

// ───────── launch ─────────

export type AnonPoolLaunchRequest = { wallet: Address; usdgIn: bigint; launch: PoolLaunchArgs };

export function parseAnonPoolLaunchRequest(x: unknown): AnonPoolLaunchRequest {
  const o = (x ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const l = o.launch ?? {}, p = l.p ?? {};
  const viewTag = hex(l.viewTag ?? "0x00", "viewTag");
  if (viewTag.length !== 4) throw new GaslessReject("bad viewTag");
  return {
    wallet: addr(o.wallet, "wallet"),
    usdgIn: big(o.usdgIn ?? "0", "usdgIn"),
    launch: {
      p: {
        name: str(p.name, "name"), ticker: str(p.ticker, "ticker"), imageURI: str(p.imageURI, "imageURI"),
        description: str(p.description ?? "", "description"), socialsURI: str(p.socialsURI ?? "", "socialsURI"),
        quote: addr(p.quote, "quote"), creatorTaxBps: big(p.creatorTaxBps, "creatorTaxBps"),
        creatorBuyQuoteIn: big(p.creatorBuyQuoteIn ?? "0", "creatorBuyQuoteIn"),
        creatorBuyMinTokensOut: big(p.creatorBuyMinTokensOut ?? "0", "creatorBuyMinTokensOut"), deadline: big(p.deadline, "deadline"),
      },
      mode: small(l.mode ?? 0, "mode"),
      stealthOwner: addr(l.stealthOwner, "stealthOwner"),
      buyRecipient: addr(l.buyRecipient, "buyRecipient"),
      ephemeralPubKey: hex(l.ephemeralPubKey ?? "0x", "ephemeralPubKey"),
      viewTag,
      minQuoteIn: big(l.minQuoteIn ?? "0", "minQuoteIn"),
      creatorFeeDestination: small(l.creatorFeeDestination ?? 0, "creatorFeeDestination"),
    },
  };
}

/** Rules checked before any RPC. `wallet` may never be a launch field (it would put the player back in the tx). */
export function checkAnonPoolLaunch(q: AnonPoolLaunchRequest, o: { pool: Address; launcher: Address; harvest: Address | null; nowSec: number }): void {
  const l = q.launch;
  const tooLong = anonLaunchTooLong(l.p);
  if (tooLong) throw new GaslessReject(tooLong);
  if ((l.ephemeralPubKey.length - 2) / 2 > ANON_LAUNCH_LIMITS.ephemeralPubKey) throw new GaslessReject("bad ephemeralPubKey");
  if (!ANON_ANY_MODE_LIVE && l.mode) throw new GaslessReject("hidden launches are Expert only for now");
  if (l.creatorFeeDestination !== 0 && !o.harvest) throw new GaslessReject("private fee routing isn't available yet");
  for (const a of [l.stealthOwner, l.buyRecipient]) {
    if (eq(a, q.wallet)) throw new GaslessReject("your wallet can't be in an anon launch");
    if (eq(a, o.pool) || eq(a, o.launcher) || (o.harvest && eq(a, o.harvest))) throw new GaslessReject("coins cannot go to the launcher");
  }
  const now = BigInt(o.nowSec);
  if (l.p.deadline <= now || l.p.deadline > now + BigInt(GASLESS_MAX_DEADLINE_SEC)) throw new GaslessReject("deadline out of range");
}

export async function relayAnonPoolLaunch(raw: unknown, d: GaslessDeps = {}): Promise<GaslessConfirmed & { spent: string }> {
  const t0 = Date.now();
  let q: AnonPoolLaunchRequest;
  const pool = poolAddress();
  try {
    requireGaslessMode();
    relayBreaker.assertClosed();
    q = parseAnonPoolLaunchRequest(raw);
    const launcher = ANON_ADDONS[ACTIVE_CHAIN.id]?.anonLauncher;
    if (!launcher) throw new GaslessReject("private launches aren't available on this chain");
    const dep = deployment();
    const harvest = creatorFeeRoutingAvailable({ private: true, harvest: dep.creatorFeeHarvest }) && !isZero(dep.creatorFeeHarvest) ? dep.creatorFeeHarvest : null;
    checkAnonPoolLaunch(q, { pool, launcher, harvest, nowSec: d.nowSec ?? Math.floor(Date.now() / 1000) });
  } catch (e) { throw notSent(e); }
  const { did } = await admit(q.wallet, d).catch((e) => { throw notSent(e); });
  await settleHolds(did).catch(() => undefined);

  const nonce = randomNonce();
  const deadline = Math.floor(Date.now() / 1000) + SPEND_TTL_SEC;
  const sig = await spendSigner().signTypedData({
    domain: anonPoolDomain(ACTIVE_CHAIN.id, pool), types: POOL_LAUNCH_TYPES, primaryType: "PoolLaunch",
    message: { launchHash: poolLaunchHash(q.launch), usdgIn: q.usdgIn, nonce, deadline: BigInt(deadline) },
  });
  const data = encodeFunctionData({ abi: anonPoolAbi, functionName: "launch", args: [q.launch, q.usdgIn, nonce, BigInt(deadline), sig] });
  let spent = q.usdgIn;
  const c = await spend({
    kind: "launch", wallet: q.wallet, did, amount: q.usdgIn, nonce, deadline, data, gas: ANON_LAUNCH_TX_GAS_LIMIT, d, t0,
    refundOnSuccess: (c) => {
      for (const log of c.receipt.logs ?? []) {
        if (!eq(log.address, pool)) continue;
        try {
          const ev = decodeEventLog({ abi: [POOL_LAUNCHED], data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
          if (ev.args.nonce === nonce) { spent = ev.args.spent; return q.usdgIn - ev.args.spent; }
        } catch { /* other pool event */ }
      }
      return BigInt(0);
    },
  });
  return { ...c, spent: spent.toString() };
}

// ───────── payout ─────────

export async function relayAnonPoolPayout(raw: unknown, d: GaslessDeps = {}): Promise<GaslessConfirmed> {
  const t0 = Date.now();
  const pool = poolAddress();
  let wallet: Address, to: Address, amount: bigint;
  try {
    requireGaslessMode();
    relayBreaker.assertClosed();
    const o = (raw ?? {}) as Record<string, unknown>;
    wallet = addr(o.wallet, "wallet"); to = addr(o.to, "to"); amount = big(o.amount, "amount");
    if (amount === BigInt(0)) throw new GaslessReject("nothing to cash out");
    if (eq(to, pool)) throw new GaslessReject("bad to");
  } catch (e) { throw notSent(e); }
  const { did } = await admit(wallet, d).catch((e) => { throw notSent(e); });
  await settleHolds(did).catch(() => undefined);
  const nonce = randomNonce();
  const deadline = Math.floor(Date.now() / 1000) + SPEND_TTL_SEC;
  const sig = await spendSigner().signTypedData({
    domain: anonPoolDomain(ACTIVE_CHAIN.id, pool), types: PAYOUT_TYPES, primaryType: "Payout",
    message: { to, amount, nonce, deadline: BigInt(deadline) },
  });
  const data = encodeFunctionData({ abi: anonPoolAbi, functionName: "payout", args: [to, amount, nonce, BigInt(deadline), sig] });
  return spend({ kind: "payout", wallet, did, amount, nonce, deadline, data, gas: PAYOUT_GAS, d, t0, refundOnSuccess: () => BigInt(0) });
}

// ───────── top-up + balance ─────────

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const WITHDRAWN = parseAbiItem("event Withdrawn(address indexed owner, address indexed token, address indexed to, uint256 net, uint256 fee, address feeTo)");

/**
 * Credit a top-up the session's wallet sent to the pool: a USDG Transfer(wallet → pool) (plain transfer or pool.deposit),
 * or a gasless withdraw to the pool (DisciplePermitForwarder Withdrawn(owner = wallet, to = pool)). Each log counts once.
 */
export async function creditAnonDeposit(raw: unknown, d: GaslessDeps = {}): Promise<{ credited: string; balance: string }> {
  const pool = poolAddress();
  const o = (raw ?? {}) as Record<string, unknown>;
  const wallet = addr(o.wallet, "wallet");
  const txHash = hex(o.txHash, "txHash");
  if (txHash.length !== 66) throw new GaslessReject("bad txHash");
  const { did } = await admit(wallet, d);
  const rc = await pc.getTransactionReceipt({ hash: txHash });
  if (rc.status !== "success") throw new GaslessReject("that top-up didn't go through");
  const dep = deployment();
  let credited = BigInt(0);
  for (const log of rc.logs) {
    let amount: bigint | null = null;
    try {
      if (eq(log.address, dep.usdg)) {
        const ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
        if (eq(ev.args.from, wallet) && eq(ev.args.to, pool)) amount = ev.args.value;
      } else if (!isZero(dep.permitForwarder) && eq(log.address, dep.permitForwarder)) {
        const ev = decodeEventLog({ abi: [WITHDRAWN], data: log.data, topics: log.topics });
        if (eq(ev.args.owner, wallet) && eq(ev.args.token, dep.usdg) && eq(ev.args.to, pool)) amount = ev.args.net;
      }
    } catch { continue; }
    if (amount && amount > BigInt(0) && (await ledger().creditDepositOnce(did, `${txHash}:${log.logIndex}`, amount))) credited += amount;
  }
  return { credited: credited.toString(), balance: (await ledger().balance(did)).toString() };
}

export async function anonPoolBalance(raw: unknown, d: GaslessDeps = {}): Promise<{ balance: string; pool: Address }> {
  const pool = poolAddress();
  const o = (raw ?? {}) as Record<string, unknown>;
  const { did } = await admit(addr(o.wallet, "wallet"), d);
  await settleHolds(did).catch(() => undefined);
  return { balance: (await ledger().balance(did)).toString(), pool };
}
