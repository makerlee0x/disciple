/**
 * Alchemy Modular Account v2 (SemiModularAccountBytecode, EntryPoint v0.7) via aa-sdk — replaces the LightAccount v2
 * flow in core.ts for embedded users. MAv2 signatures carry a validation-selection prefix, so we never hand-roll them.
 *  - owner = Privy embedded EOA (fallback signer, global validation): account creation, session install/revoke, mints.
 *  - session key = browser-held key, SingleSigner entity (non-global, execute/executeBatch) + DiscipleSessionPolicy hooks.
 *  - gas: prepaid USDG gas, via an external bundler (/api/bundler).
 *    The paymaster holds a hidden $2 credit. Trades top it back up inside the same batch.
 */
import { createModularAccountV2Client } from "@account-kit/smart-contracts";
import { LocalAccountSigner, defaultGasEstimator, deepHexlify, split, type ClientMiddlewareFn, type SmartAccountSigner } from "@aa-sdk/core";
import { concatHex, decodeEventLog, encodeFunctionData, http, parseAbi, toHex, type Address, type Chain, type Hex, type LocalAccount, type PublicClient } from "viem";
import { MAV2_FACTORY } from "./constants";
import { NonceCursor, GasCache, STATIC_GAS, deployedOwnerVerificationGas, gradSessionGas, FeeCache, callsKind, isGradBuyCalls, retryCalls, newPressId, tagPress, type GasLimits, type Fees, type SendOpts, type SendCallsOpts } from "./fastPath";
import { clientFees, isLaunchCalls, INFRA_WORDING, TRADING_UNAVAILABLE } from "./gasPolicy";
import { launchTargets } from "./launchTargets";
import { AAError, userOpHash, type Call, type GasMode, type OwnerSigner, type UserOp, type UserOpReceipt } from "./core";
import { ENTRYPOINT_V07 } from "./constants";
import { withBlock } from "../trade/readFloor";
import { appReadTransport, withinBudget } from "../rpc/readTransport";
import { BUNDLE_REVERTED, PENDING_MSG, REJECTED_MSG, logRelayOp, logTradeError, relayOpRef } from "./relayOp";
import { relayUnclear } from "./relayClient";
import type { RelayErrorData, RelayTimeoutExtra, RelayUnclearInfo } from "./relayTypes";
import { PaymasterCapCache, peekReserve, reserveOrDerived, fallbackUsdgDecimals, type GasOpKind, type WarmAllowance } from "./gasReserve";
import { payGasInUsdg, AllowanceCache, PaymasterRpcError, type PaymasterFields } from "./paymasterClient";
import { withAutoTopUp } from "./prepayBootstrap";
import { disciplePaymasterAbi } from "./paymaster";
import { checkUserPaid } from "./gasPolicy";
import { NOT_ENOUGH_USDG } from "./gasPolicy";
/** A cold fee cache (first op before aaWarm answered) waits at most this long (job 9: no tap stalls on a hung RPC). */
const COLD_FEES_MS = 1500;
/** ≈ one RH block (~165 ms): the retry cadence after a pre-flight saw a lagging node (was a fixed 700 ms sleep). */
export const NEXT_BLOCK_MS = 170;
const nextBlock = () => new Promise((res) => setTimeout(res, NEXT_BLOCK_MS));

const uoEventAbi = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"]);
const uoRevertAbi = parseAbi(["event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)"]);
/** The EntryPoint's UserOperationRevertReason for `hash` in a receipt's logs: the REAL revert (min-out, balance, policy). */
export function opRevertReason(logs: { address: string; data: Hex; topics: Hex[] }[], hash?: Hex): Hex | undefined {
  for (const l of logs) {
    if (l.address.toLowerCase() !== ENTRYPOINT_V07.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: uoRevertAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (!hash || ev.args.userOpHash === hash) return ev.args.revertReason;
    } catch { /* other event */ }
  }
  return undefined;
}
/** The EntryPoint's UserOperationEvent.actualGasUsed for `hash` (verification + execution + unused-gas penalty). */
export function opGasUsed(logs: { address: string; data: Hex; topics: Hex[] }[], hash?: Hex): bigint | undefined {
  for (const l of logs) {
    if (l.address.toLowerCase() !== ENTRYPOINT_V07.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: uoEventAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (!hash || ev.args.userOpHash === hash) return ev.args.actualGasUsed;
    } catch { /* other event */ }
  }
  return undefined;
}
/** AAError("Reverted").extra gas fields: lets the trade layer tell an out-of-gas revert (no reason, gas used ≈ the
 *  limit) from a contract revert (protocol-viem tradeErrorKind → "OUT_OF_GAS"). */
const revertGas = (logs: { address: string; data: Hex; topics: Hex[] }[], hash: Hex, callGasLimit?: unknown) => {
  const actualGasUsed = opGasUsed(logs, hash);
  const cgl = callGasLimit == null ? undefined : (() => { try { return BigInt(callGasLimit as string); } catch { return undefined; } })();
  return { ...(actualGasUsed !== undefined ? { actualGasUsed } : {}), ...(cgl !== undefined ? { callGasLimit: cgl } : {}) };
};
/**
 * Relay answers that do NOT prove the op wasn't sent: the response was lost/garbled, the relay timed out waiting for the
 * receipt, or the nonce is already used (= an earlier send of this op landed). Bug #6: these were all shown as
 * "simulation failed" — and the standard-path fallback re-sent the same nonce (AA25 ⇒ "simulation failed") — while
 * the first send went through. Now we look the op up on-chain first.
 */
export const AMBIGUOUS_RELAY = /not confirmed|timeout|timed out|AA25|invalid account nonce|nonce too low|already known|fetch failed|network|unreadable|internal error|context canceled|socket|ECONN|502|503|504|FUNCTION_INVOCATION/i;
/**
 * AUDIT L2 (client side): the relay error MAY mean the op is in ⇒ look it up (receipt by txHash, else a userOpHash log
 * scan) and, if not found, report "still confirming" — NEVER resend / re-sign / retry. True when the relay reported a
 * txHash without notSent (it signed and can't prove the node refused), or the message / transport is ambiguous.
 */
/** The relay says it did NOT broadcast (data.notSent) because its own EOA nonce raced another relay: safe to retry. */
export const RELAYER_NONCE_RACE = /nonce too low|replacement transaction underpriced|already known/i;
export function relayNotSentRace(err: { message: string; data?: unknown }): boolean {
  const d = err.data as { notSent?: unknown } | undefined;
  return !!d && typeof d === "object" && d.notSent === true && RELAYER_NONCE_RACE.test(err.message);
}
export function relayErrorUnclear(err: { code?: number; message: string; data?: unknown }): boolean {
  if (err.code === -32601 || err.code === -32005 || err.code === -32003) return false;   // method missing / rate limited / relayer off: nothing sent
  const d = err.data as { txHash?: unknown; notSent?: unknown } | undefined;
  if (d && typeof d === "object" && typeof d.txHash === "string") return d.notSent !== true;
  if (/simulation failed/i.test(err.message)) return false;   // the relay's pre-flight: rejected before signing (no txHash)
  return AMBIGUOUS_RELAY.test(err.message);
}
/** AAError("Timeout").extra for an UNCLEAR outcome: the relay fields (relayNonce = the RELAYER EOA nonce) + the smart
 * account `sender` and the op's own EntryPoint v0.7 `nonce` (bigint; SITE's watcher checks it for landed / dropped). */
