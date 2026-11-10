import "server-only";
/**
 * Gasless withdrawal relay (flow/gasless-withdraw). Same admission gate as gasless trades (Privy identity token,
 * revoke/strike/blocklist, H1/M1/M2 identity), same strike policy (only sender-caused validation failures), same
 * relayer pool / exact simulation / budget-after-sim / breaker. Does not touch the trade path.
 *
 * Fee: estimated gas × live base fee (what Robinhood Chain bills) × the old USDG paymaster rate (rateFromEnv +
 * unmarkedRate, 1.0x). Quoted fee is kept. feeTo is the configured relayer EOA (stable across the pool: a pool key
 * may broadcast, the fee still lands on the relayer address the player was shown).
 */
import { createPublicClient, parseAbi, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEPLOYMENTS, robinhoodTestnet } from "../chains";
import { GaslessReject } from "../trade/gaslessPermit2";
import {
  MULTICALL3, checkGaslessWithdrawRequest, encodeWithdrawCall, minWithdrawAmount,
  parseGaslessWithdrawRequest, transferTypedData, withdrawFeeRaw, withdrawGas, WITHDRAW_TX_GAS_LIMIT,
  type GaslessWithdrawRequest,
} from "../trade/gaslessWithdraw";
import { PERMIT2 } from "../trade/gaslessPermit2";
import { rateFromEnv, unmarkedRate } from "./paymasterCore";
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
const pc = createPublicClient({ chain: robinhoodTestnet, transport: relayReadTransport(5000, 0) });

/** Same USDG-per-ETH source as the old paymaster (1.0x, no markup). */
export function withdrawUsdgPerEth(env: NodeJS.ProcessEnv = process.env, usdgDecimals = DEPLOYMENTS[46630].usdgDecimals): bigint {
  return unmarkedRate(rateFromEnv({ PAYMASTER_RATE: env.PAYMASTER_RATE, PAYMASTER_USD_PER_ETH: env.PAYMASTER_USD_PER_ETH }, usdgDecimals));
}

/** Configured relayer EOA — the fee recipient shown to the player and encoded in the Permit2 transfer. */
export function withdrawFeeTo(): Address {
  return privateKeyToAccount(relayerKey()).address;
}

export type WithdrawQuoteResult = {
  fee: string; feeTo: Address; gas: string; gasPrice: string; rate: string;
  usdg: Address; usdgDecimals: number; minAmount: string; spender: typeof MULTICALL3; permit2: typeof PERMIT2;
};

export type QuoteOpts = {
  nowSec?: number;
  baseFee?: bigint;
  rate?: bigint;
  feeTo?: Address;
  needsPermit?: boolean;
  usdgDecimals?: number;
};

/** disciple_gaslessWithdrawQuote: no signature, no Privy session. */
export async function quoteGaslessWithdraw(raw: unknown = {}, opts: QuoteOpts = {}): Promise<WithdrawQuoteResult> {
  requireGaslessMode();
  const dep = DEPLOYMENTS[46630];
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
  const gas = withdrawGas(needsPermit);
  const feeTo = opts.feeTo ?? withdrawFeeTo();
  const baseFee = opts.baseFee ?? (await directRelayer()).fee;
  const rate = opts.rate ?? withdrawUsdgPerEth();
  const fee = withdrawFeeRaw(gas, baseFee, rate, decimals);
  return {
    fee: fee.toString(), feeTo, gas: gas.toString(), gasPrice: baseFee.toString(), rate: rate.toString(),
    usdg: dep.usdg, usdgDecimals: decimals, minAmount: minWithdrawAmount(fee, decimals).toString(),
    spender: MULTICALL3, permit2: PERMIT2,
  };
}

