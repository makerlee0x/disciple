/**
 * Wire contract of the trade relay (POST /api/bundler, method disciple_sendUserOperationSync). Single source of truth
 * for the server (lib/server/fastRelay, app/api/bundler) and every client (lib/aa/mav2 → lib/wallet.execCalls →
 * lib/flight/tradeSpeed.noteReceipt). Pure types + tiny helpers, no imports beyond viem's Hex.
 *
 * PRIMARY PATH: the relay sends handleOps with eth_sendRawTransactionSync (sequencer endpoint when RHT_SEQUENCER_URL
 * is set) and answers the SAME request with a RelayConfirmed carrying the FULL receipt incl. logs. The client never
 * polls.
 *
 * SLOW PATH (sync send timed out / errored after the tx was signed): the relay still knows txHash (it signed the tx).
 *   - Streaming clients (request header `accept: application/x-ndjson`, RELAY_STREAM_ACCEPT) get NDJSON on the same
 *     response: first a RelayPending line (txHash, pending: true), then — pushed by the server as soon as the receipt
 *     exists — a RelayConfirmed line (or a RelayFailed line). Exactly one terminal line (confirmed | error) ends it.
 *   - Plain JSON clients (no accept header) get one JSON-RPC envelope: result = RelayConfirmed (the server waited for
 *     the receipt), or error = { code, message, data: RelayErrorData } (txHash included whenever it is known).
 */
import type { Hex } from "viem";

export const RELAY_METHOD = "disciple_sendUserOperationSync";
/** Request header value that selects the NDJSON stream (server push of the receipt on the slow path). */
export const RELAY_STREAM_ACCEPT = "application/x-ndjson";

/** One log, as in eth_getTransactionReceipt (hex quantities). */
export type RelayLog = {
  address: Hex;
  topics: Hex[];
  data: Hex;
  logIndex?: Hex;
  blockNumber?: Hex;
  transactionHash?: Hex;
};

/** The relayer tx's FULL receipt (EIP-7966 / eth_getTransactionReceipt shape, hex quantities). */
export type RelayReceipt = {
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: Hex;
  /** "0x1" handleOps succeeded (the userOp itself may still have reverted: see RelayConfirmed.success) */
  status: Hex;
  gasUsed: Hex;
  effectiveGasPrice?: Hex;
  logs: RelayLog[];
};

/** How the receipt was obtained. */
export type RelayVia =
  | "sequencer-sync" // eth_sendRawTransactionSync on RHT_SEQUENCER_URL (fastest)
  | "rpc-sync"       // eth_sendRawTransactionSync on the public RPC (RHT_SEQUENCER_URL unset, or sequencer error)
  | "rpc-wait";      // sync timed out / unsupported: server waited for the receipt (pushed after a RelayPending)

/** Server-side stage timings (ms). */
export type RelayTimings = { simulate: number; signTx: number; send: number; mined: number; total: number; [k: string]: number };

export type RelayConfirmed = {
  kind: "confirmed";
  userOpHash: Hex;
  txHash: Hex;
  /** UserOperationEvent.success for this userOpHash (false ⇒ the op's calls reverted; decode UserOperationRevertReason from logs) */
  success: boolean;
  receipt: RelayReceipt;
  /** = receipt.logs (kept flat for older clients that read result.logs) */
  logs: RelayLog[];
  via: RelayVia;
  t: RelayTimings;
};

export type RelayPending = {
  kind: "pending";
  pending: true;
  userOpHash: Hex;
  txHash: Hex;
  /** why the receipt didn't come with the send */
  reason: "sync-timeout" | "sync-error" | "sync-unsupported";
};

export type RelayErrorData = {
  /** known whenever the relayer tx was signed (even if the send failed or timed out) */
  txHash?: Hex;
  userOpHash?: Hex;
  /** revert payload (FailedOp / FailedOpWithRevert …) when the pre-flight simulation rejected the op */
  revert?: Hex;
};

export type RelayFailed = { kind: "error"; code: number; message: string; data?: RelayErrorData };

/** One NDJSON line of the streamed response. Terminal: confirmed | error. */
export type RelayFrame = RelayPending | RelayConfirmed | RelayFailed;

/** Plain-JSON response envelope (non-streaming clients). */
export type RelayJsonResponse =
  | { jsonrpc: "2.0"; id: number | string | null; result: RelayConfirmed }
  | { jsonrpc: "2.0"; id: number | string | null; error: { code: number; message: string; data?: RelayErrorData | string } };

export const isTerminal = (f: RelayFrame): f is RelayConfirmed | RelayFailed => f.kind !== "pending";
