import "server-only";
/**
 * Gasless action relay (claims / tramp pull / anon creator transfer). Same admission gate as gasless trades and
 * withdrawals (Privy identity token, revoke/strike/blocklist, H1/M1/M2), same strike policy (only sender-caused
 * signature/permit/nonce included reverts), same USDG fee quote (rateFromEnv + unmarkedRate, 1.0x, quoted fee kept).
 * Does not touch the trade path. New code uses deployment() (active chain).
 */
import { createPublicClient, parseAbi, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ACTIVE_CHAIN, deployment } from "../chains";
import { GaslessReject, PERMIT2 } from "../trade/gaslessPermit2";
import {
  MULTICALL3, actionGas, actionTxGasLimit, checkGaslessActionRequest, encodeActionCall,
  parseGaslessActionRequest, transferTypedData, withdrawFeeRaw, type ActionKind, type GaslessActionRequest,
} from "../trade/gaslessAction";
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

export function actionUsdgPerEth(env: NodeJS.ProcessEnv = process.env, usdgDecimals = deployment().usdgDecimals): bigint {
  return unmarkedRate(rateFromEnv({ PAYMASTER_RATE: env.PAYMASTER_RATE, PAYMASTER_USD_PER_ETH: env.PAYMASTER_USD_PER_ETH }, usdgDecimals));
}

export function actionFeeTo(): Address {
  return privateKeyToAccount(relayerKey()).address;
}

export type ActionQuoteResult = {
  kind: ActionKind;
  fee: string; feeTo: Address; gas: string; gasPrice: string; rate: string;
  usdg: Address; usdgDecimals: number; spender: typeof MULTICALL3; permit2: typeof PERMIT2;
  /** TrampWallManager.keeperTipBps, shown for trampPull (relayer is paid from proceeds; USDG fee is 0). */
  keeperTipBps: number;
};

export type ActionQuoteOpts = {
  nowSec?: number; baseFee?: bigint; rate?: bigint; feeTo?: Address; needsPermit?: boolean;
  usdgDecimals?: number; callCount?: number;
};

function kindOf(raw: unknown): ActionKind {
  const k = (raw ?? {}) as { kind?: unknown };
  if (k.kind === "anonClaim" || k.kind === "anonTransferCreator" || k.kind === "trampPull") return k.kind;
  throw notSent(new GaslessReject("unknown gasless action"));
}

/** disciple_gaslessActionQuote: no signature, no Privy session. trampPull quotes fee 0 (keeper tip pays the relayer). */
export async function quoteGaslessAction(raw: unknown = {}, opts: ActionQuoteOpts = {}): Promise<ActionQuoteResult> {
  requireGaslessMode();
  const dep = deployment();
  const kind = kindOf(raw);
  const decimals = opts.usdgDecimals ?? dep.usdgDecimals;
  const o = (raw ?? {}) as { signer?: unknown; callCount?: unknown; calls?: unknown };
  const callCount = opts.callCount ?? (typeof o.callCount === "number" ? o.callCount : Array.isArray(o.calls) ? o.calls.length : 1);
  let needsPermit = opts.needsPermit;
  if (kind !== "trampPull" && needsPermit === undefined && typeof o.signer === "string" && /^0x[0-9a-fA-F]{40}$/.test(o.signer)) {
    try {
      const a = await pc.readContract({ address: dep.usdg, abi: erc20, functionName: "allowance", args: [o.signer as Address, PERMIT2] });
      needsPermit = a < ENOUGH;
    } catch { needsPermit = true; }
  }
  if (needsPermit === undefined) needsPermit = kind !== "trampPull";
  const gas = actionGas(kind, callCount, needsPermit);
  const feeTo = opts.feeTo ?? actionFeeTo();
  const baseFee = opts.baseFee ?? (await directRelayer()).fee;
  const rate = opts.rate ?? actionUsdgPerEth();
  const fee = kind === "trampPull" ? 0n : withdrawFeeRaw(gas, baseFee, rate, decimals);
  let keeperTipBps = 0;
  if (kind === "trampPull") {
    try { keeperTipBps = Number(await pc.readContract({ address: dep.trampWallManager, abi: parseAbi(["function keeperTipBps() view returns (uint16)"]), functionName: "keeperTipBps" })); }
    catch { keeperTipBps = 10; }
  }
  return {
    kind, fee: fee.toString(), feeTo, gas: gas.toString(), gasPrice: baseFee.toString(), rate: rate.toString(),
    usdg: dep.usdg, usdgDecimals: decimals, spender: MULTICALL3, permit2: PERMIT2, keeperTipBps,
  };
}

async function admitAction(signer: Address, data: Hex, d: GaslessDeps): Promise<{ relayer: DirectRelayer; did: string }> {
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

async function commitAction(signer: Address, data: Hex, gas: bigint, r: DirectRelayer, d: GaslessDeps, t0: number, tAdm: number, did?: string): Promise<GaslessConfirmed> {
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

/** disciple_gaslessAction: optional USDG fee Permit2 + allowlisted action calls, one Multicall3 relayer tx. */
export async function relayGaslessAction(raw: unknown, d: GaslessDeps = {}): Promise<GaslessConfirmed> {
  const t0 = Date.now();
  let q: GaslessActionRequest;
  const dep = deployment();
  try {
    requireGaslessMode();
    relayBreaker.assertClosed();
    q = parseGaslessActionRequest(raw);
    const feeTo = actionFeeTo();
    const needsPermit = !!(q.approval && q.approval.value > BigInt(0));
    const gas = actionGas(q.kind, q.calls.length, needsPermit);
    const rate = actionUsdgPerEth();
    const current = q.kind === "trampPull" ? 0n : withdrawFeeRaw(gas, (await directRelayer()).fee, rate, dep.usdgDecimals);
    if (q.fee < current) throw new GaslessReject("fee changed, please retry");
    checkGaslessActionRequest(q, { usdg: dep.usdg, usdgDecimals: dep.usdgDecimals, nowSec: d.nowSec ?? Math.floor(Date.now() / 1000), feeTo, minFee: current });
    if (q.fee > 0n && q.feePermit && q.feeSignature) {
      const who = await recoverTypedDataAddress({ ...transferTypedData(ACTIVE_CHAIN.id, q.feePermit), signature: q.feeSignature });
      if (who.toLowerCase() !== q.signer.toLowerCase()) throw new GaslessReject("signature is not the signer's");
    }
  } catch (e) { throw notSent(e); }
  const data = encodeActionCall(q, dep.usdg);
  const { relayer, did } = await admitAction(q.signer, data, d);
  return commitAction(q.signer, data, actionTxGasLimit(q.kind), relayer, d, t0, Date.now() - t0, did);
}

export type { OnPending };
