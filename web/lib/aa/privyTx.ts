/**
 * Privy embedded-wallet transaction signing format.
 *
 * viem prepares a transaction with a STRING type ("eip1559") and hands it to account.signTransaction. Privy's
 * toViemAccount forwards that object unchanged to its provider's eth_signTransaction, and for these wallets the SDK copies
 * `type` as-is into the wallet RPC body (POST /api/v1/wallets/{id}/rpc). Privy's wallet RPC only accepts the numeric
 * EIP-2718 type (0, 1, 2, 4; 118 = Tempo), so the string is rejected with a 400 and nothing is signed or sent.
 *
 * Fix (same as Privy's own send path): map viem's string type to the EIP-2718 number before Privy sees it — the same
 * table as @privy-io/ethereum STRING_TO_NUMBER_TXN_TYPE. Every other field is passed through untouched (Privy's SDK
 * already maps camelCase → snake_case and bigint → hex), so the on-chain tx is the same ordinary EIP-1559 tx: same
 * to, data, value, gas, fees and nonce.
 *
 * Apply ONLY to the Privy account. A viem local key account (privateKeyToAccount) must keep viem's string type.
 */
import type { LocalAccount } from "viem";

export const PRIVY_TX_TYPE = { legacy: 0, eip2930: 1, eip1559: 2, eip4844: 3, eip7702: 4 } as const;

/** viem transaction request → the shape Privy's eth_signTransaction accepts (numeric type). Other fields unchanged. */
export function toPrivyTxRequest<T extends { type?: unknown }>(tx: T): Omit<T, "type"> & { type?: unknown } {
  const t = tx.type;
  if (typeof t === "string" && Object.prototype.hasOwnProperty.call(PRIVY_TX_TYPE, t)) {
    return { ...tx, type: PRIVY_TX_TYPE[t as keyof typeof PRIVY_TX_TYPE] };
  }
  return tx;
}

/** Wrap Privy's toViemAccount result so signTransaction sends the numeric type. sign / signMessage / signTypedData unchanged. */
export function withPrivyTxType(account: LocalAccount): LocalAccount {
  const sign = account.signTransaction.bind(account);
  return {
    ...account,
    signTransaction: ((tx: Parameters<LocalAccount["signTransaction"]>[0], opts?: Parameters<LocalAccount["signTransaction"]>[1]) =>
      sign(toPrivyTxRequest(tx) as never, opts)) as LocalAccount["signTransaction"],
  };
}
