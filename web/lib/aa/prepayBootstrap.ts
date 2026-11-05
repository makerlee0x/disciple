/** MAv2's native, owner-authorized deferred action runs in account validation, BEFORE paymaster validation.
 * It is not an execution-batch approval and needs neither native ETH nor USDG permit/1271 support. */
import { concatHex, encodeFunctionData, encodePacked, maxUint256, parseAbi, size, toHex, type Address, type Hex } from "viem";
import type { UserOp } from "./core";
const exec = parseAbi(["function execute(address,uint256,bytes)"]);
const erc20 = parseAbi(["function approve(address,uint256)"]);
export function prepayApprovalCall(usdg: Address, paymaster: Address): Hex {
  return encodeFunctionData({ abi: exec, functionName: "execute", args: [usdg, BigInt(0), encodeFunctionData({ abi: erc20, functionName: "approve", args: [paymaster, maxUint256] })] });
}
export async function prepayBootstrap(o: {
  account: Address; chainId: number; nonce: bigint; deadline: number; usdg: Address; paymaster: Address;
  sign: (data: { domain: { chainId: number; verifyingContract: Address }; types: { DeferredAction: readonly [{ readonly name: "nonce"; readonly type: "uint256" }, { readonly name: "deadline"; readonly type: "uint48" }, { readonly name: "call"; readonly type: "bytes" }] }; primaryType: "DeferredAction"; message: { nonce: bigint; deadline: number; call: Hex } }) => Promise<Hex>;
}): Promise<{ deferredAction: Hex; nonce: bigint }> {
  const nonce = o.nonce | (BigInt(2) << BigInt(64)); // owner/global nonce, with the native deferred-action bit
  if (((nonce >> BigInt(64)) & BigInt(0xffffffffff)) !== BigInt(3)) throw Error("prepay bootstrap requires owner/global validation");
  const call = prepayApprovalCall(o.usdg, o.paymaster);
  const typed = { domain: { chainId: o.chainId, verifyingContract: o.account }, types: { DeferredAction: [{ name: "nonce", type: "uint256" }, { name: "deadline", type: "uint48" }, { name: "call", type: "bytes" }] as const }, primaryType: "DeferredAction" as const, message: { nonce, deadline: o.deadline, call } };
  const auth = concatHex(["0x00", await o.sign(typed)]); // native SMA EOA signature type
  const encoded = encodePacked(["uint168", "uint48", "bytes"], [BigInt(1), o.deadline, call]);
  // Account Kit deferredAction format: hooks flag + nonce + length-prefixed deferred calldata + owner authorization.
  const deferredAction = concatHex(["0x00", toHex(nonce, { size: 32 }), toHex(size(encoded), { size: 4 }), encoded, toHex(size(auth), { size: 4 }), auth]);
  return { deferredAction, nonce };
}
/** Quote-service shape check only. The REAL account verifies the owner signature, chain/account domain,
 * nonce and deadline in validation. Even a forged shape cannot bypass the paymaster's actual token precharge. */
export function hasDeferredPrepayApproval(op: UserOp, usdg: Address, paymaster: Address): boolean {
  try {
    if (((BigInt(op.nonce ?? "0x0") >> BigInt(64)) & BigInt(0xffffffffff)) !== BigInt(3)) return false;
    const sig = op.signature ?? "0x";
    const len = Number(BigInt(`0x${sig.slice(2, 10)}`));
    const data = `0x${sig.slice(10, 10 + len * 2)}` as Hex;
    if (data.slice(2, 44) !== "1".padStart(42, "0")) return false;
    const call = `0x${data.slice(56)}`; // uint168 locator + uint48 deadline
    return call.toLowerCase() === prepayApprovalCall(usdg, paymaster).toLowerCase() && sig.length >= 10 + len * 2 + 8 + 132;
  } catch { return false; }
}
