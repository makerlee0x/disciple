/**
 * Per-chain private RPC endpoints for the relayer (server only). The sequencer send URL and the fast receipt node belong to
 * ONE chain, so each chain reads its own variables: testnet (46630) RHT_SEQUENCER_URL / RHT_RECEIPT_RPC_URL, mainnet (4663)
 * RH_SEQUENCER_URL / RH_RECEIPT_RPC_URL. A mainnet build never picks up the testnet ones (they would send mainnet txs to the
 * testnet sequencer and wait on receipts that never come). Anything else (anvil) gets none.
 */
import { ACTIVE_CHAIN } from "../chains";

type Env = Record<string, string | undefined>;
const PREFIX: Record<number, string> = { 46630: "RHT", 4663: "RH" };
const url = (v: string | undefined) => (/^https?:\/\//.test(v || "") ? v : undefined);

export function sequencerUrl(env: Env = process.env, chainId: number = ACTIVE_CHAIN.id): string | undefined {
  const p = PREFIX[chainId];
  return p ? url(env[`${p}_SEQUENCER_URL`]) : undefined;
}
export function receiptRpcUrl(env: Env = process.env, chainId: number = ACTIVE_CHAIN.id): string | undefined {
  const p = PREFIX[chainId];
  return p ? url(env[`${p}_RECEIPT_RPC_URL`]) : undefined;
}
