import "server-only";
/**
 * disciple_walletLaunchQuote / disciple_walletLaunch (maker 2026-11-19: every launch pays its own gas in USDG; players hold
 * no ETH). The player signs one Permit2 witness for CreatorFeeHarvest.launchWithPermit2 (lib/trade/gaslessWalletLaunch);
 * the relayer sends it and the harvest pays the signed `gasFee` USDG to the relayer in the same tx. Same admission gate,
 * strike policy, budget and breaker as every other relay. Gas fee priced from the live pool (usdgEthRate.liveUsdgPerEth).
 *
 * Who signs: the player (Permit2 witness, plus a one-time USDG→Permit2 EIP-2612 permit when missing).
 * Who pays gas: the relayer, in ETH. Refilled by: the signed `gasFee` USDG (→ gas-refill cron swaps it to ETH).
 * Runs dry: the relayer can't send; the launch fails before anything is signed on-chain, and no USDG moves.
 */
import { createPublicClient, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { ACTIVE_CHAIN, deployment } from "../chains";
import { GaslessReject, PERMIT2 } from "../trade/gaslessPermit2";
import { erc2612PermitAbi, withdrawFeeRaw } from "../trade/gaslessWithdraw";
import {
  checkWalletLaunch, encodeLaunchEstimate, encodeWalletLaunch, parseLaunchParams, parseWalletLaunchRequest, type WalletLaunchRequest,
} from "../trade/gaslessWalletLaunch";
import { ANON_LAUNCH_TX_GAS_LIMIT } from "../trade/gaslessAnonLaunch";
import { requireGaslessMode, type GaslessConfirmed, type GaslessDeps } from "./gaslessRelay";
import { shouldStrikeIncludedRevert } from "./gaslessStrike";
import { relaySendBudget, requireNotRevokedOrStruck } from "./relayLockdown";
import { requireSessionWallet, verifySessionToken } from "./gaslessSession";
import { directRelayer, sendDirect, simulateDirect, strikeSender, type DirectRelayer } from "./fastRelay";
import { relayBreaker } from "./relayBreaker";
import { relayReadTransport } from "./relayReadTransport";
import { feeFloor, liveUsdgPerEth } from "./usdgEthRate";

const notSent = (e: unknown) => Object.assign(e as Error, { notSent: true });
const pc = createPublicClient({ chain: ACTIVE_CHAIN, transport: relayReadTransport(5000, 0) });
const erc20 = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);
const ENOUGH = BigInt(2) ** BigInt(255);

/** A wallet launch sends more than an anon one (Permit2 pull, First BOOST swap + buy, refund swap). */
export const WALLET_LAUNCH_TX_GAS_LIMIT = ANON_LAUNCH_TX_GAS_LIMIT + BigInt(1_500_000);
/** Quote-time extra over the no-BOOST estimate: the Permit2 pull + the First BOOST swap, curve buy and refund. */
const PERMIT2_PULL_GAS = BigInt(120_000);
const FIRST_BOOST_GAS = BigInt(900_000);
const PAD_PER_MILLE = BigInt(1_100);
const PERMIT_TX_GAS = BigInt(120_000);

function harvestAddr(): Address {
  const h = deployment().creatorFeeHarvest;
  if (!h || /^0x0{40}$/i.test(h)) throw new GaslessReject("launches without ETH aren't available on this network yet");
  return h;
}

async function needsUsdgPermit(owner: Address): Promise<boolean> {
  const a = await pc.readContract({ address: deployment().usdg, abi: erc20, functionName: "allowance", args: [owner, PERMIT2] }).catch(() => BigInt(0));
  return a < ENOUGH;
}

export type WalletLaunchQuote = { gasFee: string; gas: string; harvest: Address; usdg: Address; usdgDecimals: number; permit2: typeof PERMIT2 };

/** disciple_walletLaunchQuote [{signer, params, mode, usdgIn, creatorFeeDestination}]: the launch's gas in USDG. No signature. */
export async function quoteWalletLaunch(raw: unknown): Promise<WalletLaunchQuote> {
  requireGaslessMode();
  const dep = deployment();
  const o = (raw ?? {}) as Record<string, unknown>;
  let gas: bigint;
  try {
    if (typeof o.signer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(o.signer)) throw new GaslessReject("bad signer");
    const signer = o.signer as Address;
    const params = parseLaunchParams(o.params);
    const mode = Number(o.mode ?? 0), dest = Number(o.creatorFeeDestination ?? 0);
    const usdgIn = BigInt((o.usdgIn as string | number | undefined) ?? 0);
    const est = await pc.estimateGas({ account: signer, to: harvestAddr(), data: encodeLaunchEstimate(params, mode, dest), gas: ANON_LAUNCH_TX_GAS_LIMIT })
      .catch((e: unknown) => { throw new GaslessReject(`this launch would fail: ${String((e as { shortMessage?: string })?.shortMessage ?? e).slice(0, 160)}`); });
    gas = (est * PAD_PER_MILLE) / BigInt(1_000) + PERMIT2_PULL_GAS + (usdgIn > BigInt(0) ? FIRST_BOOST_GAS : BigInt(0))
      + ((await needsUsdgPermit(signer)) ? PERMIT_TX_GAS : BigInt(0));
  } catch (e) { throw notSent(e); }
  const [r, rate] = await Promise.all([directRelayer(), liveUsdgPerEth()]);
  const gasFee = withdrawFeeRaw(gas, r.fee, rate, dep.usdgDecimals);
  if (gasFee > BigInt(10) ** BigInt(dep.usdgDecimals)) throw notSent(new GaslessReject("network fee over $1 right now; try again in a bit"));
  return { gasFee: gasFee.toString(), gas: gas.toString(), harvest: harvestAddr(), usdg: dep.usdg, usdgDecimals: dep.usdgDecimals, permit2: PERMIT2 };
}

