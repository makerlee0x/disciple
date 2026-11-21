import "server-only";
/**
 * Gasless action relay (claims / tramp pull / anon creator transfer). Same admission gate as gasless trades and
 * withdrawals (Privy identity token, revoke/strike/blocklist, H1/M1/M2), same strike policy (only sender-caused
 * signature/permit/nonce included reverts), same USDG fee quote (live pool price + markup, usdgEthRate.liveUsdgPerEth; quoted fee kept).
 * Does not touch the trade path. New code uses deployment() (active chain).
 */
import { createPublicClient, parseAbi, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { actionTypedData, relaySpender } from "../trade/permitForwarder";
import { privateKeyToAccount } from "viem/accounts";
import { ACTIVE_CHAIN, deployment } from "../chains";
import { GaslessReject, PERMIT2 } from "../trade/gaslessPermit2";
import {
  MULTICALL3, actionGas, actionTxGasLimit, actionWitness, checkGaslessActionRequest, claimTokenArg, encodeActionCall, encodeForwarderActionCall,
  isActionKind, isStealthAction, parseGaslessActionRequest, stealthClaimTokens, transferTypedData, withdrawFeeRaw, type ActionKind, type GaslessActionRequest,
} from "../trade/gaslessAction";
import { feeFloor, liveUsdgPerEth, rateFromEnv, unmarkedRate } from "./usdgEthRate";
import { requireGaslessMode, type GaslessConfirmed, type GaslessDeps } from "./gaslessRelay";
import { shouldStrikeIncludedRevert } from "./gaslessStrike";
import { relaySendBudget, requireNotRevokedOrStruck } from "./relayLockdown";
import { requireSessionWallet, verifySessionToken } from "./gaslessSession";
import { directRelayer, sendDirect, simulateDirect, strikeSender, type DirectRelayer, type OnPending } from "./fastRelay";
import { recordSenderRevert, relayBreaker } from "./relayBreaker";
import type { RelayMetrics } from "./relayMetrics";
import { relayerKey } from "./relayer";
import { relayReadTransport } from "./relayReadTransport";

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
const erc20 = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const coinHomeAbi = parseAbi([
  "function hookOf(address token) view returns (address)",
  "function curveOf(address token) view returns (address)",
  "function feeVault() view returns (address)",
]);
const isZeroAddr = (a?: string | null) => !a || /^0x0{40}$/i.test(a);
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
  usdg: Address; usdgDecimals: number; spender: Address; permit2: typeof PERMIT2;
  /** TrampWallManager.keeperTipBps, shown for trampPull (relayer is paid from proceeds; USDG fee is 0). */
  keeperTipBps: number;
};

export type ActionQuoteOpts = {
  nowSec?: number; baseFee?: bigint; rate?: bigint; feeTo?: Address; needsPermit?: boolean;
  usdgDecimals?: number; callCount?: number;
};

function kindOf(raw: unknown): ActionKind {
  const k = (raw ?? {}) as { kind?: unknown };
  if (isActionKind(k.kind)) return k.kind;
  throw notSent(new GaslessReject("unknown gasless action"));
}

/**
 * Claims the relayer pays for (maker 2026-11-19: creators, referrers and holders hold USDG only, and a claim pays out in
 * the pair coin): when the wallet's USDG can't cover the quoted fee, the claim goes with no fee. Safe to give away:
 * every public claim reverts when there is nothing to claim (simulated before sending), so it can't be repeated for free.
 */
async function sponsoredClaim(kind: ActionKind, signer: Address | undefined, fee: bigint): Promise<boolean> {
  if (kind !== "anonClaim" || fee === 0n || !signer) return false;
  const bal = await pc.readContract({ address: deployment().usdg, abi: erc20, functionName: "balanceOf", args: [signer] }).catch(() => null);
  return bal !== null && bal < fee;
}

/** A coin's own curve fee vault and pool hook (older coins can sit on an older one), read on-chain for each claimed coin. */
async function claimHomes(q: Pick<GaslessActionRequest, "kind" | "calls">): Promise<Set<string>> {
  const out = new Set<string>();
  if (q.kind !== "anonClaim") return out;
  const dep = deployment();
  const named = [...q.calls.map(claimTokenArg).filter((t): t is Address => !!t), ...q.calls.flatMap(stealthClaimTokens)];
  const tokens = [...new Set(named.map((t) => t.toLowerCase() as Address))].slice(0, 32);
  await Promise.all(tokens.map(async (t) => {
    const [hook, curve] = await Promise.all([
      isZeroAddr(dep.migration) ? null : pc.readContract({ address: dep.migration, abi: coinHomeAbi, functionName: "hookOf", args: [t] }).catch(() => null),
      isZeroAddr(dep.launchpad) ? null : pc.readContract({ address: dep.launchpad, abi: coinHomeAbi, functionName: "curveOf", args: [t] }).catch(() => null),
    ]);
    if (!isZeroAddr(hook)) out.add(hook!.toLowerCase());
    if (!isZeroAddr(curve)) {
      const v = await pc.readContract({ address: curve!, abi: coinHomeAbi, functionName: "feeVault" }).catch(() => null);
      if (!isZeroAddr(v)) out.add(v!.toLowerCase());
    }
  }));
  return out;
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
  const rate = opts.rate ?? await liveUsdgPerEth();
  const quoted = kind === "trampPull" ? 0n : withdrawFeeRaw(gas, baseFee, rate, decimals);
  // a hidden coin's own action never takes a fee from the wallet (it would name the wallet next to the coin): its gas
  // goes on the private anon tab when it lands (relayGaslessAction)
  const stealth = isStealthAction({ kind, calls: o.calls });
  const sponsored = stealth || await sponsoredClaim(kind, typeof o.signer === "string" ? o.signer as Address : undefined, quoted);
  const fee = sponsored ? 0n : quoted;
  let keeperTipBps = 0;
  if (kind === "trampPull") {
    try { keeperTipBps = Number(await pc.readContract({ address: dep.trampWallManager, abi: parseAbi(["function keeperTipBps() view returns (uint16)"]), functionName: "keeperTipBps" })); }
    catch { keeperTipBps = 10; }
  }
  return {
    kind, fee: fee.toString(), feeTo, gas: gas.toString(), gasPrice: baseFee.toString(), rate: rate.toString(),
    // a fee is signed for the forwarder when deployed; with no fee (trampPull) nothing is signed and Multicall3 stays
    usdg: dep.usdg, usdgDecimals: decimals, spender: fee > 0n ? relaySpender(ACTIVE_CHAIN.id).address : MULTICALL3, permit2: PERMIT2, keeperTipBps,
  };
}

