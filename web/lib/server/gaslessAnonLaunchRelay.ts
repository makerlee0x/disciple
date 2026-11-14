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
import { DEPLOYMENTS, robinhoodTestnet } from "../chains";
import { ANON_ADDONS } from "../anon";
import { GaslessReject } from "../trade/gaslessPermit2";
import { creatorFeeRoutingAvailable } from "../quickLaunch";
import {
  ANON_LAUNCH_TX_GAS_LIMIT, MULTICALL3, anonLaunchTypedData, checkGaslessAnonLaunchRequest,
  encodeAnonLaunchCall, parseGaslessAnonLaunchRequest, type GaslessAnonLaunchRequest,
} from "../trade/gaslessAnonLaunch";
import { requireGaslessMode, type GaslessConfirmed, type GaslessDeps } from "./gaslessRelay";
import { shouldStrikeIncludedRevert } from "./gaslessStrike";
import { relaySendBudget, requireNotRevokedOrStruck } from "./relayLockdown";
import { requireSessionWallet, verifySessionToken } from "./gaslessSession";
import { directRelayer, sendDirect, simulateDirect, strikeSender, type DirectRelayer } from "./fastRelay";
import { relayBreaker } from "./relayBreaker";
import type { RelayMetrics } from "./relayMetrics";
import { relayReadTransport } from "./relayReadTransport";

const timed = <T>(m: RelayMetrics | undefined, stage: string, task: () => Promise<T>) => m ? m.span(stage, task) : task();
const notSent = (e: unknown) => Object.assign(e as Error, { notSent: true });
const launcherAbi = parseAbi(["function launchFee() view returns (uint256)", "function feeToken() view returns (address)"]);
const pc = createPublicClient({ chain: robinhoodTestnet, transport: relayReadTransport(5000, 0) });

function deployedLauncher(): Address {
  const a = ANON_ADDONS[46630]?.anonLauncher;
  if (!a) throw new GaslessReject("private launches aren't available on this chain");
  return a;
}

async function admitLaunch(signer: Address, data: Hex, d: GaslessDeps): Promise<{ relayer: DirectRelayer; did: string }> {
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

async function commitLaunch(signer: Address, data: Hex, gas: bigint, r: DirectRelayer, d: GaslessDeps, t0: number, tAdm: number, did?: string): Promise<GaslessConfirmed> {
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

/** disciple_gaslessAnonLaunch: one signed Permit2 witness → one Multicall3 relayer tx. */
export async function relayGaslessAnonLaunch(raw: unknown, d: GaslessDeps = {}): Promise<GaslessConfirmed> {
  const t0 = Date.now();
  let q: GaslessAnonLaunchRequest;
  const dep = DEPLOYMENTS[46630];
  const launcher = deployedLauncher();
  try {
    requireGaslessMode();
    relayBreaker.assertClosed();
    q = parseGaslessAnonLaunchRequest(raw);
    const [launchFee, feeToken] = await Promise.all([
      pc.readContract({ address: launcher, abi: launcherAbi, functionName: "launchFee" }),
      pc.readContract({ address: launcher, abi: launcherAbi, functionName: "feeToken" }),
    ]);
    if (feeToken.toLowerCase() !== dep.usdg.toLowerCase()) throw new GaslessReject("private First BOOST expects the launch fee to be charged in USDG");
    // Pool / burn routing goes through CreatorFeeHarvest. Only allowed once the harvest with refundTo is live.
    const harvest = creatorFeeRoutingAvailable({ private: true, harvest: dep.creatorFeeHarvest }) ? dep.creatorFeeHarvest : null;
    checkGaslessAnonLaunchRequest(q, { usdg: dep.usdg, launcher, harvest, nowSec: d.nowSec ?? Math.floor(Date.now() / 1000), launchFee });
    const who = await recoverTypedDataAddress({ ...anonLaunchTypedData(robinhoodTestnet.id, q.permit, q.launch), signature: q.signature });
    if (who.toLowerCase() !== q.signer.toLowerCase()) throw new GaslessReject("signature is not the signer's");
  } catch (e) { throw notSent(e); }
  const data = encodeAnonLaunchCall(q, dep.usdg);
  const { relayer, did } = await admitLaunch(q.signer, data, d);
  return commitLaunch(q.signer, data, ANON_LAUNCH_TX_GAS_LIMIT, relayer, d, t0, Date.now() - t0, did);
}
