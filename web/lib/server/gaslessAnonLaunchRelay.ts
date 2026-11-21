import "server-only";
/**
 * Relayer-submitted private launch (flow/anon-launch-relayer). Same admission gate as
 * gasless trades and withdrawals (Privy identity token, revoke/strike/blocklist), same
 * strike policy, same relayer pool / exact simulation / budget-after-sim / breaker.
 * Does not touch the trade path or GASLESS_GAS_LIMIT.
 *
 * The player signs a Permit2 witness that binds every launch field and the exact USDG
 * amount (launch fee + First BOOST). The relayer submits one Multicall3 transaction:
 * pull USDG to Multicall3, approve AnonLauncher, launchAnonWithUsdg with refundTo = the
 * player. A failed simulation or a reverted launch never moves the player's dollars.
 */
import { createPublicClient, parseAbi, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { ACTIVE_CHAIN, deployment } from "../chains";
import { encodeForwarderLaunch, relaySpender, type RelaySpender } from "../trade/permitForwarder";
import { ANON_ADDONS } from "../anon";
import { GaslessReject } from "../trade/gaslessPermit2";
import { creatorFeeRoutingAvailable } from "../quickLaunch";
import { ANON_ANY_MODE_LIVE } from "../anonModes";
import { checkFreeAnonLaunch, encodeFreeAnonLaunch, parseFreeAnonLaunchRequest, type FreeAnonLaunchRequest } from "../trade/freeAnonLaunch";
import {
  ANON_LAUNCH_TX_GAS_LIMIT, anonLaunchTypedData, checkGaslessAnonLaunchRequest,
  parseGaslessAnonLaunchRequest, type GaslessAnonLaunchRequest,
} from "../trade/gaslessAnonLaunch";
import { requireGaslessMode, type GaslessConfirmed, type GaslessDeps } from "./gaslessRelay";
import { shouldStrikeIncludedRevert } from "./gaslessStrike";
import { relaySendBudget, requireNotRevokedOrStruck } from "./relayLockdown";
import { requireSessionWallet, verifySessionToken } from "./gaslessSession";
import { directRelayer, sendDirect, simulateDirect, strikeSender, type DirectRelayer } from "./fastRelay";
import { recordSenderRevert, relayBreaker } from "./relayBreaker";
import type { RelayMetrics } from "./relayMetrics";
import { relayReadTransport } from "./relayReadTransport";
import { withdrawFeeRaw } from "../trade/gaslessWithdraw";
import { withdrawFeeTo } from "./gaslessWithdrawRelay";
import { liveUsdgPerEth } from "./usdgEthRate";
import { reserveTab } from "./launchTab";
/** Runs `send` with `amount` reserved on the tab first; a send that moved nothing, or a revert, takes it back. */
async function withTab<T extends { success: boolean }>(wallet: Address, amount: bigint, refusal: string, send: () => Promise<T>): Promise<T> {
  const release = await reserveTab(wallet, amount, refusal);
  let res: T;
  try { res = await send(); }
  catch (e) { if ((e as { notSent?: boolean }).notSent) await release().catch(() => undefined); throw e; }
  if (!res.success) await release().catch(() => undefined);   // a revert is the relayer's loss, as for any relayed tx
  return res;
}


const timed = <T>(m: RelayMetrics | undefined, stage: string, task: () => Promise<T>) => m ? m.span(stage, task) : task();
const notSent = (e: unknown) => Object.assign(e as Error, { notSent: true });
const launcherAbi = parseAbi(["function launchFee() view returns (uint256)", "function feeToken() view returns (address)"]);
const pc = createPublicClient({ chain: ACTIVE_CHAIN, transport: relayReadTransport(5000, 0) });

function deployedLauncher(): Address {
  const a = ANON_ADDONS[ACTIVE_CHAIN.id]?.anonLauncher;
  if (!a) throw new GaslessReject("private launches aren't available on this chain");
  return a;
}

async function admitLaunch(signer: Address, to: Address, data: Hex, d: GaslessDeps): Promise<{ relayer: DirectRelayer; did: string }> {
  const m = d.metrics;
  const relayer = directRelayer(m);
  const session = timed(m, "authSession", () => verifySessionToken(d.idToken));
  const owner = session.then(x => timed(m, "authSessionWallet", () => requireSessionWallet(x, signer)));
  const gate = session.then(x => timed(m, "revokeStrikeGate", () => requireNotRevokedOrStruck(signer, Date.now(), x.did)));
  const sim = Promise.all([relayer, session]).then(([r]) => timed(m, "simulate", () => simulateDirect(r.address, to, data, ANON_LAUNCH_TX_GAS_LIMIT)));
  const all = [session, owner, gate, d.ipGate ?? Promise.resolve(), sim, relayer];
  const res = await timed(m, "admissionSimulationWall", () => Promise.allSettled(all));
  for (const x of res) if (x.status === "rejected") throw notSent(x.reason);
  return {
    relayer: (res[all.indexOf(relayer)] as PromiseFulfilledResult<DirectRelayer>).value,
    did: (res[all.indexOf(session)] as PromiseFulfilledResult<{ did: string }>).value.did,
  };
}

async function commitLaunch(signer: Address, to: Address, data: Hex, gas: bigint, r: DirectRelayer, d: GaslessDeps, t0: number, tAdm: number, did?: string): Promise<GaslessConfirmed> {
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
    const many = await recordSenderRevert({ who: signer, reverted: true, lossWei: BigInt(res.rc.gasUsed) * price }).catch(() => ({ tooMany: false }));
    if (many.tooMany) strikeSender(signer, did);
  }
  return { kind: "confirmed", txHash: res.txHash, success, receipt: res.rc, gasUsed, via: String(res.via),
    t: { admission: tAdm, budget, send: res.sendMs + res.minedMs, total: Date.now() - t0 } };
}