async function admitAction(signer: Address, to: Address, data: Hex, gas: bigint, d: GaslessDeps): Promise<{ relayer: DirectRelayer; did: string }> {
  const m = d.metrics;
  const relayer = directRelayer(m);
  const session = timed(m, "authSession", () => verifySessionToken(d.idToken));
  const owner = session.then(x => timed(m, "authSessionWallet", () => requireSessionWallet(x, signer)));
  const gate = session.then(x => timed(m, "revokeStrikeGate", () => requireNotRevokedOrStruck(signer, Date.now(), x.did)));
  const sim = Promise.all([relayer, session]).then(([r]) => timed(m, "simulate", () => simulateDirect(r.address, to, data, gas)));
  const all = [session, owner, gate, d.ipGate ?? Promise.resolve(), sim, relayer];
  const res = await timed(m, "admissionSimulationWall", () => Promise.allSettled(all));
  for (const x of res) if (x.status === "rejected") throw notSent(x.reason);
  return {
    relayer: (res[all.indexOf(relayer)] as PromiseFulfilledResult<DirectRelayer>).value,
    did: (res[all.indexOf(session)] as PromiseFulfilledResult<{ did: string }>).value.did,
  };
}

async function commitAction(signer: Address, to: Address, data: Hex, gas: bigint, r: DirectRelayer, d: GaslessDeps, t0: number, tAdm: number, did?: string): Promise<GaslessConfirmed> {
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

/** disciple_gaslessAction: optional USDG fee Permit2 + allowlisted action calls, one Multicall3 relayer tx. */
export async function relayGaslessAction(raw: unknown, d: GaslessDeps = {}): Promise<GaslessConfirmed> {
  const t0 = Date.now();
  let q: GaslessActionRequest;
  let target: Address = MULTICALL3;
  let forwarder = false;
  let tabFee = 0n;
  const dep = deployment();
  try {
    requireGaslessMode();
    relayBreaker.assertClosed();
    q = parseGaslessActionRequest(raw);
    const feeTo = actionFeeTo();
    const needsPermit = !!(q.approval && q.approval.value > BigInt(0));
    const gas = actionGas(q.kind, q.calls.length, needsPermit);
    const rate = await liveUsdgPerEth();
    let current = q.kind === "trampPull" ? 0n : feeFloor(withdrawFeeRaw(gas, (await directRelayer()).fee, rate, dep.usdgDecimals));
    if (isStealthAction(q)) {
      // audit 2026-11-21: no wallet fee permit next to a hidden coin. The gas goes on the private tab instead.
      if (q.fee > 0n || q.feePermit || q.feeSignature || (q.approval && q.approval.value > 0n)) throw new GaslessReject("please update the app and try again");
      tabFee = withdrawFeeRaw(gas, (await directRelayer()).fee, rate, dep.usdgDecimals);
      current = 0n;
    }
    // a no-fee claim only when the wallet's USDG really can't cover it (re-read now)
    if (q.fee === 0n && current > 0n && await sponsoredClaim(q.kind, q.signer, current)) current = 0n;
    if (q.fee < current) throw new GaslessReject("fee changed, please retry");
    const extraTargets = await claimHomes(q);
    checkGaslessActionRequest(q, { usdg: dep.usdg, usdgDecimals: dep.usdgDecimals, nowSec: d.nowSec ?? Math.floor(Date.now() / 1000), feeTo, minFee: current, extraTargets });
    if (q.fee > 0n && q.feePermit && q.feeSignature) {
      // a signed fee: the forwarder when deployed; Multicall3 only on testnet (relaySpender throws on mainnet without it)
      const spender = relaySpender(ACTIVE_CHAIN.id);
      forwarder = spender.kind === "forwarder";
      target = spender.address;
      const typed = forwarder
        ? actionTypedData(ACTIVE_CHAIN.id, spender.address, q.feePermit, actionWitness(q))
        : transferTypedData(ACTIVE_CHAIN.id, q.feePermit);
      const who = await recoverTypedDataAddress({ ...typed, signature: q.feeSignature } as Parameters<typeof recoverTypedDataAddress>[0]);
      if (who.toLowerCase() !== q.signer.toLowerCase()) throw new GaslessReject("signature is not the signer's");
    }
  } catch (e) { throw notSent(e); }
  const data = forwarder ? encodeForwarderActionCall(q) : encodeActionCall(q, dep.usdg);
  const limit = actionTxGasLimit(q.kind, q.calls.length);
  const { relayer, did } = await admitAction(q.signer, target, data, limit, d);
  const send = () => commitAction(q.signer, target, data, limit, relayer, d, t0, Date.now() - t0, did);
  return tabFee > 0n ? withTab(q.signer, tabFee, "cash out once to settle your last hidden rocket's network fee, then try again", send) : send();
}

export type { OnPending };
