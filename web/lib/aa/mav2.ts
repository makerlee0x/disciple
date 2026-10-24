/**
 * Alchemy Modular Account v2 (SemiModularAccountBytecode, EntryPoint v0.7) via aa-sdk — replaces the LightAccount v2
 * flow in core.ts for embedded users. MAv2 signatures carry a validation-selection prefix, so we never hand-roll them.
 *  - owner = Privy embedded EOA (fallback signer, global validation): account creation, session install/revoke, mints.
 *  - session key = browser-held key, SingleSigner entity (non-global, execute/executeBatch) + DiscipleSessionPolicy hooks.
 *  - gas: in USDG via DisciplePaymaster (/api/paymaster, lib/aa/paymasterClient) when `usdgGas` is configured
 *    (NEXT_PUBLIC_RHT_PAYMASTER set); otherwise self-pay in ETH (account prefund). Never sponsored.
 *    Bundler goes through /api/bundler.
 */
import { createModularAccountV2Client } from "@account-kit/smart-contracts";
import { LocalAccountSigner, defaultGasEstimator, deepHexlify, split, type ClientMiddlewareFn, type SmartAccountSigner } from "@aa-sdk/core";
import { concatHex, decodeEventLog, encodeFunctionData, http, parseAbi, type Address, type Chain, type Hex, type LocalAccount, type PublicClient } from "viem";
import { MAV2_FACTORY } from "./constants";
import { NonceCursor, GasCache, STATIC_GAS, GRAD_STATIC_GAS, FeeCache, callsKind, isGradBuyCalls, retryCalls, type GasLimits, type Fees, type SendOpts } from "./fastPath";
import { clientFees, isLaunchCalls, INFRA_WORDING, NOT_ENOUGH_USDG, TRADING_UNAVAILABLE } from "./gasPolicy";
import { launchTargets } from "./launchTargets";
import { AAError, userOpHash, type Call, type GasMode, type OwnerSigner, type UserOp, type UserOpReceipt } from "./core";
import { ENTRYPOINT_V07 } from "./constants";
import { AllowanceCache, payGasInUsdg, PaymasterRpcError, type PaymasterFields } from "./paymasterClient";
import { relaySend } from "./relayClient";
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

/**
 * USDG gas (DisciplePaymaster). `session: false` ⇒ only owner ops use it (session keys on a policy < 1.4.0 can't
 * approve the paymaster and keep paying in ETH).
 */
export type UsdgGasOpts = { paymaster: Address; usdg: Address; url: string; session: boolean };
export type Mav2Opts = { chain: Chain; pc: PublicClient; bundlerUrl: string; salt?: bigint; /** tests: always estimate on a cold preset */ noStaticGas?: boolean; usdgGas?: UsdgGasOpts };
/** Per-stage latency (ms) of one op. build = calldata+nonce+fees+gas, sign = signature, rpc = client→server→client,
 * server = self-bundler stages (sign tx, send, mined/receipt) when the sync method is used. */
export type OpTimings = { build: number; sign: number; rpc: number; total: number; fast: boolean; server?: Record<string, number> };
export type SendResult = { userOpHash: Hex; txHash: Hex; receipt: UserOpReceipt; gasMode: GasMode; timings?: OpTimings };
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function absUrl(u: string) {
  return /^https?:/.test(u) ? u : new URL(u, typeof location !== "undefined" ? location.origin : "http://localhost:3000").toString();
}

