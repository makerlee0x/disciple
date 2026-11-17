import "server-only";
/**
 * Gasless withdrawal relay (flow/gasless-withdraw). Same admission gate as gasless trades (Privy identity token,
 * revoke/strike/blocklist, H1/M1/M2 identity), same strike policy (only sender-caused validation failures), same
 * relayer pool / exact simulation / budget-after-sim / breaker. Does not touch the trade path.
 *
 * Fee: estimated gas × live base fee (what Robinhood Chain bills) × the old USDG paymaster rate (rateFromEnv +
 * unmarkedRate from usdgEthRate, 1.0x; same helpers formerly in paymasterCore). Quoted fee is kept. feeTo is the configured relayer EOA (stable across the pool: a pool key
 * may broadcast, the fee still lands on the relayer address the player was shown).
 */
import { createPublicClient, encodeFunctionData, parseAbi, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ACTIVE_CHAIN, deployment } from "../chains";
import { GaslessReject } from "../trade/gaslessPermit2";
import {
  checkForwarderWithdrawRequest, checkGaslessWithdrawRequest, encodeForwarderWithdrawCall, encodeWithdrawCall, isForwarderWithdraw,
  minWithdrawAmount, MULTICALL3, multicall3Abi, parseAnyWithdrawRequest, transferTypedData, withdrawFeeRaw, withdrawGas, WITHDRAW_TX_GAS_LIMIT,
  type AnyWithdrawRequest, type ForwarderWithdrawRequest,
} from "../trade/gaslessWithdraw";
import { relaySpender, withdrawTypedData } from "../trade/permitForwarder";
import { PERMIT2 } from "../trade/gaslessPermit2";
import { rateFromEnv, unmarkedRate } from "./usdgEthRate";
import { requireGaslessMode, type GaslessConfirmed, type GaslessDeps } from "./gaslessRelay";
import { shouldStrikeIncludedRevert } from "./gaslessStrike";
import { relaySendBudget, requireNotRevokedOrStruck } from "./relayLockdown";
import { requireSessionWallet, verifySessionToken } from "./gaslessSession";
import { directRelayer, sendDirect, simulateDirect, strikeSender, type DirectRelayer, type OnPending } from "./fastRelay";
import { relayBreaker } from "./relayBreaker";
import type { RelayMetrics } from "./relayMetrics";
import { relayerKey } from "./relayer";
import { relayReadTransport } from "./relayReadTransport";

const timed = <T>(m: RelayMetrics | undefined, stage: string, task: () => Promise<T>) => m ? m.span(stage, task) : task();
const notSent = (e: unknown) => Object.assign(e as Error, { notSent: true });
const erc20 = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);
const ENOUGH = BigInt(2) ** BigInt(255);
const pc = createPublicClient({ chain: ACTIVE_CHAIN, transport: relayReadTransport(5000, 0) });

/** Same USDG-per-ETH source as the old paymaster (1.0x, no markup). */
export function withdrawUsdgPerEth(env: NodeJS.ProcessEnv = process.env, usdgDecimals = deployment().usdgDecimals): bigint {
  return unmarkedRate(rateFromEnv({ PAYMASTER_RATE: env.PAYMASTER_RATE, PAYMASTER_USD_PER_ETH: env.PAYMASTER_USD_PER_ETH }, usdgDecimals));
}

/** Configured relayer EOA — the fee recipient shown to the player and encoded in the Permit2 transfer. */
export function withdrawFeeTo(): Address {
  return privateKeyToAccount(relayerKey()).address;
}

export type WithdrawQuoteResult = {
  fee: string; feeTo: Address; gas: string; gasPrice: string; rate: string;
  usdg: Address; usdgDecimals: number; minAmount: string; spender: Address; permit2: typeof PERMIT2;
};

export type QuoteOpts = {
  nowSec?: number;
  baseFee?: bigint;
  rate?: bigint;
  feeTo?: Address;
  needsPermit?: boolean;
  usdgDecimals?: number;
  /** more forwarder withdraws batched into the same tx (a market buy pays the seller and the treasury: 1) */
  extraWithdraws?: number;
};

