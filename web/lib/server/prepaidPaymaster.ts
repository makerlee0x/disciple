import "server-only";
/** Read-only launch guard. Never funds, stakes, signs a bundle, or falls back to the old paymaster. */
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { robinhoodTestnet, DEPLOYMENTS } from "../chains";
import { ENTRYPOINT_V07, MAV2_FACTORY } from "../aa/constants";
import { disciplePaymasterAbi } from "../aa/paymaster";
const epAbi = parseAbi(["function getDepositInfo(address) view returns ((uint256 deposit,bool staked,uint112 stake,uint32 unstakeDelaySec,uint48 withdrawTime))"]);
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http(undefined, { timeout: 3000, retryCount: 1 }) });
const verified = new Map<string, number>();
export function configuredPrepaidPaymaster(): Address | undefined {
  const a = process.env.PAYMASTER_ADDRESS || DEPLOYMENTS[46630].paymaster;
  return /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/i.test(a) ? a as Address : undefined;
}
export function requireStake(info: { staked: boolean; stake: bigint; unstakeDelaySec: number; withdrawTime: number }, minimum: bigint) {
  if (minimum <= BigInt(0) || !info.staked || info.stake < minimum || info.unstakeDelaySec < 86400 || info.withdrawTime !== 0) throw Error("external bundler requires active stake and >= 1 day delay");
}
export async function assertPrepaidReady(paymaster: Address, factory?: string): Promise<void> {
  const raw = process.env.PAYMASTER_MIN_STAKE_WEI;
  // Owner-approved ~$5 starting stake is provisional: Alchemy publishes no Robinhood minimum.
  if (!raw || !/^\d+$/.test(raw) || BigInt(raw) <= BigInt(0)) throw Error("set owner-approved PAYMASTER_MIN_STAKE_WEI; Robinhood provider minimum is unconfirmed");
  const key = `${paymaster.toLowerCase()}|${factory?.toLowerCase() || ""}|${raw}`;
  if (Date.now() - (verified.get(key) ?? 0) < 30_000) return;
  const [version, paused, usdg, entryPoint, stake, postOpGas] = await Promise.all([
    pc.readContract({ address: paymaster, abi: disciplePaymasterAbi, functionName: "PREPAY_VERSION" }),
    pc.readContract({ address: paymaster, abi: disciplePaymasterAbi, functionName: "paused" }),
    pc.readContract({ address: paymaster, abi: disciplePaymasterAbi, functionName: "usdg" }),
    pc.readContract({ address: paymaster, abi: parseAbi(["function entryPoint() view returns (address)"]), functionName: "entryPoint" }),
    pc.readContract({ address: ENTRYPOINT_V07, abi: epAbi, functionName: "getDepositInfo", args: [paymaster] }),
    pc.readContract({ address: paymaster, abi: disciplePaymasterAbi, functionName: "postOpGas" }),
  ]);
  if (version !== BigInt(4) || postOpGas < BigInt(79_684) || paused || usdg.toLowerCase() !== DEPLOYMENTS[46630].usdg.toLowerCase() || entryPoint.toLowerCase() !== ENTRYPOINT_V07.toLowerCase()) throw Error("hardened prepaid USDG paymaster unavailable");
  requireStake(stake, BigInt(raw));
  if (factory) {
    if (factory.toLowerCase() !== MAV2_FACTORY.toLowerCase()) throw Error("unsupported account factory");
    requireStake(await pc.readContract({ address: ENTRYPOINT_V07, abi: epAbi, functionName: "getDepositInfo", args: [MAV2_FACTORY] }), BigInt(raw));
  }
  verified.set(key, Date.now());
}
