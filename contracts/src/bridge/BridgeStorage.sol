// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeConstants as C} from "./libraries/BridgeConstants.sol";
import {BridgeCurve} from "./libraries/BridgeCurve.sol";
import {BridgeFee} from "./libraries/BridgeFee.sol";
import {BridgeV3Anchor} from "./libraries/BridgeV3Anchor.sol";
import {BridgeV4Anchor} from "./libraries/BridgeV4Anchor.sol";
import {IV4OracleHook} from "./interfaces/IV4OracleHook.sol";
import {DiscipleEngine} from "./DiscipleEngine.sol";

/// @title Shared storage for Disciple (`DiscipleHook`) and its facets
/// @dev Facets `delegatecall` into the hook, so every facet inherits this and adds no state
///      variables of its own. Immutables live in the executing bytecode: construct each facet
///      with the same manager, USDG, lzRead endpoint, and engine as the hook.
///      The order of the variables below is the storage layout. Do not reorder them.
abstract contract BridgeStorage {
    using PoolIdLibrary for PoolKey;

    uint8 internal constant OP_SEED = 1;
    uint8 internal constant OP_DEPOSIT = 2;
    uint8 internal constant OP_REDEEM = 3;
    uint8 internal constant OP_CLAIM = 4;
    uint8 internal constant OP_READ = 5;
    uint8 internal constant OP_TIP = 6;
    uint8 internal constant OP_POKE = 7;
    uint8 internal constant OP_BUILDER = 8;

    IPoolManager public immutable poolManager;
    address public immutable usdg;
    uint8 public immutable usdgDec;
    address public immutable lz;
    /// @dev Stateless math. Immutable. Holds nothing.
    DiscipleEngine public immutable engine;
    Currency internal immutable usdgC;

    struct Pool {
        bool exists;
        bool coinIs0;
        bool graduated;
        uint8 coinDec;
        address coin;
        address creator;
        uint16 floorBps;
        uint16 outflowCapBps;
        uint32 outflowWindow; // 0 off, 1 per block, 3600 per hour
        uint32 remoteEid;
        address remoteOracle;
        uint8 anchorKind; // fixed at creation. See BridgeConstants.ANCHOR_*.
        address v3Pool; // same-chain v3 reference. Zero unless ANCHOR_V3.
        uint256 updatedAt;
        uint256 ethTvl;
        /// @dev Normalized USDG this pool may draw from the hook's claims. Other pools cannot spend it.
        uint256 usdgHeld;
        uint256 tipBudget;
        uint256 creatorAccrued;
        uint256 totalShares;
        uint256 feeIndex; // RAY, USDG fees per share
        uint32 outflowStart;
        uint256 outflowUsed;
        uint256 outflowBasis;
        uint64 openBlock;
        uint256 openSpot;
        uint256 openLpX;
        uint256 openLpY;
        uint256 openShares;
        uint256 openTakenX;
        uint256 openTakenY;
        uint256 blockFee; // LP fee from this block, not yet in `feeIndex`
        uint256 redeemedEligible; // opening shares burned this block (excluded from the fee denominator)
        /// @dev Both Dutch quotes share this clock. A trade sets it to `block.timestamp`, which closes the gap.
        uint64 dutchAt;
        /// @dev Wad of gap per second. Fixed at creation.
        uint64 dutchDrift;
        /// @dev First timestamp pool TVL was seen at or above the live target. 0 means not running.
        uint64 aboveSince;
        /// @dev First timestamp pool TVL was seen strictly below the live target. 0 means not running.
        uint64 belowSince;
        /// @dev Last time `smoothedTvl` was updated. The raw reading stays in `ethTvl`.
        uint64 smoothAt;
        uint256 smoothedTvl;
        bytes32 refPoolId;
        address refHook;
        /// @dev Self-sample only. True when the coin is currency0 of the reference v4 pool.
        bool refCoinIs0;
        BridgeCurve.S curve;
        PoolKey key;
        /// @dev 1% of graduated fees, claimable only by the hook builder.
        uint256 builderAccrued;
        /// @dev Monotonic id of the latest lzRead request. 0 means none has been sent.
        uint64 readNonce;
        /// @dev Highest request nonce whose result was accepted. A lower nonce is out of order.
        uint64 appliedNonce;
    }

    struct CreateParams {
        address coin;
        address creator;
        uint16 floorBps; // 100–5000 (1%–50%). Recommended: BridgeConstants.FLOOR_BPS (20%).
        uint16 discountBps; // 1000–5000 (10%–50% below the anchor). Recommended: 3300 → 0.67x.
        uint16 outflowCapBps; // 0 = off
        uint32 outflowWindow; // 0, 1 (block), or 3600 (hour)
        uint32 remoteEid;
        address remoteOracle;
        /// @dev Anchor kind. Fixed for the life of the pool. See `BridgeConstants`.
        uint8 anchorKind;
        /// @dev Reference v3 pool of `coin` / the quote token. Required for `ANCHOR_V3` (read on this
        ///      chain) and `ANCHOR_LZ` (passed to the remote lens). Zero for every other kind.
        address v3Pool;
        uint256 coinSeed;
        uint256 tipSeed; // optional USDG, escrowed for keepers, not curve inventory. Zero for same-chain.
        /// @dev Wad per second. 0 selects `DUTCH_DRIFT_DEFAULT` (about 1% of the anchor per hour).
        uint64 dutchDrift;
        /// @dev Reference v4 pool id. Required for every v4 anchor kind. Zero otherwise.
        bytes32 refPoolId;
        /// @dev Oracle hook for `ANCHOR_V4_ORACLE` and `ANCHOR_LZ_V4_ORACLE`. For `ANCHOR_LZ_V4_SLOT`
        ///      this is the remote PoolManager. Zero for the other kinds.
        address refHook;
        /// @dev Self-sample only. True when the coin is currency0 of `refPoolId`.
        bool refCoinIs0;
    }

    /// @notice Exact size and direction that maximizes mark-to-anchor profit after the current fee.
    ///         Amounts are raw token units. `profitWad` is normalized USDG. Zero `amountIn` means no edge.
    struct ArbQuote {
        bool buyCoin;
        uint256 amountIn;
        uint256 amountOut;
        uint256 profitWad;
    }

    struct PendingRead {
        PoolId poolId;
        address caller;
        /// @dev `readNonce` at the moment this request was sent. Newer wins.
        uint64 nonce;
        /// @dev Timestamp the request was sent. Stored so a late result can be told from a new one.
        uint64 requestedAt;
    }

    /// @notice What a future OFT can read from `_debitView`. All fields are hook-computed.
    struct BridgeQuote {
        uint256 anchorPriceWad;
        uint256 poolPriceWad;
        int256 priceGapBps; // (pool − anchor) / anchor, signed bps
        int256 imbalanceBps; // (coin at anchor − USDG) / TVL, signed bps
        /// @dev Progress fee a swap would pay right now. Same in both directions.
        ///      It does not rise with the gap, with volume, or because the anchor is stale.
        uint256 suggestedFeeBps;
        bool stale;
        bool graduated;
    }

    mapping(PoolId => Pool) internal pools;
    mapping(PoolId => mapping(address => uint256)) public sharesOf;
    mapping(PoolId => mapping(address => uint256)) internal feeIndexOf;
    mapping(PoolId => mapping(address => uint256)) internal feeCreditOf;
    /// @dev Shares minted in `freshBlock` (a subset of `sharesOf`). They do not earn that block's fees.
    mapping(PoolId => mapping(address => uint256)) internal freshShares;
    mapping(PoolId => mapping(address => uint256)) internal freshCoin;
    mapping(PoolId => mapping(address => uint256)) internal freshUsdg;
    mapping(PoolId => mapping(address => uint64)) internal freshBlock;
    /// @dev Fee index after the named block's fees were rolled. Fresh shares from that block start here.
    mapping(PoolId => mapping(uint64 => uint256)) internal indexAtBlock;
    mapping(bytes32 => PendingRead) internal pendingReads;
    /// @dev Self-sampled v4 rings, keyed by this hook's pool id. One ring per pool.
    mapping(bytes32 => BridgeV4Anchor.Ring) internal rings;
    mapping(bytes32 => mapping(uint16 => uint256)) internal obs;
    /// @dev Normalized USDG the hook's ERC-6909 claims must cover
    ///      (curve liquid + tips + creator fees + builder fees).
    uint256 public usdgClaimsNorm;

    bool internal _locked;
    /// @dev Global recipient of the 1% graduated-fee share. Set at deployment. Pool creators cannot move it.
    address public builder;
    /// @dev Two-step handoff. Only `builder` can set it. Only this address can accept.
    address public pendingBuilder;

    error OnlyPoolManager();
    error OnlyLz();
    error Reentrancy();
    error ExternalInit();
    error LiquidityDisabled();
    error HookNotImplemented();
    error UnknownPool();
    error NoAnchor();
    error Fresh();
    error BadPrice();
    error UnknownRead();
    error ExceedsCap();
    error ZeroOutput();
    error ExactOutUnsupported();
    error BadCreate();
    error OnlyCreator();
    error OnlyBuilder();
    error LzFee();
    error RefundFailed();
    error Amount();
    error Dust();
    error Invariant();
    /// @dev Keeper reads and the keeper tip exist only for cross-chain pools.
    error SameChain();
    error OnlyDelegate();
    /// @dev Cross-chain anchor is missing or older than `STALE_AFTER`. Swaps stop until a read lands.
    error Stale();
    /// @dev This result's nonce is older than one already applied.
    error OutOfOrder();
    /// @dev The new anchor is more than `ANCHOR_MOVE_BPS` away from the stored one.
    error AnchorMove();

    event PoolCreated(
        PoolId indexed id,
        address indexed coin,
        address indexed creator,
        uint16 floorBps,
        uint16 discountBps,
        uint256 coinSeed,
        uint8 anchorKind
    );
    event Swapped(
        PoolId indexed id,
        address indexed sender,
        bool buy,
        uint256 coinAmount,
        uint256 usdgAmount,
        uint256 fee,
        uint256 spotAfter
    );
    event MintedLp(PoolId indexed id, address indexed to, uint256 shares, uint256 coin, uint256 usdg);
    event Deposited(PoolId indexed id, address indexed lp, uint256 shares, uint256 coin, uint256 usdg);
    event Redeemed(PoolId indexed id, address indexed lp, uint256 shares, uint256 coin, uint256 usdg, uint256 fee);
    event PriceRequested(PoolId indexed id, bytes32 indexed guid, address indexed caller);
    event PriceUpdated(PoolId indexed id, uint256 anchor, uint256 ethTvl, uint256 tip);
    event Graduated(PoolId indexed id, uint256 poolTvl, uint256 ethTvl);
    event Ungraduated(PoolId indexed id, uint256 poolTvl, uint256 target);
    event CreatorSet(PoolId indexed id, address indexed creator);
    event CreatorClaimed(PoolId indexed id, address indexed to, uint256 amount);
    event BuilderProposed(address indexed next);
    event BuilderAccepted(address indexed builder);
    event BuilderClaimed(PoolId indexed id, address indexed to, uint256 amount);
    event TipFunded(PoolId indexed id, address indexed from, uint256 amount);

    constructor(IPoolManager manager_, address usdg_, address lz_, uint8 usdgDecimals_, DiscipleEngine engine_) {
        if (usdgDecimals_ > 18 || address(engine_) == address(0)) revert BadCreate();
        poolManager = manager_;
        usdg = usdg_;
        usdgDec = usdgDecimals_;
        lz = lz_;
        engine = engine_;
        usdgC = Currency.wrap(usdg_);
    }

    /// @dev `s` is the book the trade will use (already recentered, for a same-chain pool).
    ///      The fee and the band use the smoothed graduation target, not the raw reference TVL.
    function _ctx(Pool storage p, BridgeCurve.S memory s) internal view returns (BridgeCurve.Ctx memory ctx) {
        uint256 room = BridgeCurve.floorRoom(s, p.floorBps);
        uint256 cap = _outflowLeft(p, BridgeCurve.principalY(s));
        ctx.gradTvl = _gradTvl(p);
        bool sameChain = _sameChain(p.anchorKind);
        ctx.graduated = p.graduated;
        ctx.tipRoom = sameChain || p.tipBudget >= C.TIP_BUDGET_CAP ? 0 : C.TIP_BUDGET_CAP - p.tipBudget;
        ctx.floorBps = p.floorBps;
        ctx.maxUsdgOut = cap < room ? cap : room;
        ctx.totalShares = p.totalShares;
        ctx.boostWad = BridgeFee.boostWad(BridgeCurve.tvl(s), ctx.gradTvl);
    }

    /// @notice Memory book priced off the live anchor. Does not write storage.
    function _referenced(Pool storage p) internal view returns (BridgeCurve.S memory s, uint256 refTvl, uint256 age) {
        s = p.curve;
        uint8 k = p.anchorKind;
        if (k == C.ANCHOR_V3) {
            (uint256 price, uint256 tvl) = BridgeV3Anchor.read(p.v3Pool, p.coin, usdg, p.coinDec, usdgDec);
            if (price != s.anchor) BridgeCurve.onAnchor(s, price);
            return (s, tvl, 0);
        }
        if (k == C.ANCHOR_V4_ORACLE) {
            (uint256 price, uint256 tvl) = IV4OracleHook(p.refHook).consult(p.refPoolId, uint32(C.TWAP_WINDOW));
            if (price != 0 && price != s.anchor) BridgeCurve.onAnchor(s, price);
            return (s, tvl, 0);
        }
        if (k == C.ANCHOR_V4_SAMPLE) {
            (bool ready, uint256 price, uint256 tvl) = BridgeV4Anchor.peek(
                poolManager, p.refPoolId, rings[_rawId(p)], obs[_rawId(p)], p.refCoinIs0, p.coinDec, usdgDec
            );
            if (ready && price != 0) {
                if (price != s.anchor) BridgeCurve.onAnchor(s, price);
                return (s, tvl, 0);
            }
        }
        return (s, p.ethTvl, _age(p));
    }

    function _sameChain(uint8 kind) internal pure returns (bool) {
        return kind == C.ANCHOR_V3 || kind == C.ANCHOR_V4_ORACLE || kind == C.ANCHOR_V4_SAMPLE;
    }

    /// @dev Gap in WAD. Both quotes share `dutchAt`. Zero until time has passed since the last trade.
    function _gap(Pool storage p) internal view returns (uint256) {
        if (p.dutchAt == 0 || p.dutchDrift == 0 || block.timestamp <= uint256(p.dutchAt)) return 0;
        return (block.timestamp - uint256(p.dutchAt)) * uint256(p.dutchDrift);
    }

    function _rawId(Pool storage p) internal view returns (bytes32) {
        return PoolId.unwrap(p.key.toId());
    }

    function _outflowLeft(Pool storage p, uint256 principal) internal view returns (uint256) {
        if (p.outflowWindow == 0 || p.outflowCapBps == 0) return type(uint256).max;
        bool expired = p.outflowWindow == C.OUTFLOW_PER_BLOCK
            ? block.number != p.outflowStart
            : block.timestamp >= uint256(p.outflowStart) + p.outflowWindow;
        if (expired) return (principal * p.outflowCapBps) / C.BPS;
        uint256 cap = (p.outflowBasis * p.outflowCapBps) / C.BPS;
        return cap > p.outflowUsed ? cap - p.outflowUsed : 0;
    }

    /// @dev 12% of the smoothed reference TVL. A one-block donation barely moves this.
    function _gradTvl(Pool storage p) internal view returns (uint256) {
        if (p.smoothedTvl == 0) return 0;
        return Math.mulDiv(p.smoothedTvl, C.GRAD_NUM, C.GRAD_DEN);
    }

    function _age(Pool storage p) internal view returns (uint256) {
        if (p.updatedAt == 0 || block.timestamp <= p.updatedAt) return 0;
        return block.timestamp - p.updatedAt;
    }

    function _toNorm(uint256 raw, uint8 dec) internal pure returns (uint256) {
        if (dec == 18) return raw;
        return raw * 10 ** (18 - dec);
    }

    function _toRaw(uint256 norm, uint8 dec) internal pure returns (uint256) {
        if (dec == 18) return norm;
        return norm / 10 ** (18 - dec);
    }

    function _toRawUp(uint256 norm, uint8 dec) internal pure returns (uint256) {
        if (dec == 18) return norm;
        uint256 s = 10 ** (18 - dec);
        return (norm + s - 1) / s;
    }

    function _signedBps(uint256 a, uint256 b) internal pure returns (int256) {
        if (b == 0) return 0;
        if (a >= b) return int256(Math.mulDiv(a - b, C.BPS, b));
        return -int256(Math.mulDiv(b - a, C.BPS, b));
    }
}