/** disciple_gaslessWithdrawQuote: no signature, no Privy session. */
export async function quoteGaslessWithdraw(raw: unknown = {}, opts: QuoteOpts = {}): Promise<WithdrawQuoteResult> {
  requireGaslessMode();
  // the spender the player will sign for: the forwarder when deployed; Multicall3 only on testnet (throws elsewhere)
  const spender = relaySpender(ACTIVE_CHAIN.id).address;
  const dep = deployment();
  const decimals = opts.usdgDecimals ?? dep.usdgDecimals;
  const o = (raw ?? {}) as { amount?: unknown; signer?: unknown };
  let needsPermit = opts.needsPermit;
  if (needsPermit === undefined && typeof o.signer === "string" && /^0x[0-9a-fA-F]{40}$/.test(o.signer)) {
    try {
      const a = await pc.readContract({ address: dep.usdg, abi: erc20, functionName: "allowance", args: [o.signer as Address, PERMIT2] });
      needsPermit = a < ENOUGH;
    } catch { needsPermit = true; }
  }
  if (needsPermit === undefined) needsPermit = true; // conservative when we can't see the allowance
  const gas = withdrawGas(needsPermit) + BigInt(opts.extraWithdraws ?? 0) * withdrawGas(false);
  const feeTo = opts.feeTo ?? withdrawFeeTo();
  const baseFee = opts.baseFee ?? (await directRelayer()).fee;
  const rate = opts.rate ?? withdrawUsdgPerEth();
  const fee = withdrawFeeRaw(gas, baseFee, rate, decimals);
  return {
    fee: fee.toString(), feeTo, gas: gas.toString(), gasPrice: baseFee.toString(), rate: rate.toString(),
    usdg: dep.usdg, usdgDecimals: decimals, minAmount: minWithdrawAmount(fee, decimals).toString(),
    spender, permit2: PERMIT2,
  };
}

async function admitWithdraw(signer: Address, to: Address, data: Hex, d: GaslessDeps, gasLimit = WITHDRAW_TX_GAS_LIMIT): Promise<{ relayer: DirectRelayer; did: string }> {
  const m = d.metrics;
  const relayer = directRelayer(m);
  const session = timed(m, "authSession", () => verifySessionToken(d.idToken));
  const owner = session.then(x => timed(m, "authSessionWallet", () => requireSessionWallet(x, signer)));
  const gate = session.then(x => timed(m, "revokeStrikeGate", () => requireNotRevokedOrStruck(signer, Date.now(), x.did)));
  const sim = Promise.all([relayer, session]).then(([r]) => timed(m, "simulate", () => simulateDirect(r.address, to, data, gasLimit)));
  const all = [session, owner, gate, d.ipGate ?? Promise.resolve(), sim, relayer];
  const res = await timed(m, "admissionSimulationWall", () => Promise.allSettled(all));
  for (const x of res) if (x.status === "rejected") throw notSent(x.reason);
  return {
    relayer: (res[all.indexOf(relayer)] as PromiseFulfilledResult<DirectRelayer>).value,
    did: (res[all.indexOf(session)] as PromiseFulfilledResult<{ did: string }>).value.did,
  };
}

async function commitWithdraw(signer: Address, to: Address, data: Hex, gas: bigint, r: DirectRelayer, d: GaslessDeps, t0: number, tAdm: number, did?: string): Promise<GaslessConfirmed> {
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
    let revertData: string | undefined;
    try { await simulateDirect(r.address, to, data, gas); }
    catch (e) { revertData = (e as { data?: string }).data; }
    if (shouldStrikeIncludedRevert({ revertData, gasUsed: BigInt(res.rc.gasUsed), gasLimit: gas })) strikeSender(signer, did);
    const price = res.rc.effectiveGasPrice ? BigInt(res.rc.effectiveGasPrice) : BigInt(0);
    await relayBreaker.record({ reverted: true, lossWei: BigInt(res.rc.gasUsed) * price }).catch(() => false);
  }
  return { kind: "confirmed", txHash: res.txHash, success, receipt: res.rc, gasUsed, via: String(res.via),
    t: { admission: tAdm, budget, send: res.sendMs + res.minedMs, total: Date.now() - t0 } };
}