export class Mav2Account {
  gasMode: GasMode | "unknown";
  /** Parallel nonce keys: every op gets a fresh 152-bit key (seq 0) ⇒ the nonce is known locally, ops never collide. */
  readonly nonces = new NonceCursor();
  readonly gas = new GasCache();
  private syncOk: boolean | undefined;   // server supports disciple_sendUserOperationSync (self-bundler)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ownerClient?: Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sessionClient?: { entityId: number; c: Promise<any> };
  /** Pre-issued per-sender paymaster allowance (item 5): 0 pm_* calls on a warm USDG-gas trade. */
  readonly allowances?: AllowanceCache;
  constructor(private o: Mav2Opts, private owner: LocalAccount) {
    this.gasMode = o.usdgGas ? "usdg" : "self-pay";
    if (o.usdgGas) this.allowances = new AllowanceCache({ url: absUrl(o.usdgGas.url), chainId: o.chain.id });
  }

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
          return { userOpHash: hash, txHash: rc.transactionHash, success: !!l.args.success, logs: rc.logs.map((x) => ({ address: x.address, data: x.data, topics: x.topics as Hex[] })) };
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
    await Promise.all([
      this.deployed ? 0 : c.account.isAccountDeployed?.().then((d: boolean) => { this.deployed = d; }),
      FEES.get(() => fetchFees(c as unknown as FeeClient)),
      this.allowances?.refresh(c.account.address as Address),
      // learn the executeUserOp-prefix answer now (memoizeExecPrefix) so the first tap encodes locally
      c.account.encodeExecute({ target: "0x0000000000000000000000000000000000000001", data: "0x", value: BigInt(0) }),
    ]).catch(() => undefined);
  }

  /**
   * Send calls as ONE userOp. `as: "session"` signs with the session key (no Privy prompt); default owner.
   * No queue: each op takes its own nonce key, so rapid shots are in flight at once. Fast path (warm preset):
   * nonce/fees/gas are local, the op is signed in memory and sent with ONE round trip to /api/bundler
   * (disciple_sendUserOperationSync: the self-bundler relays handleOps immediately and answers with the receipt).
   * `o.rebuild` (rapid taps): the ONE transient-error retry re-quotes via rebuild() (fresh minOut) instead of re-sending
   * the stale calls; every attempt, retries included, takes a fresh 2D nonce key. The fee-floor retry keeps the calls.
   */
  async sendCalls(calls: Call[], as: "owner" | "session" = "owner", feeRetry = true, o: SendOpts = {}): Promise<SendResult> {
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
    // Graduating buys (flagged by the trade layer: quote ≥ remaining to graduation) ALSO always estimate: Migration +
    // 16 floor bands ≈ 2.76M execution > STATIC_GAS, and the estimate is never cached for the preset (GRAD_GAS_CAPS server-side).
    const grad = !launch && isGradBuyCalls(calls);
    // self-bundler + deployed account ⇒ static conservative limits if this preset was never estimated (cold < 500 ms)
    const gas = launch || grad ? undefined : this.gas.get(kind) ?? (this.deployed && this.syncOk !== false && !this.o.noStaticGas ? STATIC_GAS : undefined);
    const fees = launch ? await fetchFees(client as unknown as FeeClient).catch(() => undefined) : FEES.peek(() => fetchFees(client as unknown as FeeClient));
    const overrides = { nonce, ...(gas ?? {}), ...(fees ?? {}) };
    const fail = async (e: unknown): Promise<never> => {
      const m = (e as { details?: string; shortMessage?: string; message?: string });
      const msg = String(m.details || m.shortMessage || m.message || e);
      // the relay's pre-flight returns FailedOp(0, "AA21 didn't pay prefund") as revert DATA ("AA21" = 0x41413231), not text
      const raw = typeof (e as { data?: unknown }).data === "string" ? String((e as { data: string }).data).toLowerCase() : "";
      if (/insufficient|prefund|AA21|didn't pay/i.test(msg) || raw.includes("41413231")) {
        const have = await this.o.pc.getBalance({ address: sender });
        throw new AAError("FundAccount", "Your account is still being set up for network fees — try again in a moment.", { have, address: sender });
      }
      // AA3x = the paymaster rejected / couldn't pay (deposit, signature, postOp): infrastructure, never shown verbatim
      if (/AA3[0-9]/.test(msg) || raw.includes("414133")) throw new AAError("Bundler", TRADING_UNAVAILABLE, { detail: msg.split("\n")[0].slice(0, 300) });
      // keep the revert payload (e.g. PreExecHookReverted(module, reason)) so callers/tests can decode the policy error
      let revertData: string | undefined = typeof (e as { data?: unknown }).data === "string" && /^0x[0-9a-fA-F]{8,}$/.test((e as { data: string }).data) ? (e as { data: string }).data : undefined;
      if (!revertData) (e as { walk?: (f: (x: unknown) => boolean) => unknown }).walk?.((x) => { const dd = (x as { data?: unknown }).data; if (typeof dd === "string" && /^0x[0-9a-fA-F]{8,}$/.test(dd)) { revertData = dd; return true; } return false; });
      throw new AAError("Estimate", `simulation failed: ${msg.split("\n")[0].slice(0, 200)}`, { revertData });
    };

    // ---- USDG gas (DisciplePaymaster): quote → exact approve first → signed paymasterData → relay
    if (this.usdgGasFor(as)) {
      const pm = this.o.usdgGas!;
      const f = fees ?? await FEES.get(() => fetchFees(client as unknown as FeeClient));
      // Frozen after the first build ⇒ every phase prices the same gas. A session op can't be estimated without its
      // signed paymasterAndData (the policy checks approve == maxTokenCost), and sessions imply a deployed account:
      // static limits. Owner ops estimate execution once (self-bundler: no prefund check) with the placeholder approve.
      // Launches (owner-signed) always estimate (gas undefined above) and are capped by LAUNCH_GAS_CAPS server-side.
      let limits: GasLimits | undefined = gas ?? (session && !launch ? (grad ? GRAD_STATIC_GAS : STATIC_GAS) : undefined);
      const build = async (cs: Call[], pmf: PaymasterFields): Promise<UserOp> => {
        const u = cs.map((c) => ({ target: c.to, data: c.data, value: c.value ?? BigInt(0) }));
        const struct = await client.buildUserOperation({ uo: u.length === 1 ? u[0] : u, overrides: { nonce, ...f, ...(limits ?? {}) } });
        const w = deepHexlify(struct) as UserOp;
        limits ??= { callGasLimit: BigInt(w.callGasLimit!), verificationGasLimit: BigInt(w.verificationGasLimit!), preVerificationGas: BigInt(w.preVerificationGas!) };
        return { ...w, ...pmf };
      };
      let wire: UserOp;
      try {
        ({ op: wire } = await payGasInUsdg({
          url: absUrl(pm.url), chainId: this.o.chain.id, usdg: pm.usdg, paymaster: pm.paymaster, calls, build, allowance: this.allowances?.peek(sender),
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
        if (/^paymaster|fetch failed|failed to fetch|networkerror/i.test(em)) throw new AAError("Bundler", TRADING_UNAVAILABLE, { detail: em.split("\n")[0].slice(0, 300) });
        return fail(e);
      }
      if (!gas && !launch && !grad && limits && !calls.some((c) => c.data.length < 10)) this.gas.set(kind, limits);
      const t1 = now();
      const hash = userOpHash(wire, this.o.chain.id);
      if (this.syncOk !== false) {
        const r = await this.relaySync(wire, hash, { sender, kind, calls, as, feeRetry, opts: o, fail, t0, t1, t2: t1, gasMode: "usdg", feeClient: client as unknown as FeeClient });
        if (r) return r;
      }
      return this.sendRaw(wire, hash, kind, t0, fail, "usdg");
    }

    // ---- fast path: warm preset + self-bundler sync method
    if (gas && fees && this.syncOk !== false) {
      let struct, signed;
      try { struct = await client.buildUserOperation({ uo: uo.length === 1 ? uo[0] : uo, overrides }); } catch (e) { return fail(e); }
      const t1 = now();
      try { signed = await client.signUserOperation({ uoStruct: struct }); } catch (e) { return fail(e); }
      const t2 = now();
      const wire = deepHexlify(signed) as UserOp;
      const hash = (() => { try { return userOpHash(wire, this.o.chain.id); } catch { return undefined; } })();
      const r = await this.relaySync(wire, hash, { sender, kind, calls, as, feeRetry, opts: o, fail, t0, t1, t2, gasMode: "self-pay", feeClient: client as unknown as FeeClient });
      if (r) return r;
    }
    // ---- standard path (first trade of a preset, or Alchemy): estimate once, then cache the limits
    let req;
    try { req = await client.sendUserOperation({ uo: uo.length === 1 ? uo[0] : uo, overrides }); }
    catch (e) {
      const m = String((e as { details?: string; shortMessage?: string; message?: string }).details || (e as Error).message || e);
      // self-bundler eth_sendUserOperation broadcasts, then waits ≤25 s for the receipt: a timeout is NOT a failed simulation
      if (/not confirmed|timeout/i.test(m)) throw new AAError("Timeout", "Trade sent — still confirming on-chain. Check your balance in a moment.");
      if (feeRetry && TRANSIENT_SIM.test(m)) { await nextBlock(); return this.sendCalls(await retryCalls(calls, o), as, false, o); }
      return fail(e);
    }
    const t1 = now();
    const rq = req.request as { callGasLimit?: Hex; verificationGasLimit?: Hex; preVerificationGas?: Hex };
    if (!gas && !launch && !grad && rq.callGasLimit && rq.verificationGasLimit && rq.preVerificationGas && !calls.some((c) => c.data.length < 10))
      this.gas.set(kind, { callGasLimit: BigInt(rq.callGasLimit), verificationGasLimit: BigInt(rq.verificationGasLimit), preVerificationGas: BigInt(rq.preVerificationGas) });
    opPhase({ phase: "submitted", userOpHash: req.hash });
    let txHash: Hex;
    try { txHash = await client.waitForUserOperationTransaction({ hash: req.hash, retries: { maxRetries: 120, intervalMs: 250, multiplier: 1 } }); }
    catch { throw new AAError("Timeout", `UserOp ${req.hash} not mined yet`); }
    const rc = (await client.getUserOperationReceipt(req.hash)) as unknown as {
      success: boolean; actualGasCost?: bigint | Hex; receipt: { transactionHash: Hex; logs: { address: Address; data: Hex; topics: Hex[] }[] };
    } | null;
    if (rc && !rc.success) { this.gas.drop(kind); throw new AAError("Reverted", `UserOp reverted (tx ${txHash})`, { rc, txHash, revertData: opRevertReason(rc.receipt.logs ?? [], req.hash) }); }
    const logs = rc?.receipt.logs?.map((l) => ({ address: l.address, data: l.data, topics: l.topics })) ??
      (await this.o.pc.getTransactionReceipt({ hash: txHash })).logs.map((l) => ({ address: l.address, data: l.data, topics: l.topics as Hex[] }));
    const timings: OpTimings = { build: Math.round(t1 - t0), sign: 0, rpc: Math.round(now() - t1), total: Math.round(now() - t0), fast: false };
    opPhase({ phase: "confirmed", userOpHash: req.hash, txHash, timings });
    this.deployed = true;
    return { userOpHash: req.hash, txHash, gasMode: "self-pay", receipt: { success: true, receipt: { transactionHash: txHash, logs } }, timings };
  }

  private usdgGasFor(as: "owner" | "session") { const u = this.o.usdgGas; return !!u && (as === "owner" || u.session); }

  /** One round trip: disciple_sendUserOperationSync. null ⇒ the server doesn't support it (Alchemy): use the standard path. */
  private async relaySync(wire: UserOp, hash: Hex | undefined, c: {
    sender: Address; kind: string; calls: Call[]; as: "owner" | "session"; feeRetry: boolean; opts: SendOpts; fail: (e: unknown) => Promise<never>;
    t0: number; t1: number; t2: number; gasMode: GasMode; feeClient: FeeClient;
  }): Promise<SendResult | null> {
      // one POST; the receipt (full, with logs) comes back on it — streamed after a RelayPending on the slow path
      let j = await relaySend(absUrl(this.o.bundlerUrl), wire, ENTRYPOINT_V07, (p) => opPhase({ phase: "submitted", userOpHash: p.userOpHash, txHash: p.txHash }));
      const t3 = now();
      // Ambiguous failure (lost response, receipt timeout, nonce already used): the op may have landed — check before failing.
      if (j.error && hash && j.error.code !== -32601 && AMBIGUOUS_RELAY.test(j.error.message)) {
        // the relay always reports the tx hash once it signed: ONE receipt read for it; log scan only without a hash
        const txh = (j.error.data as { txHash?: Hex } | undefined)?.txHash;
        const got = txh ? await this.receiptFor(txh, hash) : await this.findOp(hash, c.sender);
        if (got) j = { result: { kind: "confirmed", via: "rpc-wait", t: { simulate: 0, signTx: 0, send: 0, mined: 0, total: 0 }, receipt: { transactionHash: got.txHash, blockHash: "0x", blockNumber: "0x0", status: "0x1", gasUsed: "0x0", logs: got.logs }, ...got } };
      }
      if (j.error && c.gasMode === "usdg" && /AA3[0-9]|MaxCostTooLow|signature error/i.test(`${j.error.message} ${String(j.error.data ?? "")}`)) this.allowances?.invalidate(c.sender);
      if (j.error && c.feeRetry && TRANSIENT_SIM.test(`${j.error.message} ${j.error.data ?? ""}`)) {
        // the relay's pre-flight ran on a node that hasn't seen our previous op yet: nothing was sent; retry once
        await nextBlock();
        return this.sendCalls(await retryCalls(c.calls, c.opts), c.as, false, c.opts);
      }
      if (j.error?.code === -32601) this.syncOk = false;   // Alchemy (or old server): fall through to the standard flow
      else if (j.error && c.feeRetry && /fee below relayer floor/i.test(j.error.message)) {
        // cached fees went stale (base fee rose): nothing was sent; refresh fees and re-sign once
        FEES.invalidate();
        await FEES.get(() => fetchFees(c.feeClient)).catch(() => undefined);
        return this.sendCalls(c.calls, c.as, false, c.opts);
      } else if (j.error) {
        if (/AA2[0-9]|AA3[0-9]|out of gas|gas/i.test(j.error.message)) this.gas.drop(c.kind);   // stale limits → re-estimate next time
        // Never fall through to the standard path here: a second send of the same nonce can only fail (AA25) after the
        // first landed. Relay-side errors that aren't a pre-flight rejection are labelled as such, not "simulation failed".
        if (!/simulation|revert|AA[0-9]{2}/i.test(j.error.message)) {
          const line = j.error.message.split("\n")[0].slice(0, 200);
          // relay policy / paymaster / gas-cap rejections: plain copy, reason kept in `detail` (users never see gas wording)
          throw new AAError("Bundler", INFRA_WORDING.test(line) ? TRADING_UNAVAILABLE : `relay error: ${line}`, { userOpHash: hash, detail: line });
        }
        return c.fail(Object.assign(new Error(j.error.message), { data: j.error.data }));
      } else if (j.result) {
        this.syncOk = true;
        const { userOpHash, txHash, success, logs } = j.result;
        opPhase({ phase: "submitted", userOpHash, txHash });
        const timings: OpTimings = { build: Math.round(c.t1 - c.t0), sign: Math.round(c.t2 - c.t1), rpc: Math.round(t3 - c.t2), total: Math.round(t3 - c.t0), fast: true, server: j.result.t as Record<string, number> };
        if (!success) { this.gas.drop(c.kind); throw new AAError("Reverted", `UserOp reverted (tx ${txHash})`, { txHash, revertData: opRevertReason(logs, userOpHash) }); }
        opPhase({ phase: "confirmed", userOpHash, txHash, timings });
        this.deployed = true;
        return { userOpHash, txHash, gasMode: c.gasMode, receipt: { success: true, receipt: { transactionHash: txHash, logs } }, timings };
      }
      return null;
  }

  /** Standard eth_sendUserOperation for an already-signed op (USDG-gas ops on a bundler without the sync method). */
  private async sendRaw(wire: UserOp, hash: Hex, kind: string, t0: number, fail: (e: unknown) => Promise<never>, gasMode: GasMode): Promise<SendResult> {
    const r = await fetch(absUrl(this.o.bundlerUrl), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendUserOperation", params: [wire, ENTRYPOINT_V07] }) });
    const j = await r.json().catch(() => ({ error: { message: `send response unreadable (HTTP ${r.status})`, unreadable: true } })) as { result?: Hex; error?: { message: string; data?: string; unreadable?: boolean } };
    if (j.error) {
      if (/not confirmed|timeout/i.test(j.error.message)) throw new AAError("Timeout", "Trade sent — still confirming on-chain. Check your balance in a moment.");
      // unreadable response / relay policy (gas caps, paymaster deposit): plain copy; real reverts still decode via fail()
      if (j.error.unreadable || (!/simulation|revert|AA[0-9]{2}/i.test(j.error.message) && INFRA_WORDING.test(j.error.message)))
        throw new AAError("Bundler", TRADING_UNAVAILABLE, { userOpHash: hash, detail: j.error.message.split("\n")[0].slice(0, 300) });
      return fail(Object.assign(new Error(j.error.message), { data: j.error.data }));
    }
    opPhase({ phase: "submitted", userOpHash: hash });
    const got = await this.findOp(hash, wire.sender, 30_000);
    if (!got) throw new AAError("Timeout", "Trade sent — still confirming on-chain. Check your balance in a moment.", { userOpHash: hash });
    if (!got.success) { this.gas.drop(kind); throw new AAError("Reverted", `UserOp reverted (tx ${got.txHash})`, { txHash: got.txHash, revertData: opRevertReason(got.logs, hash) }); }
    const timings: OpTimings = { build: 0, sign: 0, rpc: Math.round(now() - t0), total: Math.round(now() - t0), fast: false };
    opPhase({ phase: "confirmed", userOpHash: hash, txHash: got.txHash, timings });
    this.deployed = true;
    return { userOpHash: hash, txHash: got.txHash, gasMode, receipt: { success: true, receipt: { transactionHash: got.txHash, logs: got.logs } }, timings };
  }
}