export function unclearExtra(u: RelayUnclearInfo, userOpHash: Hex, op: { sender: Address; nonce?: Hex | bigint }): RelayTimeoutExtra {
  let nonce: bigint | undefined;
  try { if (op.nonce !== undefined) nonce = BigInt(op.nonce); } catch { /* malformed: leave it out */ }
  return { ...u, userOpHash, sender: op.sender, ...(nonce !== undefined ? { nonce } : {}) };
}
/** The unclear fields of a relay error the client treats as "may be in" (relayErrorUnclear): relayUnclear() when the
 * relay / message says so, else (e.g. AA25 / "already known" / internal error after signing) the ids the relay sent,
 * reason "network" (no usable answer). */
export function unclearOf(err: { code?: number; message: string; data?: unknown }, userOpHash?: Hex): RelayUnclearInfo {
  const u = relayUnclear(err, userOpHash);
  if (u) return u;
  const d = err.data && typeof err.data === "object" ? (err.data as RelayErrorData) : undefined;
  const uoh = d?.userOpHash ?? userOpHash;
  return { unclear: true, reason: "network", ...(uoh ? { userOpHash: uoh } : {}), ...(d?.txHash ? { txHash: d.txHash } : {}), ...(typeof d?.relayNonce === "number" ? { relayNonce: d.relayNonce } : {}) };
}
/** Pre-flight rejections that are typically a lagging RPC node right after our own previous op (session install, deploy). */
/** + balance lag (FLOW 2): a sell sized from a balance the node hasn't caught up to (just bought) reverts
 * ERC20InsufficientBalance (0xe450d38c) / "transfer amount exceeds balance" in estimation — nothing sent, retry once. */
export const TRANSIENT_SIM = /AA23|AA24|SessionInactive|0xf9be14df|ERC20InsufficientBalance|0xe450d38c|exceeds balance|insufficient balance/i;

const BUNDLER_METHODS = [
  "eth_sendUserOperation", "eth_estimateUserOperationGas", "eth_getUserOperationReceipt", "eth_getUserOperationByHash",
  "eth_supportedEntryPoints", "rundler_maxPriorityFeePerGas",
];

/** Any viem LocalAccount (Privy toViemAccount, privateKeyToAccount) as an aa-sdk signer. */

/**
 * Fee estimator for the Alchemy (rundler) bundler: the chain RPC's eth_maxPriorityFeePerGas is 0 on RH testnet, which
 * Alchemy rejects ("precheck failed: maxPriorityFeePerGas is 0 but must be at least …"). Ask the bundler for its
 * minimum via rundler_maxPriorityFeePerGas (+10% headroom, the precheck floor moves with the base fee).
 */
/** UserOp lifecycle → window "disciple:op" (optimistic UI + latency marks). No-op outside the browser. */
/** `pressId` (GAME reservation id = SendOpts.pressId, caller-supplied or generated) is on EVERY event of the press, all
 * retries included. "submitted" = pending (op handed to the relay / tx known). "error" = the press failed (terminal);
 * `code` is the AAError code when known. confirmed.blockNumber: the receipt's block as the relay returned it
 * (lib/fillBook pins post-fill reads at ≥ it; SITE #137). */
/** "sent": the signed op left for the relay (SITE optimistic fill; TradeBridge shows it filled, reconciles on "confirmed"). */
export type OpPhase = { phase: "sent" | "submitted" | "confirmed" | "error"; userOpHash?: Hex; txHash?: Hex; timings?: unknown; pressId?: string; code?: string; message?: string; blockNumber?: string };
/** The receipt block from a returned receipt / its logs (hex, decimal or bigint) as a decimal string; undefined if absent. */
function blockStr(...vs: unknown[]): string | undefined {
  for (const v of vs) {
    try { if (typeof v === "bigint") return v.toString(); if (typeof v === "number" && Number.isFinite(v)) return String(Math.floor(v)); if (typeof v === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v)) return BigInt(v).toString(); } catch { /* next */ }
  }
  return undefined;
}
function opPhase(d: OpPhase) { if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("disciple:op", { detail: { ...d, at: performance.now() } })); }

type FeeClient = { request: (a: { method: string; params?: unknown[] }) => Promise<Hex>; estimateFeesPerGas: () => Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> };
export async function fetchFees(c: FeeClient): Promise<Fees> {
  const [fees, tipHex] = await Promise.all([c.estimateFeesPerGas(), c.request({ method: "rundler_maxPriorityFeePerGas", params: [] })]);
  // viem's estimate = 1.2x base + prio ⇒ this "base" is already >= the chain's base fee
  const base = (fees.maxFeePerGas ?? BigInt(0)) - (fees.maxPriorityFeePerGas ?? BigInt(0));
  // Same formula as the self-bundler's floor (lib/aa/gasPolicy: maxFee >= 2x base + tip, tip >= RELAYER_TIP);
  // FeeCache doubles maxFee on top ⇒ ~2x headroom over the relayer floor.
  return clientFees(base, BigInt(tipHex), BigInt(100));
}
/** Shared fee cache (fees move slowly on RH testnet): a trade never waits for fee RPCs once warm. */
export const FEES = new FeeCache();
export const rundlerFeeEstimator: ClientMiddlewareFn = async (struct, { client, overrides }) => {
  const o = overrides as { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } | undefined;
  const f = o?.maxFeePerGas && o?.maxPriorityFeePerGas ? { maxFeePerGas: o.maxFeePerGas, maxPriorityFeePerGas: o.maxPriorityFeePerGas } : await FEES.get(() => fetchFees(client as unknown as FeeClient));
  struct.maxPriorityFeePerGas = f.maxPriorityFeePerGas;
  struct.maxFeePerGas = f.maxFeePerGas;
  return struct;
};
/** Skips eth_estimateUserOperationGas when the caller supplies all three limits (cached per preset). */
export const cachedGasEstimator: ClientMiddlewareFn = async (struct, args) => {
  const o = args.overrides as (Partial<Record<keyof GasLimits, bigint>> & Partial<PaymasterFields>) | undefined;
  // Account Kit's dummy-paymaster middleware copies address/data, but NOT v0.7 paymaster gas limits.
  // The estimator must see those limits before simulating the precharge (especially with zero account ETH).
  if (o?.paymaster && o.paymasterData && o.paymasterData !== "0x") Object.assign(struct, {
    paymaster: o.paymaster, paymasterData: o.paymasterData,
    paymasterVerificationGasLimit: o.paymasterVerificationGasLimit, paymasterPostOpGasLimit: o.paymasterPostOpGasLimit,
  });
  if (o?.callGasLimit && o?.verificationGasLimit && o?.preVerificationGas) {
    Object.assign(struct, { callGasLimit: o.callGasLimit, verificationGasLimit: o.verificationGasLimit, preVerificationGas: o.preVerificationGas });
    return struct;
  }
  // The paymaster verification override is the server's stamped limit (the quote is signed at it).
  // Passing it through defaultGasEstimator discards the bundler's measured paymaster verification,
  // which the deployed-owner headroom clamp needs. Estimate without that override, keep the measurement,
  // then put the stamped limit back so the submitted op still matches the quote.
  const overrides = { ...(args.overrides as object) } as Record<string, unknown>;
  const stampedPm = overrides.paymasterVerificationGasLimit;
  delete overrides.paymasterVerificationGasLimit;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const estimated = await defaultGasEstimator((args as any).client)(struct, { ...args, overrides });
  if (stampedPm != null) {
    const measured = (estimated as { paymasterVerificationGasLimit?: bigint | Hex }).paymasterVerificationGasLimit;
    (estimated as { estimatedPaymasterVerificationGasLimit?: bigint | Hex }).estimatedPaymasterVerificationGasLimit = measured;
    (estimated as { paymasterVerificationGasLimit?: bigint | Hex }).paymasterVerificationGasLimit = stampedPm as bigint | Hex;
  }
  return estimated;
};

