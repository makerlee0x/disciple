/**
 * Minimal ERC-4337 v0.7 LightAccount v2 client (port of FLOW's working smoke-anon-launch.mjs userOp flow).
 * Framework-agnostic so it runs in the browser and in node tests.
 *  - account: LightAccount v2 (factory 0x0000000000400CdFef5E2714E63d8040b700BC24), salt 0, EntryPoint v0.7.
 *  - every call list goes out as ONE userOp (execute for 1 call, executeBatch for n).
 *  - gas: try Alchemy gas manager policy (alchemy_requestGasAndPaymasterAndData); if sponsorship is
 *    unavailable ("Gas sponsorship is not enabled for this app", policy errors) fall back to self-pay.
 */
import {
  concat, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, pad, parseAbi,
  type Address, type Hex, type PublicClient,
} from "viem";

export const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
export const LIGHT_ACCOUNT_V2_FACTORY = "0x0000000000400CdFef5E2714E63d8040b700BC24" as Address;
export const DEFAULT_GAS_POLICY_ID = "d38ec347-5eb0-498f-ba1a-842ea308c332";

export const factoryAbi = parseAbi([
  "function createAccount(address owner, uint256 salt) returns (address)",
  "function getAddress(address owner, uint256 salt) view returns (address)",
]);
export const lightAccountAbi = parseAbi([
  "function execute(address dest, uint256 value, bytes func)",
  "function executeBatch(address[] dest, uint256[] value, bytes[] func)",
]);
const epAbi = parseAbi(["function getNonce(address sender, uint192 key) view returns (uint256)"]);

export type Call = { to: Address; data: Hex; value?: bigint };
/** Anything that can sign a raw 32-byte hash as an EIP-191 personal message (viem LocalAccount, Alchemy signer, EOA). */
export type OwnerSigner = { address: Address; signMessage(a: { message: { raw: Hex } }): Promise<Hex> };

export type UserOp = {
  sender: Address; nonce: Hex; callData: Hex; factory?: Address; factoryData?: Hex;
  callGasLimit?: Hex; verificationGasLimit?: Hex; preVerificationGas?: Hex;
  maxFeePerGas?: Hex; maxPriorityFeePerGas?: Hex;
  paymaster?: Address; paymasterVerificationGasLimit?: Hex; paymasterPostOpGasLimit?: Hex; paymasterData?: Hex;
  signature: Hex;
};
export type UserOpReceipt = { success: boolean; actualGasCost?: Hex; paymaster?: Address; receipt: { transactionHash: Hex; logs: { address: Address; data: Hex; topics: Hex[] }[] } };

export type GasMode = "sponsored" | "self-pay";
export class AAError extends Error {
  constructor(public code: "FundAccount" | "Bundler" | "Timeout" | "Policy" | "Reverted", msg: string, public extra?: Record<string, unknown>) { super(msg); }
}

/** Bundler/paymaster transport. Default is JSON-RPC to Alchemy; tests can inject a local EntryPoint.handleOps bundler. */
export interface Bundler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc(method: string, params: unknown[]): Promise<any>;
}
export function alchemyBundler(url: string): Bundler {
  return {
    async rpc(method, params) {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      const j = await r.json();
      if (j.error) throw new AAError("Bundler", `${method}: ${j.error.message || JSON.stringify(j.error)}`, { rpcError: j.error });
      return j.result;
    },
  };
}

/** Alchemy errors that mean "no sponsorship available, self-pay instead". */
export function isSponsorshipUnavailable(e: unknown) {
  const m = ((e as Error)?.message || String(e)).toLowerCase();
  return /sponsorship is not enabled|not enabled for this app|policy|paymaster|sponsor|rejected by|exceeds.*limit|unauthorized|forbidden/.test(m);
}

const packUint = (hi: Hex | bigint, lo: Hex | bigint) => pad(numberToHex((BigInt(hi) << BigInt(128)) | BigInt(lo)), { size: 32 });
export function userOpHash(op: UserOp, chainId: number, ep: Address = ENTRYPOINT_V07): Hex {
  const initCode = op.factory ? concat([op.factory, op.factoryData!]) : "0x";
  const pmd = op.paymaster
    ? concat([op.paymaster, pad(op.paymasterVerificationGasLimit!, { size: 16 }), pad(op.paymasterPostOpGasLimit!, { size: 16 }), op.paymasterData || "0x"])
    : "0x";
  const inner = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }],
    [op.sender, BigInt(op.nonce), keccak256(initCode), keccak256(op.callData), packUint(op.verificationGasLimit!, op.callGasLimit!), BigInt(op.preVerificationGas!), packUint(op.maxPriorityFeePerGas!, op.maxFeePerGas!), keccak256(pmd)]));
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "uint256" }], [inner, ep, BigInt(chainId)]));
}

/** LightAccount v2 signature = 0x00 (EOA sig type) ‖ 65-byte personal_sign over the userOp hash. */
const DUMMY_SIG = ("0x00" + "f".repeat(31) + "0".repeat(33) + "7" + "a".repeat(63) + "1c") as Hex;

export function encodeCalls(calls: Call[]): Hex {
  if (calls.length === 1) {
    const c = calls[0];
    return encodeFunctionData({ abi: lightAccountAbi, functionName: "execute", args: [c.to, c.value ?? BigInt(0), c.data] });
  }
  return encodeFunctionData({
    abi: lightAccountAbi, functionName: "executeBatch",
    args: [calls.map((c) => c.to), calls.map((c) => c.value ?? BigInt(0)), calls.map((c) => c.data)],
  });
}