/**
 * disciple_gaslessWithdraw. With the forwarder deployed: one signed Permit2 witness transfer → DisciplePermitForwarder.withdraw
 * (the destination / fee / fee recipient are in the signature). Without it (testnet only, relaySpender): the old two signed
 * transfers → one Multicall3 tx. The two request shapes are never mixed: the spender decides which one is accepted.
 */
export async function relayGaslessWithdraw(raw: unknown, d: GaslessDeps = {}): Promise<GaslessConfirmed> {
  const t0 = Date.now();
  let q: AnyWithdrawRequest;
  let target: Address;
  const dep = deployment();
  try {
    requireGaslessMode();
    relayBreaker.assertClosed();
    const spender = relaySpender(ACTIVE_CHAIN.id);
    target = spender.address;
    q = parseAnyWithdrawRequest(raw);
    if (isForwarderWithdraw(q) !== (spender.kind === "forwarder"))
      throw new GaslessReject(spender.kind === "forwarder" ? "please update the app and try again" : "this network does not take forwarder withdrawals yet");
    const feeTo = withdrawFeeTo();
    const rate = withdrawUsdgPerEth();
    const needsPermit = !!(q.approval && q.approval.value > BigInt(0));
    const gas = withdrawGas(needsPermit);
    // Live re-quote: the signed fee must cover today's estimate; the player still pays the quoted (signed) fee.
    const current = withdrawFeeRaw(gas, (await directRelayer()).fee, rate, dep.usdgDecimals);
    if (q.fee < current) throw new GaslessReject("fee changed, please retry");
    const nowSec = d.nowSec ?? Math.floor(Date.now() / 1000);
    if (isForwarderWithdraw(q)) {
      checkForwarderWithdrawRequest(q, { usdg: dep.usdg, usdgDecimals: dep.usdgDecimals, nowSec, feeTo, minFee: current });
      const who = await recoverTypedDataAddress({
        ...withdrawTypedData(ACTIVE_CHAIN.id, target, q.permit, { to: q.destination, fee: q.fee, feeTo: q.feeTo }), signature: q.signature,
      });
      if (who.toLowerCase() !== q.signer.toLowerCase()) throw new GaslessReject("signature is not the signer's");
    } else {
      checkGaslessWithdrawRequest(q, { usdg: dep.usdg, usdgDecimals: dep.usdgDecimals, nowSec, feeTo, minFee: current });
      const netWho = await recoverTypedDataAddress({ ...transferTypedData(ACTIVE_CHAIN.id, q.netPermit), signature: q.netSignature });
      const feeWho = await recoverTypedDataAddress({ ...transferTypedData(ACTIVE_CHAIN.id, q.feePermit), signature: q.feeSignature });
      if (netWho.toLowerCase() !== q.signer.toLowerCase() || feeWho.toLowerCase() !== q.signer.toLowerCase())
        throw new GaslessReject("signature is not the signer's");
    }
  } catch (e) { throw notSent(e); }
  const data = isForwarderWithdraw(q) ? encodeForwarderWithdrawCall(q) : encodeWithdrawCall(q, dep.usdg);
  const { relayer, did } = await admitWithdraw(q.signer, target, data, d);
  return commitWithdraw(q.signer, target, data, WITHDRAW_TX_GAS_LIMIT, relayer, d, t0, Date.now() - t0, did);
}

/** Where the market's 7% goes (MARKET_TREASURY_ADDRESS). Unset ⇒ null, and buying stays off (fail closed). */
export function marketTreasury(env: NodeJS.ProcessEnv = process.env): Address | null {
  const a = env.MARKET_TREASURY_ADDRESS?.trim();
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as Address) : null;
}

export type MarketBuyRequest = { pay: ForwarderWithdrawRequest; cut: ForwarderWithdrawRequest };