const execAbi = parseAbi(["function execute(address target, uint256 value, bytes data)", "function executeBatch((address target, uint256 value, bytes data)[] calls)"]);
const EXECUTE_USER_OP = "0x8dd7712f";
type Tx = { target: Address; data: Hex; value?: bigint };
/**
 * The SDK's MAv2 encodeExecute re-reads the validation config (eth_getCode + getValidationData) on EVERY op just to
 * decide the executeUserOp prefix (validations with execution hooks, e.g. DiscipleSessionPolicy). That answer is fixed
 * per (account, entity): learn it from the first SDK encode, then encode locally (−1 RPC round trip per tap).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function memoizeExecPrefix(client: any, known?: boolean) {
  const acc = client.account; if (!acc || acc.__memo) return client;
  const origE = acc.encodeExecute.bind(acc), origB = acc.encodeBatchExecute.bind(acc);
  // known: a DiscipleSessionPolicy session ALWAYS has execution hooks ⇒ prefix. Never learn that from a read: right
  // after the install op the load-balanced RPC can serve a node one block behind (no validation yet) ⇒ AA23.
  let prefix: boolean | undefined = known;
  const self = (acc.address as string).toLowerCase();
  const raw = (fn: "execute" | "executeBatch", x: Tx | Tx[]) => fn === "execute"
    ? (x as Tx).target.toLowerCase() === self ? (x as Tx).data // SDK: self-calls are sent as raw account calldata
    : encodeFunctionData({ abi: execAbi, functionName: "execute", args: [(x as Tx).target, (x as Tx).value ?? BigInt(0), (x as Tx).data] })
    : encodeFunctionData({ abi: execAbi, functionName: "executeBatch", args: [(x as Tx[]).map((t) => ({ target: t.target, value: t.value ?? BigInt(0), data: t.data }))] });
  const wrap = (fn: "execute" | "executeBatch", orig: (x: unknown) => Promise<Hex>) => async (x: Tx | Tx[]) => {
    if (prefix === undefined) { const r = await orig(x); prefix = r.toLowerCase().startsWith(EXECUTE_USER_OP) && !raw(fn, x).toLowerCase().startsWith(EXECUTE_USER_OP); return r; }
    const r = raw(fn, x); return prefix ? concatHex([EXECUTE_USER_OP, r]) : r;
  };
  acc.encodeExecute = wrap("execute", origE); acc.encodeBatchExecute = wrap("executeBatch", origB); acc.__memo = true;
  return client;
}

export const asSigner = (a: LocalAccount): SmartAccountSigner => new LocalAccountSigner(a);

export type UsdgGasOpts = { paymaster: Address; usdg: Address; url: string; session: boolean };
export type Mav2Opts = { chain: Chain; pc: PublicClient; bundlerUrl: string; salt?: bigint; /** tests: always estimate on a cold preset */ noStaticGas?: boolean; usdgGas?: UsdgGasOpts; /** Embedded accounts must never fall back to ETH gas. */ requireUsdgGas?: boolean };
/** Per-stage latency (ms) of one op. build = calldata+nonce+fees+gas, sign = signature, rpc = client→server→client,
 * server = self-bundler stages (sign tx, send, mined/receipt) when the sync method is used. */
type PreparedPrepay = { client: Awaited<ReturnType<typeof createModularAccountV2Client>>; nonce?: bigint };
export type OpTimings = { build: number; sign: number; rpc: number; total: number; fast: boolean; server?: Record<string, number> };
export type SendResult = { userOpHash: Hex; txHash: Hex; receipt: UserOpReceipt; gasMode: GasMode; timings?: OpTimings; /** GAME: the press/reservation id (SendOpts.pressId) */ pressId?: string };
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function absUrl(u: string) {
  return /^https?:/.test(u) ? u : new URL(u, typeof location !== "undefined" ? location.origin : "http://localhost:3000").toString();
}

/** Upper bound on the graduation-buy estimateGas before falling back to the fixed grad gas. */
export const GRAD_GAS_BUDGET_MS = 2000;

export class Mav2Account {
  gasMode: GasMode | "unknown";
  /** Parallel nonce keys: every op gets a fresh 152-bit key (seq 0) ⇒ the nonce is known locally, ops never collide. */
  readonly nonces = new NonceCursor();
  readonly gas = new GasCache();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ownerClient?: Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sessionClient?: { entityId: number; c: Promise<any> };
  /** Pre-issued per-sender paymaster allowance (item 5): 0 pm_* calls on a warm USDG-gas trade. */
  readonly allowances?: AllowanceCache;
  /** paymaster.maxGasPerOp() + USDG decimals, read at warm (gasReservePerOp's second tier). */
  readonly caps = new PaymasterCapCache();
  /** The account address once known (warm / first send): lets the SYNC gas-reserve read peek the allowance. */
  private senderAddr?: Address;
  constructor(private o: Mav2Opts, private owner: LocalAccount) {
    this.gasMode = o.usdgGas ? "usdg" : "self-pay";
    if (o.usdgGas) this.allowances = new AllowanceCache({ url: absUrl(o.usdgGas.url), chainId: o.chain.id });
  }


