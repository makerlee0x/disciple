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
  "struct PoolView { address coin; address quote; bool live; bool local; bool graduated; bool creatorOn; uint256 coinReserve; uint256 quoteReserve; uint256 anchorX128; uint256 ageOrBlock; uint256 pushCost; uint256 srcTvl; uint256 principal; uint256 compounded; uint256 lots; uint64 sampleAt; uint256 jarX; uint256 jarY; }",
  "function poolState(bytes32 id) view returns (PoolView)",
  "function pushReceiver() view returns (address)",
  "function owed(address keeper, address token) view returns (uint256)",
  "function collect(address token) returns (uint256)",
  "function sample(bytes32 id)",
  "function sampleDue(bytes32 id) view returns (bool)",
  "event Created(bytes32 indexed id, address indexed coin, address quote, address indexed creator, uint32 remoteEid, uint24 fee)",
  "event PriceAccepted(bytes32 indexed id, uint256 anchorX128, uint64 observedAt, uint256 refund, bool recovered)",
  "event PriceRejected(bytes32 indexed id, bytes32 guid)",
  "event Tipped(bytes32 indexed id, address indexed to, uint256 x, uint256 y)",
  "event Collected(address indexed keeper, address indexed token, uint256 amount)",
]);

export const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
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

/** Carry's follower hook (makerlee0x/carry contracts/follower): the same keeper calls, with Carry's PoolView (no
 *  cross-chain fields). */
export const carryHookAbi = parseAbi([
  "struct PoolView { address coin; address quote; bool live; bool graduated; bool creatorOn; uint256 coinReserve; uint256 quoteReserve; uint256 anchorX128; uint256 ageOrBlock; uint256 tX128; uint256 principal; uint256 compounded; uint256 lots; uint64 sampleAt; uint256 jarX; uint256 jarY; }",
  "function poolState(bytes32 id) view returns (PoolView)",
  "function sample(bytes32 id)",
  "function sampleDue(bytes32 id) view returns (bool)",
  "struct Tail { address vault; uint16 hotBps; uint256 shares; uint256 principal; }",
  "function tailState(bytes32 id) view returns (Tail t, uint256 yield_)",
  "function sweep(bytes32 id)",
  "event Created(bytes32 indexed id, address indexed coin, address quote, address indexed creator, uint32 remoteEid, uint24 fee)",
  "event Tipped(bytes32 indexed id, address indexed to, uint256 x, uint256 y)",
  "event TailMoved(address indexed vault, uint256 toVault, uint256 toHot)",
  // v0.3 epoch fee payout (carry #132): settle pays the open epoch out to every lot; settleEvery is the swap-path
  // backstop (6 h), and only a v0.3 hook has it, so the keeper uses it to tell the builds apart. The hook has no
  // "due" view (no bytes left): the keeper reads the epoch's start and its fees from storage (hook.ts readEpoch).
  "function settleEvery() view returns (uint32)",
  "function settle(bytes32 id)",
]);

/** Carry's stock queue (CarryStockQueue) and the bits of its vault the keeper reads. */
export const carryQueueAbi = parseAbi([
  "function vault() view returns (address)",
  "function waiting(uint256 market) view returns (uint256)",
  "function lineLength(uint256 market) view returns (uint256)",
  "function matchOrders(uint256 market, uint256 maxSteps) returns (uint256 matched)",
  "event Matched(uint256 indexed orderId, uint256 indexed positionId, uint256 used, uint256 left)",
  "function marketCount() view returns (uint256)",
  "function freeUsdg() view returns (uint256)",
  "function markets(uint256 market) view returns ((address token, bytes32 pool, bool active, uint256 cap, uint256 lent, uint256 shares, uint256 owed))",
]);

/** The per-market-hook vault (carry #130 on): Market gained `hook` (the market's ICarryHook, e.g. its
 *  CarryStrategyAdapter) after `token`. The keeper tries this shape first and falls back to the one above, so one
 *  build runs against both vaults (an old 7-word answer does not decode as 8 words). */
export const carryVaultV2Abi = parseAbi([
  "function markets(uint256 market) view returns ((address token, address hook, bytes32 pool, bool active, uint256 cap, uint256 lent, uint256 shares, uint256 owed))",
]);

/** Leader (same-chain source) reads: v2 pair, v3 pool, v4 PoolManager. */
export const leaderAbi = parseAbi([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function extsload(bytes32 slot) view returns (bytes32)",
]);