/**
 * disciple_gaslessAnonLaunch: one signed Permit2 witness → DisciplePermitForwarder.launchAnon (it runs the signed launch itself
 * and returns leftovers to the signed refund address). No Multicall3 fallback: without the forwarder this refuses, nothing sent.
 */
export async function relayGaslessAnonLaunch(raw: unknown, d: GaslessDeps & { allowWalletPaidAnon?: boolean } = {}): Promise<GaslessConfirmed> {
  const t0 = Date.now();
  let q: GaslessAnonLaunchRequest;
  let spender: RelaySpender;
  const dep = deployment();
  const launcher = deployedLauncher();
  try {
    requireGaslessMode();
    relayBreaker.assertClosed();
    // maker 2026-11-19: this path pulls the payment from the player's wallet, so the launch tx names that wallet. Hidden
    // launches go through relayAnonFreeLaunch now; this one stays only for its tests.
    if (!d.allowWalletPaidAnon) throw new GaslessReject("anon launches pay their network fee now; reload and try again");
    q = parseGaslessAnonLaunchRequest(raw);
    spender = relaySpender(ACTIVE_CHAIN.id, { legacy: false });
    const [launchFee, feeToken] = await Promise.all([
      pc.readContract({ address: launcher, abi: launcherAbi, functionName: "launchFee" }),
      pc.readContract({ address: launcher, abi: launcherAbi, functionName: "feeToken" }),
    ]);
    if (feeToken.toLowerCase() !== dep.usdg.toLowerCase()) throw new GaslessReject("private First BOOST expects the launch fee to be charged in USDG");
    // Pool / burn routing goes through CreatorFeeHarvest. Only allowed once the harvest with refundTo is live.
    const harvest = creatorFeeRoutingAvailable({ private: true, harvest: dep.creatorFeeHarvest }) ? dep.creatorFeeHarvest : null;
    checkGaslessAnonLaunchRequest(q, { usdg: dep.usdg, launcher, harvest, nowSec: d.nowSec ?? Math.floor(Date.now() / 1000), launchFee });
    const who = await recoverTypedDataAddress({ ...anonLaunchTypedData(ACTIVE_CHAIN.id, q.permit, q.launch, spender.address), signature: q.signature });
    if (who.toLowerCase() !== q.signer.toLowerCase()) throw new GaslessReject("signature is not the signer's");
  } catch (e) { throw notSent(e); }
  const data = encodeForwarderLaunch({ permit: q.permit, l: q.launch, owner: q.signer, signature: q.signature, approval: q.approval });
  const { relayer, did } = await admitLaunch(q.signer, spender.address, data, d);
  return commitLaunch(q.signer, spender.address, data, ANON_LAUNCH_TX_GAS_LIMIT, relayer, d, t0, Date.now() - t0, did);
}

const harvestAbi = parseAbi(["function anon() view returns (address)"]);

/** Launch gas headroom over the estimate (the estimate is the relayer's own eth_estimateGas of the exact launch call). */
const ANON_LAUNCH_FEE_PAD_BPS = BigInt(1_100);