  private transport() {
    return split({ overrides: [{ methods: BUNDLER_METHODS, transport: http(absUrl(this.o.bundlerUrl)) }], fallback: appReadTransport(this.o.chain.rpcUrls.default.http[0]) });
  }
  private owned() {
    return (this.ownerClient ??= createModularAccountV2Client({
      feeEstimator: rundlerFeeEstimator, gasEstimator: cachedGasEstimator,
      chain: this.o.chain, transport: this.transport(), signer: asSigner(this.owner),
      salt: this.o.salt ?? BigInt(0), factoryAddress: MAV2_FACTORY,
    }).then(memoizeExecPrefix));
  }
  private prepaidOwner?: Promise<PreparedPrepay>;
  private prepayReady = false;
  private prepayExpiry = 0;
  async preparePrepay(): Promise<PreparedPrepay> {
    return { client: await this.owned() };
  }
  /** Top the hidden $2 credit back up inside a trade when the wallet can spare it. Never blocks the trade. */
  private async hiddenTopUp(calls: Call[], sender: Address): Promise<Call[]> {
    const pm = this.o.usdgGas;
    if (!pm) return calls;
    try {
      const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
      const [credit, reserved, wallet] = await Promise.all([
        this.o.pc.readContract({ address: pm.paymaster, abi: disciplePaymasterAbi, functionName: "creditOf", args: [sender] }),
        this.o.pc.readContract({ address: pm.paymaster, abi: disciplePaymasterAbi, functionName: "reservedOf", args: [sender] }),
        this.o.pc.readContract({ address: pm.usdg, abi: erc20, functionName: "balanceOf", args: [sender] }),
      ]);
      const available = credit > reserved ? credit - reserved : 0n;
      return withAutoTopUp(calls, { usdg: pm.usdg, paymaster: pm.paymaster, account: sender, available, wallet });
    } catch {
      return calls;
    }
  }
  /** Session-key client on the same account (validation = SingleSigner entityId, non-global). */
  async useSession(entityId: number, key: LocalAccount) {
    const account = await this.address();
    this.sessionClient = {
      entityId,
      c: createModularAccountV2Client({
        feeEstimator: rundlerFeeEstimator, gasEstimator: cachedGasEstimator,
        chain: this.o.chain, transport: this.transport(), signer: asSigner(key), accountAddress: account,
        signerEntity: { entityId, isGlobalValidation: false },
      }).then((cl) => memoizeExecPrefix(cl, true)),
    };
  }
  clearSession() { this.sessionClient = undefined; }
  get hasSession() { return !!this.sessionClient; }

  get ownerAddress(): Address { return this.owner.address; }
  get ownerSigner(): OwnerSigner { return { address: this.owner.address, signMessage: (a) => this.owner.signMessage(a) }; }
  signOwnerRaw(raw: Hex): Promise<Hex> { return this.owner.signMessage({ message: { raw } }); }
  /** ERC-1271 signature (ERC-6492-wrapped while the account is counterfactual). */
  async signMessage(message: string): Promise<Hex> { return (await this.owned()).account.signMessageWith6492({ message }); }
  async address(): Promise<Address> { return (await this.owned()).account.address; }

  /** Look an op up on-chain by hash (UserOperationEvent), polling briefly: did an ambiguous send actually land? */
  async findOp(hash: Hex, sender: Address, waitMs = 6000): Promise<{ userOpHash: Hex; txHash: Hex; success: boolean; logs: { address: Address; data: Hex; topics: Hex[] }[] } | null> {
    const until = Date.now() + waitMs;
    for (;;) {
      try {
        const head = await this.o.pc.getBlockNumber();
        const ev = await this.o.pc.getLogs({ address: ENTRYPOINT_V07, event: uoEventAbi[0], args: { userOpHash: hash, sender }, fromBlock: head > BigInt(600) ? head - BigInt(600) : BigInt(0), toBlock: head });
        if (ev.length) {
          const l = ev[ev.length - 1];
          const rc = await this.o.pc.getTransactionReceipt({ hash: l.transactionHash! });
          return { userOpHash: hash, txHash: rc.transactionHash, success: !!l.args.success, logs: withBlock(rc.logs.map((x) => ({ address: x.address, data: x.data, topics: x.topics as Hex[] })), rc.blockNumber) };
        }
      } catch { /* RPC hiccup: retry until the deadline */ }
      if (Date.now() > until) return null;
      await new Promise((res) => setTimeout(res, NEXT_BLOCK_MS));   // block cadence (was 400 ms); only used without a txHash
    }
  }

  /** The relay's tx hash is known ⇒ one receipt read (no log scan); retried at block cadence for ≤ 3 s. */
  async receiptFor(txHash: Hex, hash: Hex): Promise<{ userOpHash: Hex; txHash: Hex; success: boolean; logs: { address: Address; data: Hex; topics: Hex[] }[] } | null> {
    const until = Date.now() + 3000;
    for (;;) {
      const rc = await this.o.pc.getTransactionReceipt({ hash: txHash }).catch(() => null);
      if (rc) {
        const logs = rc.logs.map((x) => ({ address: x.address, data: x.data, topics: x.topics as Hex[] }));
        let success = false;
        for (const l of logs) { try { const ev = decodeEventLog({ abi: uoEventAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }); if (ev.args.userOpHash === hash) success = ev.args.success; } catch { /* other */ } }
        return { userOpHash: hash, txHash, success, logs };
      }
      if (Date.now() > until) return null;
      await new Promise((res) => setTimeout(res, NEXT_BLOCK_MS));
    }
  }

  /** Warm everything a trade needs (clients, address, fees) so the first tap doesn't pay for it. */
  /** deployed-state cache (true is final; false re-checked on warm) */
  deployed?: boolean;
  async warm() {
    const c = await (this.sessionClient ? this.sessionClient.c : this.owned());
    this.senderAddr = c.account.address as Address;
    await Promise.all([
      this.warmGasReserve(),
      this.preparePrepay().catch(() => undefined),
      this.deployed ? 0 : c.account.isAccountDeployed?.().then((d: boolean) => { this.deployed = d; }),
      FEES.get(() => fetchFees(c as unknown as FeeClient)),
      // learn the executeUserOp-prefix answer now (memoizeExecPrefix) so the first tap encodes locally
      c.account.encodeExecute({ target: "0x0000000000000000000000000000000000000001", data: "0x", value: BigInt(0) }),
    ]).catch(() => undefined);
  }

  /**
   * Op templates (latency plan #6): after the SDK has built one op of a kind (owner|session × call shape) for a deployed
   * account, later ops of that kind copy its struct and replace only nonce, callData, gas and fees — the fields the SDK
   * would fill from our overrides anyway (aa-sdk _initUserOperation: callData = account.encodeExecute/encodeBatchExecute,
   * nonce = overrides.nonce, factory only while undeployed; our fee/gas middlewares just apply the overrides). A template
   * is kept only if rebuilding gives the identical struct; factory/deferred-approval ops never template. Warm USDG
   * ops replace all paymaster fields from a fresh, valid pre-issued allowance on every build. The op is still signed by client.signUserOperation (same key, same hash) — nothing about the policy changes.
   */
  private tpl = new Map<string, Record<string, unknown>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async buildOp(client: any, kind: string, uo: Tx | Tx[], overrides: Record<string, unknown>, useTemplate = true): Promise<any> {
    const key = `${kind}|${client.account.address}`;
    const encode = () => (Array.isArray(uo) ? client.account.encodeBatchExecute(uo) : client.account.encodeExecute(uo));
    const t = useTemplate ? this.tpl.get(key) : undefined;
    if (t) return { ...t, ...overrides, callData: await encode() };
    const struct = await client.buildUserOperation({ uo, overrides: overrides as never });
    const s = struct as unknown as Record<string, unknown>;
    if (s && !s.factory && !s.factoryData && ((BigInt(String(s.nonce ?? 0)) >> BigInt(64)) & BigInt(2)) === BigInt(0) && typeof client.account?.encodeExecute === "function") {
      try {
        const re = { ...s, ...overrides, callData: await encode() };
        if (JSON.stringify(deepHexlify(re)) === JSON.stringify(deepHexlify(s))) this.tpl.set(key, s);
      } catch { /* no template: keep building with the SDK */ }
    }
    return struct;
  }

