/**
 * Alchemy Modular Account v2 (SemiModularAccountBytecode, EntryPoint v0.7) via aa-sdk — replaces the LightAccount v2
 * flow in core.ts for embedded users. MAv2 signatures carry a validation-selection prefix, so we never hand-roll them.
 *  - owner = Privy embedded EOA (fallback signer, global validation): account creation, session install/revoke, mints.
 *  - session key = browser-held key, SingleSigner entity (non-global, execute/executeBatch) + DiscipleSessionPolicy hooks.
 *  - gas: self-pay only (no paymaster / gas policy). Bundler goes through /api/bundler.
 */
import { createModularAccountV2Client } from "@account-kit/smart-contracts";
import { LocalAccountSigner, defaultGasEstimator, deepHexlify, split, type ClientMiddlewareFn, type SmartAccountSigner } from "@aa-sdk/core";
import { concatHex, decodeEventLog, encodeFunctionData, http, parseAbi, type Address, type Chain, type Hex, type LocalAccount, type PublicClient } from "viem";
import { MAV2_FACTORY } from "./constants";
import { NonceCursor, GasCache, STATIC_GAS, FeeCache, callsKind, type GasLimits, type Fees } from "./fastPath";
import { clientFees, isLaunchCalls } from "./gasPolicy";
import { launchTargets } from "./launchTargets";
import { AAError, userOpHash, type Call, type GasMode, type OwnerSigner, type UserOp, type UserOpReceipt } from "./core";
import { ENTRYPOINT_V07 } from "./constants";
import type { TradeTiming } from "../trade/timing";
import { withBlock } from "../trade/readFloor";
import { BUNDLE_REVERTED, PENDING_MSG, REJECTED_MSG, keptOpRef, logRelayOp, logTradeError, relayOpRef } from "./relayOp";

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
/**
 * Relay answers that do NOT prove the op wasn't sent: the response was lost/garbled, the relay timed out waiting for the
 * receipt, or the nonce is already used (= an earlier send of this op landed). Bug #6: these were all shown as
 * "simulation failed" — and the standard-path fallback re-sent the same nonce (AA25 ⇒ "simulation failed") — while
 * the first send went through. Now we look the op up on-chain first.
 */
