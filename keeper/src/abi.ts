import { parseAbi } from "viem";

export const senderAbi = parseAbi([
  "struct Req { uint8 kind; address target; bytes32 v4Id; bytes32[] pools; }",
  "function quote(uint32 dstEid, bytes32 receiver, Req[] reqs, uint128 gas) view returns (uint256)",
  "function push(uint32 dstEid, bytes32 receiver, Req[] reqs, uint128 gas) payable returns (bytes32)",
  "function read(uint8 kind, address target, bytes32 v4Id) view returns (uint256 a, uint256 b)",
  "function endpoint() view returns (address)",
  "event Pushed(uint32 indexed dstEid, bytes32 guid, uint256 sources, uint256 pools, uint256 cost, address keeper)",
]);

export const receiverAbi = parseAbi([
  "function hook() view returns (address)",
  "function endpoint() view returns (address)",
  "function peers(uint32 eid) view returns (bytes32)",
  "event Undelivered(bytes32 indexed id)",
]);

export const hookAbi = parseAbi([
  "struct PoolView { address coin; address quote; bool live; bool local; bool graduated; bool creatorOn; uint256 coinReserve; uint256 quoteReserve; uint256 anchorX128; uint256 ageOrBlock; uint256 tank; uint256 srcTvl; uint256 principal; uint256 compounded; uint256 lots; }",
  "function poolState(bytes32 id) view returns (PoolView)",
  "function pushReceiver() view returns (address)",
  "event Created(bytes32 indexed id, address indexed coin, address quote, address indexed creator, uint32 remoteEid, uint24 fee)",
  "event PriceAccepted(bytes32 indexed id, uint256 anchorX128, uint64 observedAt, uint256 refund, bool recovered)",
  "event PriceRejected(bytes32 indexed id, bytes32 guid)",
]);

export const endpointAbi = parseAbi([
  "struct Origin { uint32 srcEid; bytes32 sender; uint64 nonce; }",
  "function lazyInboundNonce(address receiver, uint32 srcEid, bytes32 sender) view returns (uint64)",
  "function inboundPayloadHash(address receiver, uint32 srcEid, bytes32 sender, uint64 nonce) view returns (bytes32)",
  "function getReceiveLibrary(address receiver, uint32 srcEid) view returns (address lib, bool isDefault)",
  "function lzReceive(Origin origin, address receiver, bytes32 guid, bytes message, bytes extraData) payable",
  "event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)",
  "error LZ_InvalidNonce(uint64 nonce)",
  "error LZ_PayloadHashNotFound(bytes32 expected, bytes32 actual)",
]);

export const ulnAbi = parseAbi([
  "function commitVerification(bytes packetHeader, bytes32 payloadHash)",
  "function verify(bytes packetHeader, bytes32 payloadHash, uint64 confirmations)",
]);

/** keccak256("PacketSent(bytes,bytes,address)") */
export const PACKET_SENT_TOPIC = "0x1ab700d4ced0c005b164c0f789fd09fcbb0156d4c2041b8a3bfbcd961cd1567f";