  /**
   * Send calls as ONE userOp. `as: "session"` signs with the session key (no Privy prompt); default owner.
   * No queue: each op takes its own nonce key, so rapid shots are in flight at once. Fast path (warm preset):
   * nonce/fees/gas are local and the op is signed in memory. Submission uses the external bundler
   * eth_sendUserOperation; confirmation requires receipt polling, not the removed protocol sync relay.
   * `o.rebuild` (rapid taps): the ONE transient-error retry re-quotes via rebuild() (fresh minOut) instead of re-sending
   * the stale calls; every attempt, retries included, takes a fresh 2D nonce key. The fee-floor retry keeps the calls.
   * Shapes: sendCalls(calls, { rebuild, as, feeRetry, pressId }) (SITE #144) or the positional (calls, as, feeRetry, o).
   */
  async sendCalls(calls: Call[], asOrOpts: "owner" | "session" | SendCallsOpts = "owner", feeRetry0 = true, o0: SendOpts = {}): Promise<SendResult> {
    const so: SendCallsOpts = typeof asOrOpts === "string" ? { ...o0, as: asOrOpts, feeRetry: feeRetry0 } : asOrOpts;
    const pressId = so.pressId ?? newPressId();   // same press id on every retry (GAME: the caller's reservation id)
    const top = !this.pressDepth.has(pressId);    // retries re-enter sendCalls with the same id: ONE error event per press
    if (top) this.pressDepth.add(pressId);
    try {
      const r = await this.sendCalls1(calls, { ...so, pressId });
      return { ...r, pressId };
    } catch (e) {
      tagPress(e, pressId);
      if (top) { const ae = e as AAError; opPhase({ phase: "error", pressId, code: ae?.code, message: (ae as Error)?.message?.slice(0, 200), userOpHash: ae?.extra?.userOpHash as Hex | undefined, txHash: ae?.extra?.txHash as Hex | undefined }); }
      throw e;
    } finally { if (top) this.pressDepth.delete(pressId); }
  }
  private async gradGas(sender: Address, calls: Call[]): Promise<GasLimits> {
    const data = encodeFunctionData({ abi: execAbi, functionName: "executeBatch", args: [calls.map((c) => ({ target: c.to, value: c.value ?? BigInt(0), data: c.data }))] });
    // bounded: a hung estimate falls back to the fixed GRAD_STATIC_GAS (gradSessionGas(null)) instead of stalling the tap
    const est = await withinBudget(this.o.pc.estimateGas({ account: ENTRYPOINT_V07, to: sender, data }), GRAD_GAS_BUDGET_MS, "grad-gas").catch(() => null);
    return gradSessionGas(est);
  }
  private readonly pressDepth = new Set<string>();
  private async sendCalls1(calls: Call[], so: SendCallsOpts & { pressId: string }): Promise<SendResult> {
    const as = so.as ?? "owner", feeRetry = so.feeRetry ?? true;
    const o: SendOpts = { rebuild: so.rebuild, pressId: so.pressId };
    const tt = so.tt;   // trade timing (lib/trade/timing): first attempt only, retries don't carry it
    const t0 = now();
    const session = as === "session" && this.sessionClient;
    if (this.o.requireUsdgGas && !this.o.usdgGas) throw new AAError("Bundler", TRADING_UNAVAILABLE, { detail: "prepaid USDG paymaster not configured" });
    let prepared: PreparedPrepay | undefined;
    try { prepared = !session && this.o.usdgGas ? await this.preparePrepay() : undefined; }
    catch { throw new AAError("Bundler", TRADING_UNAVAILABLE, { detail: "prepaid USDG approval bootstrap unavailable" }); }
    // A deferred SDK signer consumes its authorization when signing; never reuse it after an attempted send.
    if (prepared?.nonce !== undefined) this.prepaidOwner = undefined;
    const client = session ? await this.sessionClient!.c : prepared?.client ?? await this.owned();
    const uo = calls.map((c) => ({ target: c.to, data: c.data, value: c.value ?? BigInt(0) }));
    const sender: Address = client.account.address;
    const nonce = prepared?.nonce ?? this.nonces.next(session ? this.sessionClient!.entityId : 0, !session);
    const kind = `${as}|${callsKind(calls)}`;
    // Launches (≈ 6M+ execution gas) ALWAYS estimate: STATIC_GAS (1.8M) runs out and a cached 1.5x would exceed the
    // launch cap. Fees are fresh and un-doubled so the prefund (gas × maxFee) stays small (~0.0002 ETH at 8M gas).
    const launch = isLaunchCalls(calls, launchTargets(this.o.chain.id));
    // Graduating buys (flagged by the trade layer: quote ≥ remaining to graduation) ALSO always estimate: Migration +
    // 16 floor bands ≈ 2.76M execution > STATIC_GAS, and the estimate is never cached for the preset (GRAD_GAS_CAPS server-side).
    const grad = !launch && isGradBuyCalls(calls);
    // Deployed owner ops (USDG send, owner fallback) must not inherit STATIC_GAS.verificationGasLimit.
    // Alchemy rejects that preset: verification gas used / (350k + 250k) = 0.2935 < 0.4. Session trades
    // keep it — their validation hook is large enough to clear the floor. Re-estimate every owner send;
    // GasCache's extra 1.2× would push a tight limit back under 0.4. Undeployed setup keeps the 900k seed.
    const deployedOwner = !session && !!this.deployed && !launch && !grad;
    const gas = launch || grad || deployedOwner ? undefined : this.gas.get(kind) ?? (this.deployed && !this.o.noStaticGas ? STATIC_GAS : undefined);
    // latency: cold fee cache on the fast path ⇒ wait for ONE fee read (~0.1 s) instead of dropping to the multi-second
    // standard flow (estimate + eth_sendUserOperation + receipt polling). Launches keep their fresh un-doubled fees.
    const fees = launch ? await fetchFees(client as unknown as FeeClient).catch(() => undefined)
      : FEES.peek(() => fetchFees(client as unknown as FeeClient)) ?? (gas ? await withinBudget(FEES.get(() => fetchFees(client as unknown as FeeClient)), COLD_FEES_MS, "fees").catch(() => undefined) : undefined);
    const overrides = { nonce, ...(gas ?? {}), ...(fees ?? {}) };
    const fail = async (e: unknown): Promise<never> => {
      const m = (e as { details?: string; shortMessage?: string; message?: string });
      const msg = String(m.details || m.shortMessage || m.message || e);
      // the relay's pre-flight returns FailedOp(0, "AA21 didn't pay prefund") as revert DATA ("AA21" = 0x41413231), not text
      const raw = typeof (e as { data?: unknown }).data === "string" ? String((e as { data: string }).data).toLowerCase() : "";
      if (/insufficient|prefund|AA21|didn't pay/i.test(msg) || raw.includes("41413231")) {
        const have = await this.o.pc.getBalance({ address: sender });
        throw new AAError("FundAccount", "Your account is still getting ready. Try again in a moment.", { have, address: sender });
      }
      // AA3x = the paymaster rejected / couldn't pay (deposit, signature, postOp): infrastructure, never shown verbatim
      if (/AA3[0-9]/.test(msg) || raw.includes("414133")) throw new AAError("Bundler", TRADING_UNAVAILABLE, { detail: msg.split("\n")[0].slice(0, 300) });
      // keep the revert payload (e.g. PreExecHookReverted(module, reason)) so callers/tests can decode the policy error
      let revertData: string | undefined = typeof (e as { data?: unknown }).data === "string" && /^0x[0-9a-fA-F]{8,}$/.test((e as { data: string }).data) ? (e as { data: string }).data : undefined;
      if (!revertData) (e as { walk?: (f: (x: unknown) => boolean) => unknown }).walk?.((x) => { const dd = (x as { data?: unknown }).data; if (typeof dd === "string" && /^0x[0-9a-fA-F]{8,}$/.test(dd)) { revertData = dd; return true; } return false; });
      throw new AAError("Estimate", `simulation failed: ${msg.split("\n")[0].slice(0, 200)}`, { revertData });
    };

    // ---- Player-paid USDG gas: credit reservation → signed quote → external bundler
    if (this.o.usdgGas) {
      const pm = this.o.usdgGas!;
      const f = fees ?? await withinBudget(FEES.get(() => fetchFees(client as unknown as FeeClient)), COLD_FEES_MS, "fees");
      // Frozen after the first build ⇒ every phase prices the same gas. A session op can't be estimated without its
      // signed paymasterAndData (the policy checks approve == maxTokenCost), and sessions imply a deployed account:
      // static limits. Owner cold estimates include paymaster data and gas limits before external simulation.
      // Launches (owner-signed) always estimate (gas undefined above) and are capped by LAUNCH_GAS_CAPS server-side.
      // Graduating session buy: a REAL execution estimate (EntryPoint → account.executeBatch(calls), no signature
      // needed) padded for the policy hook + paymaster approve (gradSessionGas); GRAD_STATIC_GAS if it can't be read.
      let limits: GasLimits | undefined = gas ?? (session && !launch ? (grad ? await this.gradGas(sender, calls) : STATIC_GAS) : undefined);
      const build = async (cs: Call[], pmf: PaymasterFields): Promise<UserOp> => {
        const u = cs.map((c) => ({ target: c.to, data: c.data, value: c.value ?? BigInt(0) }));
        const placeholder = pmf.paymasterData === "0x";
        // Initial sizing does not simulate an ETH-self-paid op. All REAL estimates carry the USDG paymaster,
        // including its dummy signature and gas limits, so zero-ETH deployment can be estimated externally.
        const seed = placeholder ? { callGasLimit: BigInt(1_800_000), verificationGasLimit: BigInt(900_000), preVerificationGas: BigInt(150_000) } : undefined;
        const args = { nonce, ...f, ...pmf, ...(limits ?? seed ?? {}) };
        const struct = placeholder
          ? await client.buildUserOperation({ uo: u.length === 1 ? u[0] : u, overrides: args })
          : await this.buildOp(client, kind, u.length === 1 ? u[0] : u, args, !!limits);
        const measuredPm = (struct as { estimatedPaymasterVerificationGasLimit?: bigint | Hex }).estimatedPaymasterVerificationGasLimit;
        const w = deepHexlify(struct) as UserOp & { estimatedPaymasterVerificationGasLimit?: Hex };
        delete w.estimatedPaymasterVerificationGasLimit;
        if (!placeholder && deployedOwner && !limits) {
          const verificationGasLimit = deployedOwnerVerificationGas({
            estimatedVerification: BigInt(w.verificationGasLimit!),
            estimatedPaymasterVerification: BigInt(measuredPm ?? w.paymasterVerificationGasLimit ?? 0),
            paymasterLimit: BigInt(pmf.paymasterVerificationGasLimit),
          });
          w.verificationGasLimit = toHex(verificationGasLimit);
          limits = { callGasLimit: BigInt(w.callGasLimit!), verificationGasLimit, preVerificationGas: BigInt(w.preVerificationGas!) };
        } else if (!placeholder) limits ??= { callGasLimit: BigInt(w.callGasLimit!), verificationGasLimit: BigInt(w.verificationGasLimit!), preVerificationGas: BigInt(w.preVerificationGas!) };
        return { ...w, ...pmf };
      };
      let wire: UserOp;
      try {
        const topped = await this.hiddenTopUp(calls, sender);
        ({ op: wire } = await payGasInUsdg({
          url: absUrl(pm.url), chainId: this.o.chain.id, usdg: pm.usdg, paymaster: pm.paymaster, calls: topped, build, allowance: this.allowances?.peek(sender),
          sign: async (op) => ((await client.signUserOperation({ uoStruct: op })) as UserOp).signature,
        }));
      } catch (e) {
        // User-facing copy is plain (no gas / paymaster wording); the server's reason stays in `detail` for logs.
        // `usdg: true` ⇒ session.ts skips the ETH refill (it can't cover a USDG shortfall).
        if (e instanceof PaymasterRpcError) {
          if (/not enough USDG/i.test(e.message)) throw new AAError("FundAccount", NOT_ENOUGH_USDG, { address: sender, data: e.data, usdg: true, detail: e.message });
          if (feeRetry && /fee below relayer floor/i.test(e.message)) { FEES.invalidate(); return this.sendCalls(calls, as, false, o); }
          throw new AAError("Bundler", TRADING_UNAVAILABLE, { data: e.data, detail: `paymaster: ${e.message.split("\n")[0].slice(0, 300)}` });
        }
        // client-side paymasterData checks (paymaster.ts) — real reverts from estimation still go through fail()
        const em = (e as Error)?.message ?? String(e);
        if (/^paymaster|fetch failed|failed to fetch|networkerror|timeout|aborted/i.test(em)) throw new AAError("Bundler", TRADING_UNAVAILABLE, { detail: em.split("\n")[0].slice(0, 300) });
        return fail(e);
      }
      if (!gas && !launch && !grad && !deployedOwner && limits && !calls.some((c) => c.data.length < 10)) this.gas.set(kind, limits);
      const hash = userOpHash(wire, this.o.chain.id);
      tt?.mark("send"); opPhase({ phase: "sent", userOpHash: hash, pressId: o.pressId });
      const result = await this.sendRaw(wire, hash, kind, t0, fail, "usdg", o.pressId);
      if (prepared?.nonce !== undefined) this.prepayReady = true;
      return result;
    }

    // ---- warm path: local build/sign, standard self-paid bundler submission
    if (gas && fees) {
      let struct, signed;
      try { struct = await this.buildOp(client, kind, uo.length === 1 ? uo[0] : uo, overrides); } catch (e) { return fail(e); }
      try { signed = await client.signUserOperation({ uoStruct: struct }); } catch (e) { return fail(e); }
      const wire = deepHexlify(signed) as UserOp;
      const hash = userOpHash(wire, this.o.chain.id);
      tt?.mark("send");
      opPhase({ phase: "sent", userOpHash: hash, pressId: o.pressId });
      return this.sendRaw(wire, hash, kind, t0, fail, "self-pay", o.pressId, async (e) => {
        // Only definite bundler validation rejections may rebuild/re-sign; never ambiguous sends.
        if (feeRetry && TRANSIENT_SIM.test(`${e.message} ${String(e.data ?? "")}`)) {
          await nextBlock(); return this.sendCalls(await retryCalls(calls, o), as, false, o);
        }
        if (feeRetry && /fee below relayer floor|fee too low|priority fee.*too low/i.test(e.message)) {
          FEES.invalidate(); await FEES.get(() => fetchFees(client as unknown as FeeClient)).catch(() => undefined);
          return this.sendCalls(calls, as, false, o);
        }
      });
    }
    // ---- standard path (first trade of a preset, or Alchemy): estimate once, then cache the limits
    let req;
    tt?.mark("send"); tt?.note({ path: launch ? "standard (launch)" : !gas ? "standard (no gas preset)" : !fees ? "standard (no fees)" : "standard (relay unavailable)" });
    try { req = await client.sendUserOperation({ uo: uo.length === 1 ? uo[0] : uo, overrides }); }
    catch (e) {
      const m = String((e as { details?: string; shortMessage?: string; message?: string }).details || (e as Error).message || e);
      // self-bundler eth_sendUserOperation broadcasts, then waits ≤25 s for the receipt: a timeout is NOT a failed simulation.
      // The relay reports the op's ids (error.data / "[userOp 0x…]"): kept on AAError.extra + console, never in the copy.
      // Any post-broadcast error (ref set) is pending unless the bundle reverted — its raw relay text never reaches players.
      const ref = relayOpRef(e);
      const ids = { userOpHash: ref?.userOpHash, txHash: ref?.txHash };
      if (ref && BUNDLE_REVERTED.test(m)) { this.gas.drop(kind); logRelayOp("rejected", ids); throw new AAError("Reverted", REJECTED_MSG, ids); }
      if (ref || /not confirmed|timeout/i.test(m)) { logRelayOp("pending", ids); throw new AAError("Timeout", PENDING_MSG, ids); }
      // AUDIT L2 (#145): a transport / internal error may follow a broadcast ⇒ pending, never a retry
      if (/fetch failed|failed to fetch|network|socket|ECONN|unreadable|internal error|context canceled|\b50[234]\b|FUNCTION_INVOCATION/i.test(m)
        || ((e as { status?: number }).status !== 429 && /HTTP request failed|took too long/i.test(`${(e as { shortMessage?: string }).shortMessage ?? ""} ${(e as Error).message ?? ""}`))) { logRelayOp("pending", ids); throw new AAError("Timeout", PENDING_MSG, { ...ids, detail: m.split("\n")[0].slice(0, 300) }); }
      if (feeRetry && TRANSIENT_SIM.test(m)) { await nextBlock(); return this.sendCalls(await retryCalls(calls, o), as, false, o); }
      return fail(e);
    }
    const t1 = now();
    tt?.mark("response");
    const rq = req.request as { callGasLimit?: Hex; verificationGasLimit?: Hex; preVerificationGas?: Hex };
    if (!gas && !launch && !grad && rq.callGasLimit && rq.verificationGasLimit && rq.preVerificationGas && !calls.some((c) => c.data.length < 10))
      this.gas.set(kind, { callGasLimit: BigInt(rq.callGasLimit), verificationGasLimit: BigInt(rq.verificationGasLimit), preVerificationGas: BigInt(rq.preVerificationGas) });
    opPhase({ phase: "submitted", userOpHash: req.hash, pressId: o.pressId });
    let txHash: Hex;
    try { txHash = await client.waitForUserOperationTransaction({ hash: req.hash, retries: { maxRetries: 120, intervalMs: 250, multiplier: 1 } }); }
    catch { logRelayOp("pending", { userOpHash: req.hash }); throw new AAError("Timeout", PENDING_MSG, unclearExtra({ unclear: true, reason: "receipt-timeout" }, req.hash, { sender, nonce: (req.request as { nonce?: Hex }).nonce })); }
    const rc = (await client.getUserOperationReceipt(req.hash)) as unknown as {
      success: boolean; actualGasCost?: bigint | Hex; receipt: { transactionHash: Hex; blockNumber?: bigint | Hex; logs: { address: Address; data: Hex; topics: Hex[]; blockNumber?: bigint | Hex }[] };
    } | null;
    if (rc && !rc.success) {
      this.gas.drop(kind);
      const revertData = opRevertReason(rc.receipt.logs ?? [], req.hash);
      logTradeError("trade reverted", { userOpHash: req.hash, txHash, revertData });
      throw new AAError("Reverted", REJECTED_MSG, { rc, userOpHash: req.hash, txHash, revertData, ...revertGas(rc.receipt.logs ?? [], req.hash, (req.request as { callGasLimit?: unknown }).callGasLimit) });
    }
    // receipt block on every log: post-trade reads pin to it (lib/trade/readFloor)
    const logs = rc?.receipt.logs ? withBlock(rc.receipt.logs.map((l) => ({ address: l.address, data: l.data, topics: l.topics })), rc.receipt.blockNumber ?? rc.receipt.logs[0]?.blockNumber) :
      await this.o.pc.getTransactionReceipt({ hash: txHash }).then((x) => withBlock(x.logs.map((l) => ({ address: l.address, data: l.data, topics: l.topics as Hex[] })), x.blockNumber));
    const timings: OpTimings = { build: Math.round(t1 - t0), sign: 0, rpc: Math.round(now() - t1), total: Math.round(now() - t0), fast: false };
    opPhase({ phase: "confirmed", userOpHash: req.hash, txHash, timings, pressId: o.pressId, blockNumber: blockStr((rc?.receipt as { blockNumber?: unknown } | undefined)?.blockNumber) });
    this.deployed = true;
    return { userOpHash: req.hash, txHash, gasMode: "self-pay", receipt: { success: true, receipt: { transactionHash: txHash, logs } }, timings };
  }

