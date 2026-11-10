import { parseAbi } from "viem";

/** The parts of DiscipleHook an integrator needs. PoolId is bytes32 in the ABI. */
export const discipleHookAbi = parseAbi([
  "struct PoolView { address coin; address quote; bool live; bool local; bool graduated; bool creatorOn; uint256 coinReserve; uint256 quoteReserve; uint256 anchorX128; uint256 ageOrBlock; uint256 pushCost; uint256 srcTvl; uint256 principal; uint256 compounded; uint256 lots; uint64 sampleAt; uint256 jarX; uint256 jarY; }",
  // exact (amountIn, amountOut) of a swap sent against this state; plain view, no revert to decode
  "function quoteView(bytes32 id, bool zeroForOne, int256 amountSpecified) view returns (uint256 amountIn, uint256 amountOut)",
  "function poolState(bytes32 id) view returns (PoolView)",
  "function poolsOf(address currency0, address currency1) view returns (uint256)",
  "function sampleDue(bytes32 id) view returns (bool)",
  "function poolManager() view returns (address)",
  "event Created(bytes32 indexed id, address indexed coin, address quote, address indexed creator, uint32 remoteEid, uint24 fee)",
  "event HookSwap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint128 hookLPfeeAmount0, uint128 hookLPfeeAmount1)",
  "event HookModifyLiquidity(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1)",
  "event PriceAccepted(bytes32 indexed id, uint256 anchorX128, uint64 observedAt, uint256 refund, bool recovered)",
  "event LocalMode(bytes32 indexed id, bool on)",
  "event Tipped(bytes32 indexed id, address indexed to, uint256 x, uint256 y)",
  "event JarFunded(bytes32 indexed id, address indexed from, uint256 x, uint256 y)",
  "error UnknownPool()",
  "error NotLive()",
  "error NoAnchor()",
  "error BadParams()",
  "error ZeroOutput()",
  "error TradeTooLarge()",
  "error InsufficientReserve()",
]);

export const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
