/** Share the wallet's native-ETH/self-paid gas policy; never reserve USDG for sponsorship. */
export { gasReservePerOp, peekGasReservePerOp, type GasOpKind } from "@/lib/wallet";
/** Compatibility with the cash poll: no paymaster gas-price warm-up is needed. */
export function warmGasPrice(_pc: { getGasPrice: () => Promise<bigint> }): Promise<void> {
  return Promise.resolve();
}