/** JSON → the two signed forwarder withdraws of a market buy (pay: seller + network fee to the relayer; cut: 7% to the treasury). */
export function parseMarketBuyRequest(raw: unknown): MarketBuyRequest {
  const o = (raw ?? {}) as { pay?: unknown; cut?: unknown };
  const pay = parseAnyWithdrawRequest(o.pay), cut = parseAnyWithdrawRequest(o.cut);
  if (!isForwarderWithdraw(pay) || !isForwarderWithdraw(cut)) throw new GaslessReject("please update the app and try again");
  return { pay, cut };
}

/**
 * A market buy: two forwarder withdraws signed by the buyer, sent in one Multicall3 tx so both land or neither does.
 * pay sends the seller their share and the network fee to the relayer; cut sends the 7% straight to the treasury (no fee).
 * The market (lib/server/market.ts) has already checked the amounts against the listing.
 */
export async function relayMarketBuy(raw: unknown, d: GaslessDeps = {}): Promise<GaslessConfirmed> {
  const t0 = Date.now();
  let q: MarketBuyRequest;
  let data: Hex;
  const dep = DEPLOYMENTS[46630];
  try {
    requireGaslessMode();
    relayBreaker.assertClosed();
    const spender = relaySpender(robinhoodTestnet.id);
    if (spender.kind !== "forwarder") throw new GaslessReject("buying isn't available on this network yet");
    const treasury = marketTreasury();
    if (!treasury) throw new GaslessReject("buying is switched off right now");
    q = parseMarketBuyRequest(raw);
    if (q.pay.signer.toLowerCase() !== q.cut.signer.toLowerCase()) throw new GaslessReject("both payments must come from one wallet");
    if (q.cut.destination.toLowerCase() !== treasury.toLowerCase() || q.cut.fee !== BigInt(0)) throw new GaslessReject("market fee is not to the treasury");
    if (q.pay.permit.nonce === q.cut.permit.nonce) throw new GaslessReject("payments share a nonce");
    if (q.cut.approval && q.cut.approval.value > BigInt(0)) throw new GaslessReject("approval belongs on the first payment");
    const feeTo = withdrawFeeTo();
    const needsPermit = !!(q.pay.approval && q.pay.approval.value > BigInt(0));
    const gas = withdrawGas(needsPermit) + withdrawGas(false);
    const current = withdrawFeeRaw(gas, (await directRelayer()).fee, withdrawUsdgPerEth(), dep.usdgDecimals);
    if (q.pay.fee < current) throw new GaslessReject("fee changed, please retry");
    const nowSec = d.nowSec ?? Math.floor(Date.now() / 1000);
    checkForwarderWithdrawRequest(q.pay, { usdg: dep.usdg, usdgDecimals: dep.usdgDecimals, nowSec, feeTo, minFee: current });
    checkForwarderWithdrawRequest(q.cut, { usdg: dep.usdg, usdgDecimals: dep.usdgDecimals, nowSec, feeTo: q.cut.feeTo, minFee: BigInt(0) });
    for (const r of [q.pay, q.cut]) {
      const who = await recoverTypedDataAddress({
        ...withdrawTypedData(robinhoodTestnet.id, spender.address, r.permit, { to: r.destination, fee: r.fee, feeTo: r.feeTo }), signature: r.signature,
      });
      if (who.toLowerCase() !== r.signer.toLowerCase()) throw new GaslessReject("signature is not the signer's");
    }
    data = encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [[
      { target: spender.address, allowFailure: false, callData: encodeForwarderWithdrawCall(q.pay) },
      { target: spender.address, allowFailure: false, callData: encodeForwarderWithdrawCall(q.cut) },
    ]] });
  } catch (e) { throw notSent(e); }
  const limit = WITHDRAW_TX_GAS_LIMIT * BigInt(2);
  const { relayer, did } = await admitWithdraw(q.pay.signer, MULTICALL3, data, d, limit);
  return commitWithdraw(q.pay.signer, MULTICALL3, data, limit, relayer, d, t0, Date.now() - t0, did);
}

export type { OnPending };