  /**
   * Rapid taps (GAME): USDG base units one pending op may still take for gas — SYNC, never awaits (lib/aa/gasReserve).
   * 0n when gas isn't paid in USDG; WARM (fresh allowance): its real maxTokenCost (trade) / the grad per-op bound;
   * null when cold. `kind`: "trade" (buy/sell, default) | "gradBuy".
   * USDG gas configured ⇒ reserved whichever key signs (a session op may fall back to the owner, which pays in USDG).
   */
  peekGasReservePerOp(kind: GasOpKind = "trade"): bigint | null {
    const pm = this.o.usdgGas;
    const a = pm && this.senderAddr ? this.allowances?.peek(this.senderAddr) : undefined;
    let allowance: WarmAllowance | undefined;
    if (a) {
      const d = a.disciple;
      allowance = { maxTokenCost: BigInt(d.maxTokenCost), rate: BigInt(d.rate), debt: BigInt(d.debt), maxFeePerGas: BigInt(d.maxFeePerGas) };
      this.lastRate = allowance.rate;
    }
    return peekReserve({ usdgGas: !!pm, kind, allowance, opMaxFee: FEES.peek()?.maxFeePerGas, maxGasPerOp: this.caps.peek()?.maxGasPerOp });
  }
  /** The paymaster's signed rate from the last fresh allowance (cold derivation prefers it over the config ETH/USD). */
  private lastRate?: bigint;
  /** peekGasReservePerOp, or (cold) the derived value: gas limit × allowance-formula maxFee(live gas price) × rate. */
  gasReservePerOp(kind: GasOpKind = "trade"): bigint {
    return reserveOrDerived(this.peekGasReservePerOp(kind), {
      kind, gasPriceWei: this.caps.gasPrice(), rate: this.lastRate, maxGasPerOp: this.caps.peek()?.maxGasPerOp,
      decimals: this.caps.peek()?.decimals ?? fallbackUsdgDecimals(this.o.chain.id),
    });
  }
  /** Warm every reserve input off the trade path (session start + warm()): gas price, maxGasPerOp + decimals, the
   * allowance (its maxTokenCost is the real warm value). */
  async warmGasReserve() {
    const pm = this.o.usdgGas; if (!pm) return;
    const me = this.senderAddr ?? (this.senderAddr = await this.address().catch(() => undefined));
    await Promise.all([
      this.caps.warmGasPrice(this.o.pc), this.caps.warm(this.o.pc, pm.paymaster, pm.usdg),
      me ? this.allowances?.refresh(me).catch(() => undefined) : undefined,
    ]);
  }