async function admitWithdraw(signer: Address, data: Hex, d: GaslessDeps): Promise<{ relayer: DirectRelayer; did: string }> {
  const m = d.metrics;
  const relayer = directRelayer(m);
  const session = timed(m, "authSession", () => verifySessionToken(d.idToken));
  const owner = session.then(x => timed(m, "authSessionWallet", () => requireSessionWallet(x, signer)));
  const gate = session.then(x => timed(m, "revokeStrikeGate", () => requireNotRevokedOrStruck(signer, Date.now(), x.did)));
  const sim = Promise.all([relayer, session]).then(([r]) => timed(m, "simulate", () => simulateDirect(r.address, MULTICALL3, data)));
  const all = [session, owner, gate, d.ipGate ?? Promise.resolve(), sim, relayer];
  const res = await timed(m, "admissionSimulationWall", () => Promise.allSettled(all));
  for (const x of res) if (x.status === "rejected") throw notSent(x.reason);
  return {
    relayer: (res[all.indexOf(relayer)] as PromiseFulfilledResult<DirectRelayer>).value,
    did: (res[all.indexOf(session)] as PromiseFulfilledResult<{ did: string }>).value.did,
  };
}

async function commitWithdraw(signer: Address, data: Hex, gas: bigint, r: DirectRelayer, d: GaslessDeps, t0: number, tAdm: number, did?: string): Promise<GaslessConfirmed> {
  const m = d.metrics;
  const tb = Date.now();
  const refund = await relaySendBudget(signer, m).catch(e => { throw notSent(e); });
  const budget = Date.now() - tb;
  let res;
  try { res = await sendDirect(r, MULTICALL3, data, gas, d.onPending, m); }
  catch (e) { if ((e as { notSent?: boolean }).notSent) await refund().catch(() => undefined); throw e; }
  const success = res.rc.status === "0x1";
  const gasUsed = Number(BigInt(res.rc.gasUsed));
  if (!success) {
    let revertData: string | undefined;
    try { await simulateDirect(r.address, MULTICALL3, data); }
    catch (e) { revertData = (e as { data?: string }).data; }
    if (shouldStrikeIncludedRevert({ revertData, gasUsed: BigInt(res.rc.gasUsed), gasLimit: gas })) strikeSender(signer, did);
    const price = res.rc.effectiveGasPrice ? BigInt(res.rc.effectiveGasPrice) : BigInt(0);
    await relayBreaker.record({ reverted: true, lossWei: BigInt(res.rc.gasUsed) * price }).catch(() => false);
  }
  return { kind: "confirmed", txHash: res.txHash, success, receipt: res.rc, gasUsed, via: String(res.via),
    t: { admission: tAdm, budget, send: res.sendMs + res.minedMs, total: Date.now() - t0 } };
}

/** disciple_gaslessWithdraw: two signed Permit2 transfers → one Multicall3 relayer tx. */
export async function relayGaslessWithdraw(raw: unknown, d: GaslessDeps = {}): Promise<GaslessConfirmed> {
  const t0 = Date.now();
  let q: GaslessWithdrawRequest;
  const dep = DEPLOYMENTS[46630];
  try {
    requireGaslessMode();
    relayBreaker.assertClosed();
    q = parseGaslessWithdrawRequest(raw);
    const feeTo = withdrawFeeTo();
    const rate = withdrawUsdgPerEth();
    const needsPermit = !!(q.approval && q.approval.value > BigInt(0));
    const gas = withdrawGas(needsPermit);
    // Live re-quote: the signed fee must cover today's estimate; the player still pays the quoted (signed) fee.
    const current = withdrawFeeRaw(gas, (await directRelayer()).fee, rate, dep.usdgDecimals);
    if (q.fee < current) throw new GaslessReject("fee changed, please retry");
    checkGaslessWithdrawRequest(q, { usdg: dep.usdg, usdgDecimals: dep.usdgDecimals, nowSec: d.nowSec ?? Math.floor(Date.now() / 1000), feeTo, minFee: current });
    const netWho = await recoverTypedDataAddress({ ...transferTypedData(robinhoodTestnet.id, q.netPermit), signature: q.netSignature });
    const feeWho = await recoverTypedDataAddress({ ...transferTypedData(robinhoodTestnet.id, q.feePermit), signature: q.feeSignature });
    if (netWho.toLowerCase() !== q.signer.toLowerCase() || feeWho.toLowerCase() !== q.signer.toLowerCase())
      throw new GaslessReject("signature is not the signer's");
  } catch (e) { throw notSent(e); }
  const data = encodeWithdrawCall(q, dep.usdg);
  const { relayer, did } = await admitWithdraw(q.signer, data, d);
  return commitWithdraw(q.signer, data, WITHDRAW_TX_GAS_LIMIT, relayer, d, t0, Date.now() - t0, did);
}

export type { OnPending };
