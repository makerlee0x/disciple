import "server-only";
/** Read-only launch guard. Never funds, stakes, signs a bundle, or falls back to the old paymaster. */
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { robinhood, robinhoodTestnet, DEPLOYMENTS } from "../chains";
import { ENTRYPOINT_V07, MAV2_FACTORY } from "../aa/constants";
import { disciplePaymasterAbi } from "../aa/paymaster";
const epAbi = parseAbi(["function getDepositInfo(address) view returns ((uint256 deposit,bool staked,uint112 stake,uint32 unstakeDelaySec,uint48 withdrawTime))"]);
const clients = new Map<number, ReturnType<typeof createPublicClient>>();
function rpc(chainId: number) {
  let c = clients.get(chainId);
  if (!c) {
    const chain = chainId === 4663 ? robinhood : robinhoodTestnet;
    c = createPublicClient({ chain, transport: http(undefined, { timeout: 3000, retryCount: 1 }) });
    clients.set(chainId, c);
  }
  return c;
}
const verified = new Map<string, number>();
export function configuredPrepaidPaymaster(): Address | undefined {
  const a = process.env.PAYMASTER_ADDRESS || DEPLOYMENTS[46630].paymaster;
  return /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/i.test(a) ? a as Address : undefined;
}
export function requireStake(info: { staked: boolean; stake: bigint; unstakeDelaySec: number; withdrawTime: number }, minimum: bigint) {
  if (minimum <= BigInt(0) || !info.staked || info.stake < minimum || info.unstakeDelaySec < 86400 || info.withdrawTime !== 0) throw Error("external bundler requires active stake and >= 1 day delay");
}
export async function assertPrepaidReady(paymaster: Address, factory?: string, opts?: { chainId?: number; usdg?: Address }): Promise<void> {
  const raw = process.env.PAYMASTER_MIN_STAKE_WEI;
  // Owner-approved ~$5 starting stake is provisional: Alchemy publishes no Robinhood minimum.
  if (!raw || !/^\d+$/.test(raw) || BigInt(raw) <= BigInt(0)) throw Error("set owner-approved PAYMASTER_MIN_STAKE_WEI; Robinhood provider minimum is unconfirmed");
  const chainId = opts?.chainId ?? 46630;
  const pc = rpc(chainId);
  const key = `${chainId}|${paymaster.toLowerCase()}|${factory?.toLowerCase() || ""}|${raw}`;
  if (Date.now() - (verified.get(key) ?? 0) < 30_000) return;
  const [version, paused, usdg, entryPoint, stake, postOpGas] = await Promise.all([
    pc.readContract({ address: paymaster, abi: disciplePaymasterAbi, functionName: "PREPAY_VERSION" }),
    pc.readContract({ address: paymaster, abi: disciplePaymasterAbi, functionName: "paused" }),
    pc.readContract({ address: paymaster, abi: disciplePaymasterAbi, functionName: "usdg" }),
    pc.readContract({ address: paymaster, abi: parseAbi(["function entryPoint() view returns (address)"]), functionName: "entryPoint" }),
    pc.readContract({ address: ENTRYPOINT_V07, abi: epAbi, functionName: "getDepositInfo", args: [paymaster] }),
    pc.readContract({ address: paymaster, abi: disciplePaymasterAbi, functionName: "postOpGas" }),
  ]);
  const expected = (opts?.usdg ?? DEPLOYMENTS[chainId as 46630]?.usdg ?? DEPLOYMENTS[46630].usdg).toLowerCase();
  if (version !== BigInt(5) || postOpGas < BigInt(150_000) || paused || usdg.toLowerCase() !== expected || entryPoint.toLowerCase() !== ENTRYPOINT_V07.toLowerCase()) throw Error("hardened prepaid USDG paymaster unavailable");
  requireStake(stake, BigInt(raw));
  if (factory) {
    if (factory.toLowerCase() !== MAV2_FACTORY.toLowerCase()) throw Error("unsupported account factory");
    requireStake(await rpc(chainId).readContract({ address: ENTRYPOINT_V07, abi: epAbi, functionName: "getDepositInfo", args: [MAV2_FACTORY] }), BigInt(raw));
  }
  verified.set(key, Date.now());
}
