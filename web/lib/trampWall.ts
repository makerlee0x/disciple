/** Tramps (quote-side range) / walls (token-side range) on graduated rockets, via the active wallet (one userOp in smart mode). */
import { encodeFunctionData, type Address } from "viem";
import { tokenAbi, trampWallManagerAbi } from "./abi";
import { deployment } from "./chains";
import { publicClient } from "./protocol-viem";
import { activeAddress, execCalls, isSmartMode } from "./wallet";
import type { Call } from "./aa/core";
import { maxUint256 } from "viem";

const twm = () => deployment().trampWallManager;
async function approve(me: Address, erc20: Address, amt: bigint): Promise<Call[]> {
  const cur = await publicClient().readContract({ address: erc20, abi: tokenAbi, functionName: "allowance", args: [me, twm()] });
  return cur >= amt ? [] : [{ to: erc20, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [twm(), isSmartMode() ? amt : maxUint256] }) }];
}
const dl = () => BigInt(Math.floor(Date.now() / 1000) + 300);

export async function placeTramp(token: Address, quote: Address, tickLower: number, tickUpper: number, quoteAmt: bigint, minLiquidity = BigInt(0)) {
  const me = await activeAddress();
  return execCalls([...(await approve(me, quote, quoteAmt)),
    { to: twm(), data: encodeFunctionData({ abi: trampWallManagerAbi, functionName: "placeTramp", args: [token, tickLower, tickUpper, quoteAmt, minLiquidity, dl()] }) }]);
}
export async function placeWall(token: Address, tickLower: number, tickUpper: number, tokenAmt: bigint, minLiquidity = BigInt(0)) {
  const me = await activeAddress();
  return execCalls([...(await approve(me, token, tokenAmt)),
    { to: twm(), data: encodeFunctionData({ abi: trampWallManagerAbi, functionName: "placeWall", args: [token, tickLower, tickUpper, tokenAmt, minLiquidity, dl()] }) }]);
}
export const cancelTrampWall = (id: bigint) =>
  execCalls([{ to: twm(), data: encodeFunctionData({ abi: trampWallManagerAbi, functionName: "cancel", args: [id] }) }]);