/** Rules + the relayer's call for a free anon launch request. Throws GaslessReject (nothing sent). */
async function freeLaunchCall(q: FreeAnonLaunchRequest, nowSec: number): Promise<{ harvest: Address; data: Hex }> {
  const dep = deployment();
  const launcher = deployedLauncher();
  const h = creatorFeeRoutingAvailable({ private: true, harvest: dep.creatorFeeHarvest }) ? dep.creatorFeeHarvest : null;
  checkFreeAnonLaunch(q, { harvest: h, launcher, anyMode: ANON_ANY_MODE_LIVE, nowSec });
  const [launchFee, anon] = await Promise.all([
    pc.readContract({ address: launcher, abi: launcherAbi, functionName: "launchFee" }),
    pc.readContract({ address: h!, abi: harvestAbi, functionName: "anon" }),
  ]);
  if (launchFee !== BigInt(0)) throw new GaslessReject("anon launches have no launch fee; this launcher charges one");
  if (anon.toLowerCase() !== launcher.toLowerCase()) throw new GaslessReject("launcher mismatch");
  return { harvest: h!, data: encodeFreeAnonLaunch(q.launch, ANON_ANY_MODE_LIVE) };
}

/**
 * The anon launch's gas in USDG (maker 2026-11-19: "have them pay for the gas with the relayer wallet with usdg"):
 * the relayer's eth_estimateGas of the exact launch call + 10%, × the live base fee, × the live USDG-per-ETH price.
 */
async function launchGasFee(harvest: Address, data: Hex, from: Address): Promise<{ fee: bigint; gas: bigint }> {
  const est = await pc.estimateGas({ account: from, to: harvest, data, gas: ANON_LAUNCH_TX_GAS_LIMIT });
  const gas = (est * ANON_LAUNCH_FEE_PAD_BPS) / BigInt(1_000);
  const [r, rate] = await Promise.all([directRelayer(), liveUsdgPerEth()]);
  return { fee: withdrawFeeRaw(gas, r.fee, rate, deployment().usdgDecimals), gas };
}

export type AnonLaunchQuote = { launchGasFee: string; gas: string; feeTo: Address; usdg: Address; usdgDecimals: number };

/** disciple_anonFreeLaunchQuote [{wallet, launch}]: what the player pays the relayer, in USDG, for the launch's gas. No signature. */
export async function quoteAnonFreeLaunch(raw: unknown, d: { nowSec?: number } = {}): Promise<AnonLaunchQuote> {
  requireGaslessMode();
  let call: { harvest: Address; data: Hex };
  try { call = await freeLaunchCall(parseFreeAnonLaunchRequest(raw), d.nowSec ?? Math.floor(Date.now() / 1000)); }
  catch (e) { throw notSent(e); }
  const r = await directRelayer();
  const { fee, gas } = await launchGasFee(call.harvest, call.data, r.address).catch((e) => { throw notSent(e); });
  const dep = deployment();
  return { launchGasFee: fee.toString(), gas: gas.toString(), feeTo: withdrawFeeTo(), usdg: dep.usdg, usdgDecimals: dep.usdgDecimals };
}

/**
 * disciple_anonFreeLaunch (maker 2026-11-19): an anon launch with no Ticket buy and creator fees burned or locked in the pool.
 * The relayer calls CreatorFeeHarvest.launchAnon(WithMode) itself, so the launch tx holds the relayer, the harvest,
 * AnonLauncher and the stealth owner only.
 * maker 2026-11-20 ("Tab on next fees"): no payment tx at all. The old payment (a cash-out from the player's wallet to the
 * relayer, one relayer nonce before the launch) tied $SPACE to its host on chain. The launch's gas in USDG now goes on the
 * account's tab (lib/server/launchTab) and is paid a little at a time on later cash-outs. A `payment` an old app still sends
 * is ignored (never relayed). Refused, nothing sent, while the tab plus this launch would pass tabMax().
 */
export async function relayAnonFreeLaunch(raw: unknown, d: GaslessDeps = {}): Promise<GaslessConfirmed> {
  const t0 = Date.now();
  let q: FreeAnonLaunchRequest;
  let call: { harvest: Address; data: Hex };
  try {
    requireGaslessMode();
    relayBreaker.assertClosed();
    q = parseFreeAnonLaunchRequest(raw);
    call = await freeLaunchCall(q, d.nowSec ?? Math.floor(Date.now() / 1000));
  } catch (e) { throw notSent(e); }
  const { relayer, did } = await admitLaunch(q.wallet, call.harvest, call.data, d);
  let fee: bigint;
  try { ({ fee } = await launchGasFee(call.harvest, call.data, relayer.address)); }
  catch (e) { throw notSent(e); }
  // reserved before the send (audit 2026-11-21 M-1: launches sent at once all passed a check-then-add)
  return withTab(q.wallet, fee, "cash out once to settle your last anon launch's network fee, then launch again",
    () => commitLaunch(q.wallet, call.harvest, call.data, ANON_LAUNCH_TX_GAS_LIMIT, relayer, d, t0, Date.now() - t0, did));
}
