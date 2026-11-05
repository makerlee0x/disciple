// LayerZero PacketV1: version(1) nonce(8) srcEid(4) sender(32) dstEid(4) receiver(32) | guid(32) | message
import { concat, decodeAbiParameters, decodeEventLog, encodeAbiParameters, keccak256, slice, type Hex, type Log } from "viem";
import { endpointAbi, PACKET_SENT_TOPIC } from "./abi.ts";

export interface ParsedPacket {
  nonce: bigint;
  srcEid: number;
  sender: Hex; // bytes32
  dstEid: number;
  receiver: Hex; // address
  guid: Hex;
  header: Hex;
  message: Hex;
}

export function parsePacket(encoded: Hex): ParsedPacket {
  const n = (encoded.length - 2) / 2;
  if (n <= 113) throw new Error("packet too short");
  return {
    nonce: BigInt(slice(encoded, 1, 9)),
    srcEid: Number(BigInt(slice(encoded, 9, 13))),
    sender: slice(encoded, 13, 45),
    dstEid: Number(BigInt(slice(encoded, 45, 49))),
    receiver: `0x${slice(encoded, 49, 81).slice(26)}` as Hex,
    guid: slice(encoded, 81, 113),
    header: slice(encoded, 0, 81),
    message: slice(encoded, 113),
  };
}

export const payloadHash = (guid: Hex, message: Hex): Hex => keccak256(concat([guid, message]));

/** Every PacketSent in a receipt's logs from `endpoint`. */
export function packetsFromLogs(logs: Log[], endpoint: Hex): ParsedPacket[] {
  const out: ParsedPacket[] = [];
  for (const l of logs) {
    if (l.address.toLowerCase() !== endpoint.toLowerCase() || l.topics[0] !== PACKET_SENT_TOPIC) continue;
    const ev = decodeEventLog({ abi: endpointAbi, data: l.data, topics: l.topics, eventName: "PacketSent" });
    out.push(parsePacket(ev.args.encodedPayload));
  }
  return out;
}

const OBS = {
  type: "tuple[]",
  components: [
    { name: "kind", type: "uint8" },
    { name: "target", type: "address" },
    { name: "v4Id", type: "bytes32" },
    { name: "a", type: "uint256" },
    { name: "b", type: "uint256" },
    { name: "pools", type: "bytes32[]" },
  ],
} as const;
const MSG = [{ type: "uint64" }, { type: "address" }, { type: "uint256" }, OBS] as const;

export interface PushMessage {
  observedAt: bigint;
  keeper: Hex;
  cost: bigint;
  obs: readonly { kind: number; target: Hex; v4Id: Hex; a: bigint; b: bigint; pools: readonly Hex[] }[];
}

/** Decodes the push message (DisciplePushSender._message). */
export function decodeMessage(message: Hex): PushMessage {
  const [observedAt, keeper, cost, obs] = decodeAbiParameters(MSG, message);
  return { observedAt, keeper, cost, obs };
}

/** Byte length of a push message for these sources (pool counts per source); must stay under MAX_MESSAGE_SIZE. */
export function messageLength(poolsPerSource: number[]): number {
  const z = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
  const obs = poolsPerSource.map((k) => ({
    kind: 1,
    target: "0x0000000000000000000000000000000000000000" as Hex,
    v4Id: z,
    a: 0n,
    b: 0n,
    pools: Array<Hex>(k).fill(z),
  }));
  const enc = encodeAbiParameters(MSG, [0n, "0x0000000000000000000000000000000000000000", 0n, obs]);
  return (enc.length - 2) / 2;
}