export const AMBIGUOUS_RELAY = /not confirmed|timeout|timed out|AA25|invalid account nonce|nonce too low|already known|fetch failed|network|502|503|504|FUNCTION_INVOCATION/i;
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
export type OpPhase = { phase: "submitted" | "confirmed"; userOpHash: Hex; txHash?: Hex; timings?: unknown };
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
  const o = args.overrides as Partial<Record<keyof GasLimits, bigint>> | undefined;
  if (o?.callGasLimit && o?.verificationGasLimit && o?.preVerificationGas) {
    Object.assign(struct, { callGasLimit: o.callGasLimit, verificationGasLimit: o.verificationGasLimit, preVerificationGas: o.preVerificationGas });
    return struct;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return defaultGasEstimator((args as any).client)(struct, args);
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

export type Mav2Opts = { chain: Chain; pc: PublicClient; bundlerUrl: string; salt?: bigint; /** tests: always estimate on a cold preset */ noStaticGas?: boolean };
/** Per-stage latency (ms) of one op. build = calldata+nonce+fees+gas, sign = signature, rpc = client→server→client,
 * server = self-bundler stages (sign tx, send, mined/receipt) when the sync method is used. */
export type OpTimings = { build: number; sign: number; rpc: number; total: number; fast: boolean; server?: Record<string, number> };
export type SendResult = { userOpHash: Hex; txHash: Hex; receipt: UserOpReceipt; gasMode: GasMode; timings?: OpTimings };
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function absUrl(u: string) {
  return /^https?:/.test(u) ? u : new URL(u, typeof location !== "undefined" ? location.origin : "http://localhost:3000").toString();
}

export class Mav2Account {
  gasMode: GasMode | "unknown" = "self-pay";
  /** Parallel nonce keys: every op gets a fresh 152-bit key (seq 0) ⇒ the nonce is known locally, ops never collide. */
  readonly nonces = new NonceCursor();
  readonly gas = new GasCache();
  private syncOk: boolean | undefined;   // server supports disciple_sendUserOperationSync (self-bundler)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ownerClient?: Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sessionClient?: { entityId: number; c: Promise<any> };
  constructor(private o: Mav2Opts, private owner: LocalAccount) {}

  private transport() {
    return split({ overrides: [{ methods: BUNDLER_METHODS, transport: http(absUrl(this.o.bundlerUrl)) }], fallback: http(this.o.chain.rpcUrls.default.http[0]) });
  }
  private owned() {
    return (this.ownerClient ??= createModularAccountV2Client({
      feeEstimator: rundlerFeeEstimator, gasEstimator: cachedGasEstimator,
      chain: this.o.chain, transport: this.transport(), signer: asSigner(this.owner),
      salt: this.o.salt ?? BigInt(0), factoryAddress: MAV2_FACTORY,
    }).then(memoizeExecPrefix));
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
      await new Promise((res) => setTimeout(res, 400));
    }
  }

  /** Warm everything a trade needs (clients, address, fees) so the first tap doesn't pay for it. */
  /** deployed-state cache (true is final; false re-checked on warm) */
  deployed?: boolean;
  async warm() {
    const c = await (this.sessionClient ? this.sessionClient.c : this.owned());
    await Promise.all([
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
   * is kept only if rebuilding the op it came from gives the identical struct; ops with factory/paymaster fields never
   * template. The op is still signed by client.signUserOperation (same key, same hash) — nothing about the policy changes.
   */
  private tpl = new Map<string, Record<string, unknown>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async buildOp(client: any, kind: string, uo: Tx | Tx[], overrides: Record<string, unknown>): Promise<any> {
    const key = `${kind}|${client.account.address}`;
    const encode = () => (Array.isArray(uo) ? client.account.encodeBatchExecute(uo) : client.account.encodeExecute(uo));
    const t = this.tpl.get(key);
    if (t) return { ...t, ...overrides, callData: await encode() };
    const struct = await client.buildUserOperation({ uo, overrides: overrides as never });
    const s = struct as unknown as Record<string, unknown>;
    if (s && !s.factory && !s.factoryData && !s.paymaster && !s.paymasterAndData && typeof client.account?.encodeExecute === "function") {
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
   * nonce/fees/gas are local, the op is signed in memory and sent with ONE round trip to /api/bundler
   * (disciple_sendUserOperationSync: the self-bundler relays handleOps immediately and answers with the receipt).
   */
  async sendCalls(calls: Call[], as: "owner" | "session" = "owner", feeRetry = true, tt?: TradeTiming): Promise<SendResult> {
    const t0 = now();
    const session = as === "session" && this.sessionClient;
    const client = session ? await this.sessionClient!.c : await this.owned();
    const uo = calls.map((c) => ({ target: c.to, data: c.data, value: c.value ?? BigInt(0) }));
    const sender: Address = client.account.address;
    const nonce = this.nonces.next(session ? this.sessionClient!.entityId : 0, !session);
    const kind = `${as}|${callsKind(calls)}`;
    // Launches (≈ 6M+ execution gas) ALWAYS estimate: STATIC_GAS (1.8M) runs out and a cached 1.5x would exceed the
    // launch cap. Fees are fresh and un-doubled so the prefund (gas × maxFee) stays small (~0.0002 ETH at 8M gas).
    const launch = isLaunchCalls(calls, launchTargets(this.o.chain.id));
    // self-bundler + deployed account ⇒ static conservative limits if this preset was never estimated (cold < 500 ms)
    const gas = launch ? undefined : this.gas.get(kind) ?? (this.deployed && this.syncOk !== false && !this.o.noStaticGas ? STATIC_GAS : undefined);
    // latency: cold fee cache on the fast path ⇒ wait for ONE fee read (~0.1 s) instead of dropping to the multi-second
    // standard flow (estimate + eth_sendUserOperation + receipt polling). Launches keep their fresh un-doubled fees.
    const fees = launch ? await fetchFees(client as unknown as FeeClient).catch(() => undefined)
      : FEES.peek(() => fetchFees(client as unknown as FeeClient)) ?? (gas && this.syncOk !== false ? await FEES.get(() => fetchFees(client as unknown as FeeClient)).catch(() => undefined) : undefined);
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
      // keep the revert payload (e.g. PreExecHookReverted(module, reason)) so callers/tests can decode the policy error
      let revertData: string | undefined = typeof (e as { data?: unknown }).data === "string" && /^0x[0-9a-fA-F]{8,}$/.test((e as { data: string }).data) ? (e as { data: string }).data : undefined;
      if (!revertData) (e as { walk?: (f: (x: unknown) => boolean) => unknown }).walk?.((x) => { const dd = (x as { data?: unknown }).data; if (typeof dd === "string" && /^0x[0-9a-fA-F]{8,}$/.test(dd)) { revertData = dd; return true; } return false; });
      throw new AAError("Estimate", `simulation failed: ${msg.split("\n")[0].slice(0, 200)}`, { revertData });
    };

    // ---- fast path: warm preset + self-bundler sync method
    if (gas && fees && this.syncOk !== false) {
      let struct, signed;
      try { struct = await this.buildOp(client, kind, uo.length === 1 ? uo[0] : uo, overrides); } catch (e) { return fail(e); }
      const t1 = now();
      try { signed = await client.signUserOperation({ uoStruct: struct }); } catch (e) { return fail(e); }
      const t2 = now();
      const wire = deepHexlify(signed) as UserOp;
      const hash = (() => { try { return userOpHash(wire, this.o.chain.id); } catch { return undefined; } })();
      tt?.mark("send");
      type SyncRes = { result?: { userOpHash: Hex; txHash: Hex; success: boolean; logs: { address: Address; data: Hex; topics: Hex[] }[]; blockNumber?: Hex; t?: Record<string, number> }; error?: { code: number; message: string; data?: string } };
      const r = await fetch(absUrl(this.o.bundlerUrl), { method: "POST", headers: { "content-type": "application/json" }, keepalive: true,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "disciple_sendUserOperationSync", params: [wire, client.account.getEntryPoint().address] }) }).catch((e) => ({ status: 0, json: async () => ({ error: { code: -32099, message: `network: ${(e as Error).message}` } }) }) as unknown as Response);
      let j = await r.json().catch(() => ({ error: { code: -32098, message: `relay response unreadable (HTTP ${r.status})` } })) as SyncRes;
      const t3 = now();
      tt?.mark("response");
      tt?.note({ path: "fast", build: Math.round(t1 - t0), sign: Math.round(t2 - t1), roundTrip: Math.round(t3 - t2), server: j.result?.t });
      // Post-broadcast relay error: the relay answers with the op's ids (error.data, lib/aa/relayOp). Keep OUR hash (the
      // op we signed); the relay's bundle tx hash only if it reports the same op.
      const ref = j.error ? relayOpRef(j.error) : undefined;
      const ids = keptOpRef(hash, ref);
      if (j.error && ref && BUNDLE_REVERTED.test(j.error.message)) {
        // handleOps itself reverted: the op was not executed (no UserOperationEvent) — not a "simulation failed"
        this.gas.drop(kind); logRelayOp("rejected", ids);
        throw new AAError("Reverted", REJECTED_MSG, { userOpHash: ids.userOpHash, txHash: ids.txHash });
      }
      // Ambiguous failure (lost response, receipt timeout, nonce already used, or sent but unconfirmed): the op may have
      // landed — check before failing.
      if (j.error && ids.userOpHash && j.error.code !== -32601 && (ref || AMBIGUOUS_RELAY.test(j.error.message))) {
        const got = await this.findOp(ids.userOpHash, sender);
        if (got) j = { result: got };
        else if (ref) { logRelayOp("pending", ids); throw new AAError("Timeout", PENDING_MSG, { userOpHash: ids.userOpHash, txHash: ids.txHash }); }
      }
      if (j.error && feeRetry && TRANSIENT_SIM.test(`${j.error.message} ${j.error.data ?? ""}`)) {
        // the relay's pre-flight ran on a node that hasn't seen our previous op yet: nothing was sent; retry once
        await new Promise((res) => setTimeout(res, 700));
        return this.sendCalls(calls, as, false, tt);
      }
      if (j.error?.code === -32601) this.syncOk = false;   // Alchemy (or old server): fall through to the standard flow
      else if (j.error && feeRetry && /fee below relayer floor/i.test(j.error.message)) {
        // cached fees went stale (base fee rose): nothing was sent; refresh fees and re-sign once
        FEES.invalidate();
        await FEES.get(() => fetchFees(client as unknown as FeeClient)).catch(() => undefined);
        return this.sendCalls(calls, as, false, tt);
      } else if (j.error) {
        if (/AA2[0-9]|AA3[0-9]|out of gas|gas/i.test(j.error.message)) this.gas.drop(kind);   // stale limits → re-estimate next time
        // Never fall through to the standard path here: a second send of the same nonce can only fail (AA25) after the
        // first landed. Relay-side errors that aren't a pre-flight rejection (incl. network failure / unreadable response,
        // codes -32099 / -32098) get the plain line; the raw relay text goes to the console + extra.relayError only.
        if (!/simulation|revert|AA[0-9]{2}/i.test(j.error.message)) {
          const relayError = j.error.message.split("\n")[0].slice(0, 200);
          logTradeError("trade failed (relay error)", { code: j.error.code, relayError, userOpHash: hash });
          throw new AAError("Bundler", REJECTED_MSG, { userOpHash: hash, relayError, rpcCode: j.error.code });
        }
        return fail(Object.assign(new Error(j.error.message), { data: j.error.data }));
      } else if (j.result) {
        this.syncOk = true;
        const { userOpHash, txHash, success } = j.result;
        const logs = withBlock(j.result.logs, j.result.blockNumber);   // receipt block on every log: post-trade reads pin to it
        opPhase({ phase: "submitted", userOpHash, txHash });
        const timings: OpTimings = { build: Math.round(t1 - t0), sign: Math.round(t2 - t1), rpc: Math.round(t3 - t2), total: Math.round(t3 - t0), fast: true, server: j.result.t };
        if (!success) {
          this.gas.drop(kind);
          const revertData = opRevertReason(logs, userOpHash);
          logTradeError("trade reverted", { userOpHash, txHash, revertData });
          throw new AAError("Reverted", REJECTED_MSG, { userOpHash, txHash, revertData });
        }
        opPhase({ phase: "confirmed", userOpHash, txHash, timings });
        this.deployed = true;
        return { userOpHash, txHash, gasMode: "self-pay", receipt: { success: true, receipt: { transactionHash: txHash, logs } }, timings };
      }
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
      if (feeRetry && TRANSIENT_SIM.test(m)) { await new Promise((res) => setTimeout(res, 700)); return this.sendCalls(calls, as, false, tt); }
      return fail(e);
    }
    const t1 = now();
    tt?.mark("response");
    const rq = req.request as { callGasLimit?: Hex; verificationGasLimit?: Hex; preVerificationGas?: Hex };
    if (!gas && !launch && rq.callGasLimit && rq.verificationGasLimit && rq.preVerificationGas && !calls.some((c) => c.data.length < 10))
      this.gas.set(kind, { callGasLimit: BigInt(rq.callGasLimit), verificationGasLimit: BigInt(rq.verificationGasLimit), preVerificationGas: BigInt(rq.preVerificationGas) });
    opPhase({ phase: "submitted", userOpHash: req.hash });
    let txHash: Hex;
    try { txHash = await client.waitForUserOperationTransaction({ hash: req.hash, retries: { maxRetries: 120, intervalMs: 250, multiplier: 1 } }); }
    catch { logRelayOp("pending", { userOpHash: req.hash }); throw new AAError("Timeout", PENDING_MSG, { userOpHash: req.hash }); }
    const rc = (await client.getUserOperationReceipt(req.hash)) as unknown as {
      success: boolean; actualGasCost?: bigint | Hex; receipt: { transactionHash: Hex; blockNumber?: bigint | Hex; logs: { address: Address; data: Hex; topics: Hex[]; blockNumber?: bigint | Hex }[] };
    } | null;
    if (rc && !rc.success) {
      this.gas.drop(kind);
      const revertData = opRevertReason(rc.receipt.logs ?? [], req.hash);
      logTradeError("trade reverted", { userOpHash: req.hash, txHash, revertData });
      throw new AAError("Reverted", REJECTED_MSG, { rc, userOpHash: req.hash, txHash, revertData });
    }
    const logs = rc?.receipt.logs ? withBlock(rc.receipt.logs.map((l) => ({ address: l.address, data: l.data, topics: l.topics })), rc.receipt.blockNumber ?? rc.receipt.logs[0]?.blockNumber) :
      await this.o.pc.getTransactionReceipt({ hash: txHash }).then((x) => withBlock(x.logs.map((l) => ({ address: l.address, data: l.data, topics: l.topics as Hex[] })), x.blockNumber));
    const timings: OpTimings = { build: Math.round(t1 - t0), sign: 0, rpc: Math.round(now() - t1), total: Math.round(now() - t0), fast: false };
    opPhase({ phase: "confirmed", userOpHash: req.hash, txHash, timings });
    this.deployed = true;
    return { userOpHash: req.hash, txHash, gasMode: "self-pay", receipt: { success: true, receipt: { transactionHash: txHash, logs } }, timings };
  }
}
