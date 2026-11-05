/** Audit F-02. Sender balance/history is NEVER authorization for a submitted operation.
 * Both paths require exact handleOps simulation immediately before signing, plus a known account template.
 * No operation-hash cache bypass: even an identical signed op can become invalid after a nonce, funding or
 * validation-config change. RPC/unknown results fail closed. Pure/injectable for RPC-free regressions.
 */
import { parseAbi, type Address, type Hex } from "viem";
import type { UserOp } from "../aa/core";
import { LIGHT_ACCOUNT_V2_FACTORY, MAV2_FACTORY } from "../aa/constants";

export const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
// Solady ERC-1967 runtime used by the supported factories. MAv2 SMA appends a 20-byte immutable owner.
// Account Kit's ma-v2/account/predictAddress.ts constructs this exact runtime (61 bytes + SMA owner).
export const ACCOUNT_PROXY_RUNTIME = "0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3" as Hex;
const implAbi = parseAbi([
  "function SEMI_MODULAR_ACCOUNT_IMPL() view returns (address)",
  "function ACCOUNT_IMPLEMENTATION() view returns (address)",
]);
export type RelayAuthReads = {
  getCode(a: { address: Address; blockTag: "pending" }): Promise<Hex | undefined>;
  getStorageAt(a: { address: Address; slot: Hex; blockTag: "pending" }): Promise<Hex | undefined>;
  readContract(a: { address: Address; abi: typeof implAbi; functionName: "SEMI_MODULAR_ACCOUNT_IMPL" | "ACCOUNT_IMPLEMENTATION"; blockTag: "pending" }): Promise<Address>;
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Factory implementation getters are immutable configuration, NOT sender/operation authorization. Warm these
// off the tap path, then fetch current account runtime + implementation slot concurrently on EVERY send.
const implementations = new WeakMap<RelayAuthReads, Map<string, Promise<Address>>>();
function expectedImplementation(pc: RelayAuthReads, sma: boolean): Promise<Address> {
  let cache = implementations.get(pc);
  if (!cache) { cache = new Map(); implementations.set(pc, cache); }
  const key = sma ? "sma" : "light";
  let value = cache.get(key);
  if (!value) {
    value = pc.readContract({ address: sma ? MAV2_FACTORY : LIGHT_ACCOUNT_V2_FACTORY, abi: implAbi,
      functionName: sma ? "SEMI_MODULAR_ACCOUNT_IMPL" : "ACCOUNT_IMPLEMENTATION", blockTag: "pending" })
      .then((address) => {
        if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) throw new Error("relay authorization: missing factory implementation");
        return address;
      }).catch((e) => { cache!.delete(key); throw e; });
    cache.set(key, value);
  }
  return value;
}
export async function warmRelayAccountTemplates(pc: RelayAuthReads): Promise<void> {
  // A missing legacy factory must not disable a supported MAv2 template; its actual use still fails closed.
  await Promise.allSettled([expectedImplementation(pc, true), expectedImplementation(pc, false)]);
}

export async function checkRelayAccount(op: UserOp, pc: RelayAuthReads): Promise<void> {
  const [code, slot] = await Promise.all([
    pc.getCode({ address: op.sender, blockTag: "pending" }),
    pc.getStorageAt({ address: op.sender, slot: IMPLEMENTATION_SLOT, blockTag: "pending" }),
  ]);
  if (!code || code === "0x") {
    // A counterfactual account is authorized only through a supported factory AND a successful exact handleOps.
    if (!op.factory || (![MAV2_FACTORY, LIGHT_ACCOUNT_V2_FACTORY].some((f) => same(f, op.factory!)))) {
      throw new Error("relay authorization: undeployed account or unsupported factory");
    }
    return;
  }
  if (op.factory) throw new Error("relay authorization: deployed account cannot include a factory");
  const runtime = code.toLowerCase(), template = ACCOUNT_PROXY_RUNTIME.toLowerCase();
  const sma = runtime.startsWith(template) && runtime.length === template.length + 40;
  const light = runtime === template;
  if (!sma && !light) throw new Error("relay authorization: unsupported account runtime");
  const expected = await expectedImplementation(pc, sma);
  if (!slot || !/^0x[0-9a-fA-F]{64}$/.test(slot) || !/^0x0{24}/i.test(slot)
    || !/^0x[0-9a-fA-F]{40}$/.test(expected) || /^0x0{40}$/i.test(expected)
    || !same(`0x${slot.slice(26)}`, expected)) {
    throw new Error("relay authorization: unrecognized current account implementation");
  }
}

/** `simulate` MUST call the real EntryPoint.handleOps with this exact packed op (including signature), beneficiary
 * and relayer as caller. It verifies current signature/modules, nonce and prefund, not just sender identity.
 * The caller may sign/broadcast only after this resolves. All reads and simulation run concurrently.
 */
export async function authorizeRelayOperation(op: UserOp, pc: RelayAuthReads, simulate: () => Promise<unknown>): Promise<void> {
  await Promise.all([checkRelayAccount(op, pc), simulate()]);
}
