/**
 * Alchemy Modular Account v2 (SemiModularAccountBytecode, EntryPoint v0.7) via aa-sdk — replaces the LightAccount v2
 * flow in core.ts for embedded users. MAv2 signatures carry a validation-selection prefix, so we never hand-roll them.
 *  - owner = Privy embedded EOA (fallback signer, global validation): account creation, session install/revoke, mints.
 *  - session key = browser-held key, SingleSigner entity (non-global, execute/executeBatch) + DiscipleSessionPolicy hooks.
 *  - gas: self-pay only (no paymaster / gas policy). Bundler goes through /api/bundler.
 */
import { createModularAccountV2Client } from "@account-kit/smart-contracts";
import { LocalAccountSigner, split, type ClientMiddlewareFn, type SmartAccountSigner } from "@aa-sdk/core";
import { http, type Address, type Chain, type Hex, type LocalAccount, type PublicClient } from "viem";
import { MAV2_FACTORY } from "./constants";
import { AAError, type Call, type GasMode, type OwnerSigner, type UserOpReceipt } from "./core";

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
export const rundlerFeeEstimator: ClientMiddlewareFn = async (struct, { client }) => {
  const c = client as unknown as { request: (a: { method: string; params?: unknown[] }) => Promise<Hex>; estimateFeesPerGas: () => Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> };
  const fees = await c.estimateFeesPerGas();
  const tip = (BigInt(await c.request({ method: "rundler_maxPriorityFeePerGas", params: [] })) * BigInt(110)) / BigInt(100);
  const base = (fees.maxFeePerGas ?? BigInt(0)) - (fees.maxPriorityFeePerGas ?? BigInt(0));
  struct.maxPriorityFeePerGas = tip;
  struct.maxFeePerGas = base + tip;
  return struct;
};

export const asSigner = (a: LocalAccount): SmartAccountSigner => new LocalAccountSigner(a);

export type Mav2Opts = { chain: Chain; pc: PublicClient; bundlerUrl: string; salt?: bigint };
export type SendResult = { userOpHash: Hex; txHash: Hex; receipt: UserOpReceipt; gasMode: GasMode };

function absUrl(u: string) {
  return /^https?:/.test(u) ? u : new URL(u, typeof location !== "undefined" ? location.origin : "http://localhost:3000").toString();
}

export class Mav2Account {
  gasMode: GasMode | "unknown" = "self-pay";
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
      feeEstimator: rundlerFeeEstimator,
      chain: this.o.chain, transport: this.transport(), signer: asSigner(this.owner),
      salt: this.o.salt ?? BigInt(0), factoryAddress: MAV2_FACTORY,
    }));
  }
  /** Session-key client on the same account (validation = SingleSigner entityId, non-global). */
  async useSession(entityId: number, key: LocalAccount) {
    const account = await this.address();
    this.sessionClient = {
      entityId,
      c: createModularAccountV2Client({
      feeEstimator: rundlerFeeEstimator,
        chain: this.o.chain, transport: this.transport(), signer: asSigner(key), accountAddress: account,
        signerEntity: { entityId, isGlobalValidation: false },
      }),
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

  /** Send calls as ONE userOp. `as: "session"` signs with the session key (no Privy prompt); default owner. */
  async sendCalls(calls: Call[], as: "owner" | "session" = "owner"): Promise<SendResult> {
    const client = as === "session" && this.sessionClient ? await this.sessionClient.c : await this.owned();
    const uo = calls.map((c) => ({ target: c.to, data: c.data, value: c.value ?? BigInt(0) }));
    const sender: Address = client.account.address;
    let req;
    try { req = await client.sendUserOperation({ uo: uo.length === 1 ? uo[0] : uo }); }
    catch (e) {
      const m = (e as { details?: string; shortMessage?: string; message?: string });
      const msg = String(m.details || m.shortMessage || m.message || e);
      if (/insufficient|prefund|AA21|didn't pay/i.test(msg)) {
        const have = await this.o.pc.getBalance({ address: sender });
        throw new AAError("FundAccount", "Fund your account with test ETH to pay gas.", { have, address: sender });
      }
      // keep the revert payload (e.g. PreExecHookReverted(module, reason)) so callers/tests can decode the policy error
      let revertData: string | undefined;
      (e as { walk?: (f: (x: unknown) => boolean) => unknown }).walk?.((x) => { const dd = (x as { data?: unknown }).data; if (typeof dd === "string" && /^0x[0-9a-fA-F]{8,}$/.test(dd)) { revertData = dd; return true; } return false; });
      throw new AAError("Estimate", `trade simulation failed: ${msg.split("\n")[0].slice(0, 200)}`, { revertData });
    }
    let txHash: Hex;
    try { txHash = await client.waitForUserOperationTransaction({ hash: req.hash, retries: { maxRetries: 25, intervalMs: 1200, multiplier: 1 } }); }
    catch { throw new AAError("Timeout", `UserOp ${req.hash} not mined yet`); }
    const rc = (await client.getUserOperationReceipt(req.hash)) as unknown as {
      success: boolean; actualGasCost?: bigint | Hex; receipt: { transactionHash: Hex; logs: { address: Address; data: Hex; topics: Hex[] }[] };
    } | null;
    if (rc && !rc.success) throw new AAError("Reverted", `UserOp reverted (tx ${txHash})`, { rc });
    const logs = rc?.receipt.logs?.map((l) => ({ address: l.address, data: l.data, topics: l.topics })) ??
      (await this.o.pc.getTransactionReceipt({ hash: txHash })).logs.map((l) => ({ address: l.address, data: l.data, topics: l.topics as Hex[] }));
    return { userOpHash: req.hash, txHash, gasMode: "self-pay", receipt: { success: true, receipt: { transactionHash: txHash, logs } } };
  }
}