  /** Standard eth_sendUserOperation for an already-signed, self-paid op. */
  private async sendRaw(wire: UserOp, hash: Hex, kind: string, t0: number, fail: (e: unknown) => Promise<never>, gasMode: GasMode, pressId?: string, retry?: (e: { message: string; data?: unknown }) => Promise<SendResult | undefined>): Promise<SendResult> {
    checkUserPaid(wire, this.o.usdgGas?.paymaster);
    let r: Response;
    try {
      r = await fetch(absUrl(this.o.bundlerUrl), { method: "POST", headers: { "content-type": "application/json", ...(pressId ? { "x-disciple-press-id": pressId } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendUserOperation", params: [wire, ENTRYPOINT_V07] }) });
    } catch (e) {
      // The connection dropped during the POST: the op may already be in. Look it up before saying anything; never resend.
      const detail = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300);
      const got = await this.findOp(hash, wire.sender, 15_000);
      if (!got) { logRelayOp("pending", { userOpHash: hash }); throw new AAError("Timeout", PENDING_MSG, { ...unclearExtra({ unclear: true, reason: "network" }, hash, wire), detail }); }
      if (!got.success) {
        this.gas.drop(kind);
        const revertData = opRevertReason(got.logs, hash);
        logTradeError("trade reverted", { userOpHash: hash, txHash: got.txHash, revertData });
        throw new AAError("Reverted", REJECTED_MSG, { userOpHash: hash, txHash: got.txHash, revertData, ...revertGas(got.logs, hash, wire.callGasLimit) });
      }
      opPhase({ phase: "confirmed", userOpHash: hash, txHash: got.txHash, pressId, blockNumber: blockStr(...got.logs.map((l) => (l as { blockNumber?: unknown }).blockNumber)) });
      this.deployed = true;
      return { userOpHash: hash, txHash: got.txHash, gasMode, receipt: { success: true, receipt: { transactionHash: got.txHash, logs: got.logs } } };
    }
    const j = await r.json().catch(() => ({ error: { message: `send response unreadable (HTTP ${r.status})`, unreadable: true } })) as { result?: Hex; error?: { code?: number; message: string; data?: unknown; unreadable?: boolean } };
    if (j.error) {
      if (/not confirmed|timeout/i.test(j.error.message)) {
        logRelayOp("pending", { userOpHash: hash });
        throw new AAError("Timeout", PENDING_MSG, unclearExtra(relayUnclear({ message: j.error.message, data: j.error.data }, hash) ?? { unclear: true, reason: "receipt-timeout" }, hash, wire));
      }
      // AUDIT L2 (#145): unreadable answer / internal error after the POST — the op may be in: look it up, never resend
      if (j.error.unreadable || relayErrorUnclear(j.error)) {
        const txh = (j.error.data as { txHash?: Hex } | undefined)?.txHash;
        const got = (txh ? await this.receiptFor(txh, hash) : null) ?? await this.findOp(hash, wire.sender);
        if (!got) { logRelayOp("pending", { userOpHash: hash }); throw new AAError("Timeout", PENDING_MSG, { ...unclearExtra(unclearOf(j.error, hash), hash, wire), detail: j.error.message.split("\n")[0].slice(0, 300) }); }
        if (!got.success) {
          this.gas.drop(kind);
          const revertData = opRevertReason(got.logs, hash);
          logTradeError("trade reverted", { userOpHash: hash, txHash: got.txHash, revertData });
          throw new AAError("Reverted", REJECTED_MSG, { userOpHash: hash, txHash: got.txHash, revertData, ...revertGas(got.logs, hash, wire.callGasLimit) });
        }
        opPhase({ phase: "confirmed", userOpHash: hash, txHash: got.txHash, pressId, blockNumber: blockStr(...got.logs.map((l) => (l as { blockNumber?: unknown }).blockNumber)) });
        this.deployed = true;
        return { userOpHash: hash, txHash: got.txHash, gasMode, receipt: { success: true, receipt: { transactionHash: got.txHash, logs: got.logs } } };
      }
      const retried = await retry?.(j.error);
      if (retried) return retried;
      // Infrastructure failures use existing plain copy; real reverts still decode via fail()
      if (j.error.unreadable || (!/simulation|revert|AA[0-9]{2}/i.test(j.error.message) && INFRA_WORDING.test(j.error.message)))
        throw new AAError("Bundler", TRADING_UNAVAILABLE, { userOpHash: hash, detail: j.error.message.split("\n")[0].slice(0, 300) });
      return fail(Object.assign(new Error(j.error.message), { data: j.error.data }));
    }
    opPhase({ phase: "submitted", userOpHash: hash, pressId });
    const got = await this.findOp(hash, wire.sender, 30_000);
    if (!got) { logRelayOp("pending", { userOpHash: hash }); throw new AAError("Timeout", PENDING_MSG, unclearExtra({ unclear: true, reason: "receipt-timeout" }, hash, wire)); }
    if (!got.success) {
      this.gas.drop(kind);
      const revertData = opRevertReason(got.logs, hash);
      logTradeError("trade reverted", { userOpHash: hash, txHash: got.txHash, revertData });
      throw new AAError("Reverted", REJECTED_MSG, { userOpHash: hash, txHash: got.txHash, revertData, ...revertGas(got.logs, hash, wire.callGasLimit) });
    }
    const timings: OpTimings = { build: 0, sign: 0, rpc: Math.round(now() - t0), total: Math.round(now() - t0), fast: false };
    opPhase({ phase: "confirmed", userOpHash: hash, txHash: got.txHash, timings, pressId, blockNumber: blockStr(...got.logs.map((l) => (l as { blockNumber?: unknown }).blockNumber)) });
    this.deployed = true;
    return { userOpHash: hash, txHash: got.txHash, gasMode, receipt: { success: true, receipt: { transactionHash: got.txHash, logs: got.logs } }, timings };
  }
}