async function admit(q: WalletLaunchRequest, d: GaslessDeps): Promise<{ relayer: DirectRelayer; did: string }> {
  const relayer = directRelayer(d.metrics);
  const session = verifySessionToken(d.idToken);
  const owner = session.then((x) => requireSessionWallet(x, q.signer));
  const gate = session.then((x) => requireNotRevokedOrStruck(q.signer, Date.now(), x.did));
  const all = [session, owner, gate, d.ipGate ?? Promise.resolve(), relayer];
  const res = await Promise.allSettled(all);
  for (const x of res) if (x.status === "rejected") throw notSent(x.reason);
  return {
    relayer: (res[all.indexOf(relayer)] as PromiseFulfilledResult<DirectRelayer>).value,
    did: (res[all.indexOf(session)] as PromiseFulfilledResult<{ did: string }>).value.did,
  };
}

/** disciple_walletLaunch [request]: optional USDG→Permit2 permit (own tx), then CreatorFeeHarvest.launchWithPermit2. */
export async function relayWalletLaunch(raw: unknown, d: GaslessDeps = {}): Promise<GaslessConfirmed> {
  const t0 = Date.now();
  const dep = deployment();
  let q: WalletLaunchRequest, harvest: Address;
  try {
    requireGaslessMode();
    relayBreaker.assertClosed();
    q = parseWalletLaunchRequest(raw);
    harvest = harvestAddr();
    checkWalletLaunch(q, { usdg: dep.usdg, usdgDecimals: dep.usdgDecimals, nowSec: d.nowSec ?? Math.floor(Date.now() / 1000) });
  } catch (e) { throw notSent(e); }
  const { relayer, did } = await admit(q, d);
  let permitGas = BigInt(0);
  // a first-time wallet: USDG.permit(owner → Permit2) is permissionless and goes as its own tx (sent by the relayer,
  // so the harvest's gas fee still lands with the relayer and never with a multicall)
  if (q.approval && q.approval.value > BigInt(0) && await needsUsdgPermit(q.signer)) {
    const a = q.approval;
    const pdata: Hex = encodeFunctionData({ abi: erc2612PermitAbi, functionName: "permit", args: [q.signer, PERMIT2, a.value, a.deadline, a.v, a.r, a.s] });
    try { await simulateDirect(relayer.address, dep.usdg, pdata, PERMIT_TX_GAS); } catch (e) { throw notSent(e); }
    const refund = await relaySendBudget(q.signer, d.metrics).catch((e) => { throw notSent(e); });
    let pr;
    try { pr = await sendDirect(relayer, dep.usdg, pdata, PERMIT_TX_GAS, undefined, d.metrics); }
    catch (e) { if ((e as { notSent?: boolean }).notSent) await refund().catch(() => undefined); throw e; }
    if (pr.rc.status !== "0x1") throw notSent(new GaslessReject("the USDG approval didn't go through; nothing was launched"));
    permitGas = BigInt(pr.rc.gasUsed);
  }
  const data = encodeWalletLaunch(q);
  // exact simulation + the fee the relayer actually needs (the estimate is of this signed launch, from the relayer)
  try {
    await simulateDirect(relayer.address, harvest, data, WALLET_LAUNCH_TX_GAS_LIMIT);
    const est = await pc.estimateGas({ account: relayer.address, to: harvest, data, gas: WALLET_LAUNCH_TX_GAS_LIMIT });
    const rate = await liveUsdgPerEth();
    const need = withdrawFeeRaw((est * PAD_PER_MILLE) / BigInt(1_000) + permitGas, relayer.fee, rate, dep.usdgDecimals);
    if (q.w.gasFee < feeFloor(need)) throw new GaslessReject("the network fee changed, please retry");
  } catch (e) { throw notSent(e); }
  const tb = Date.now();
  const refund = await relaySendBudget(q.signer, d.metrics).catch((e) => { throw notSent(e); });
  const budget = Date.now() - tb;
  let res;
  try { res = await sendDirect(relayer, harvest, data, WALLET_LAUNCH_TX_GAS_LIMIT, d.onPending, d.metrics); }
  catch (e) { if ((e as { notSent?: boolean }).notSent) await refund().catch(() => undefined); throw e; }
  const success = res.rc.status === "0x1";
  if (!success) {
    let revertData: string | undefined;
    try { await simulateDirect(relayer.address, harvest, data, WALLET_LAUNCH_TX_GAS_LIMIT); }
    catch (e) { revertData = (e as { data?: string }).data; }
    if (shouldStrikeIncludedRevert({ revertData, gasUsed: BigInt(res.rc.gasUsed), gasLimit: WALLET_LAUNCH_TX_GAS_LIMIT })) strikeSender(q.signer, did);
    const price = res.rc.effectiveGasPrice ? BigInt(res.rc.effectiveGasPrice) : BigInt(0);
    await relayBreaker.record({ reverted: true, lossWei: BigInt(res.rc.gasUsed) * price }).catch(() => false);
  }
  return { kind: "confirmed", txHash: res.txHash, success, receipt: res.rc, gasUsed: Number(BigInt(res.rc.gasUsed)), via: String(res.via),
    t: { admission: Date.now() - t0, budget, send: res.sendMs + res.minedMs, total: Date.now() - t0 } };
}