export interface SmartAccountOpts {
  pc: PublicClient; chainId: number; bundler: Bundler; owner: OwnerSigner;
  policyId?: string; salt?: bigint; ep?: Address; factory?: Address;
  /** Try the gas policy first (flag NEXT_PUBLIC_AA_SPONSOR=1). Default false ⇒ self-pay. */
  sponsor?: boolean;
  /** Remember that sponsorship is off so we don't retry it on every trade. */
  onGasMode?: (m: GasMode, reason?: string) => void;
}

export class LightSmartAccount {
  private addr?: Address;
  gasMode: GasMode | "unknown" = "unknown";
  constructor(private o: SmartAccountOpts) {}
  get ep() { return this.o.ep ?? ENTRYPOINT_V07; }
  get factory() { return this.o.factory ?? LIGHT_ACCOUNT_V2_FACTORY; }
  get salt() { return this.o.salt ?? BigInt(0); }

  async address(): Promise<Address> {
    if (!this.addr) this.addr = await this.o.pc.readContract({ address: this.factory, abi: factoryAbi, functionName: "getAddress", args: [this.o.owner.address, this.salt] });
    return this.addr;
  }

  async buildUserOp(calls: Call[]): Promise<UserOp> {
    const { pc } = this.o;
    const sender = await this.address();
    const [code, nonce] = await Promise.all([
      pc.getCode({ address: sender }),
      pc.readContract({ address: this.ep, abi: epAbi, functionName: "getNonce", args: [sender, BigInt(0)] }),
    ]);
    const op: UserOp = { sender, nonce: numberToHex(nonce), callData: encodeCalls(calls), signature: DUMMY_SIG };
    if (!code || code === "0x") {
      op.factory = this.factory;
      op.factoryData = encodeFunctionData({ abi: factoryAbi, functionName: "createAccount", args: [this.o.owner.address, this.salt] });
    }
    return op;
  }

  private async sponsor(op: UserOp) {
    const res = await this.o.bundler.rpc("alchemy_requestGasAndPaymasterAndData", [
      { policyId: this.o.policyId ?? DEFAULT_GAS_POLICY_ID, entryPoint: this.ep, dummySignature: DUMMY_SIG, userOperation: op },
    ]);
    Object.assign(op, res);
  }

  private async selfPayGas(op: UserOp) {
    const { pc, bundler } = this.o;
    const blk = await pc.getBlock();
    let prio: bigint;
    try { prio = BigInt(await bundler.rpc("rundler_maxPriorityFeePerGas", [])); } catch { prio = BigInt(0); }
    op.maxPriorityFeePerGas = numberToHex(prio);
    op.maxFeePerGas = numberToHex((blk.baseFeePerGas ?? BigInt(0)) * BigInt(2) + prio);
    const est = await bundler.rpc("eth_estimateUserOperationGas", [op, this.ep]);
    op.callGasLimit = numberToHex(BigInt(est.callGasLimit) * BigInt(12) / BigInt(10));
    op.verificationGasLimit = est.verificationGasLimit;
    op.preVerificationGas = numberToHex(BigInt(est.preVerificationGas) * BigInt(12) / BigInt(10));
    const need = (BigInt(op.callGasLimit) + BigInt(op.verificationGasLimit!) + BigInt(op.preVerificationGas)) * BigInt(op.maxFeePerGas);
    const have = await pc.getBalance({ address: op.sender });
    if (have < need) throw new AAError("FundAccount", "Gas sponsorship is off — fund your account with test ETH to pay gas.", { need, have, address: op.sender });
  }

  /** Send calls as ONE userOp. Owner signs once per op (session/embedded signer ⇒ no popup). */
  async sendCalls(calls: Call[]): Promise<{ userOpHash: Hex; txHash: Hex; receipt: UserOpReceipt; gasMode: GasMode }> {
    const op = await this.buildUserOp(calls);
    let mode: GasMode = this.o.sponsor && this.gasMode !== "self-pay" ? "sponsored" : "self-pay";
    if (mode === "sponsored") {
      try { await this.sponsor(op); }
      catch (e) {
        if (!isSponsorshipUnavailable(e) && !(e instanceof AAError && e.code === "Bundler")) throw e;
        mode = "self-pay";
        this.gasMode = "self-pay";
        this.o.onGasMode?.("self-pay", (e as Error).message);
        for (const k of ["paymaster", "paymasterData", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"] as const) delete op[k];
      }
    }
    if (mode === "self-pay") await this.selfPayGas(op);
    else { this.gasMode = "sponsored"; this.o.onGasMode?.("sponsored"); }

    const sig = await this.o.owner.signMessage({ message: { raw: userOpHash(op, this.o.chainId, this.ep) } });
    op.signature = concat(["0x00", sig]);
    const uoh: Hex = await this.o.bundler.rpc("eth_sendUserOperation", [op, this.ep]);
    // ~30s: self-bundler already waited on the relayer receipt; long polls only mask dropped ops.
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, i < 5 ? 400 : 1200));
      const rc: UserOpReceipt | null = await this.o.bundler.rpc("eth_getUserOperationReceipt", [uoh]);
      if (rc) {
        if (!rc.success) throw new AAError("Reverted", `UserOp reverted (tx ${rc.receipt.transactionHash})`, { rc });
        return { userOpHash: uoh, txHash: rc.receipt.transactionHash, receipt: rc, gasMode: mode };
      }
    }
    throw new AAError("Timeout", `UserOp ${uoh} not mined yet`);
  }
}
