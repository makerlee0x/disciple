// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeConstants as C} from "./libraries/BridgeConstants.sol";
import {BridgeCurve} from "./libraries/BridgeCurve.sol";
import {BridgeFee} from "./libraries/BridgeFee.sol";
import {BridgeV3Anchor} from "./libraries/BridgeV3Anchor.sol";
import {BridgeEngine} from "./BridgeEngine.sol";

/// @title Shared storage for Disciple (`BridgeLaunchHook`) and its facets
/// @dev Facets `delegatecall` into the hook, so every facet inherits this and adds no state
///      variables of its own. Immutables live in the executing bytecode: construct each facet
///      with the same manager, USDG, default vault, lzRead endpoint, and engine as the hook.
///      The order of the variables below is the storage layout. Do not reorder them.
abstract contract BridgeStorage {
    uint8 internal constant OP_SEED = 1;
    uint8 internal constant OP_DEPOSIT = 2;
    uint8 internal constant OP_REDEEM = 3;
    uint8 internal constant OP_CLAIM = 4;
    uint8 internal constant OP_READ = 5;
    uint8 internal constant OP_TIP = 6;
    uint8 internal constant OP_REBALANCE = 7;
    uint8 internal constant OP_LOSS = 8;
    uint8 internal constant OP_PULL = 9;
    uint8 internal constant OP_EXEC = 10;

    IPoolManager public immutable poolManager;
    address public immutable usdg;
    uint8 public immutable usdgDec;
    address public immutable vault;
    address public immutable lz;
    /// @dev Stateless math. Immutable. Holds nothing.
    BridgeEngine public immutable engine;
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
        uint8 anchorKind; // ANCHOR_LZ or ANCHOR_V3, fixed at creation
        address v3Pool; // same-chain reference. Zero for an lzRead pool.
        uint256 updatedAt;
        uint256 ethTvl;
        uint256 vaultShares;
        uint256 vaultAssets; // norm USDG currently in the vault (subset of principal)
        uint256 tipBudget;
        uint256 creatorAccrued;
        uint256 totalShares;
        uint256 feeIndex; // RAY, USDG fees per share
        uint32 outflowStart;
        uint256 outflowUsed;
        uint256 outflowBasis;
        address poolVault;
        uint16 morphoCapBps;
        bool vaultFrozen; // set when a loss is pulled; cleared only by a timelocked vault change
        address vaultAdmin;
        address pendingVault;
        uint256 vaultEta;
        uint64 openBlock;
        uint256 openSpot;
        uint256 openLpX;
        uint256 openLpY;
        uint256 openShares;
        uint256 openTakenX;
        uint256 openTakenY;
        uint256 blockFee; // LP fee from this block, not yet in `feeIndex`
        uint256 redeemedEligible; // opening shares burned this block (excluded from the fee denominator)
        BridgeCurve.S curve;
        PoolKey key;
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
        /// @dev `ANCHOR_LZ` (0) or `ANCHOR_V3` (1). Fixed for the life of the pool.
        uint8 anchorKind;
        /// @dev Uniswap v3 pool of `coin` / this hook's quote token. Required for `ANCHOR_V3`, zero otherwise.
        address v3Pool;
        uint256 coinSeed;
        uint256 tipSeed; // optional USDG, escrowed for keepers, not curve inventory. Zero for same-chain.
        /// @dev Max share of USDG principal that may sit in the vault. 10_000 = no extra cap.
        ///      Recommended: BridgeConstants.MORPHO_CAP_BPS (50%). The floor and buffer still apply.
        uint16 morphoCapBps;
        /// @dev May replace the vault after 48h or pull it immediately. Zero disables the key.
        address vaultAdmin;
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
    }

    /// @notice What a future OFT can read from `_debitView`. All fields are hook-computed.
    struct BridgeQuote {
        uint256 anchorPriceWad;
        uint256 poolPriceWad;
        int256 priceGapBps; // (pool − anchor) / anchor, signed bps
        int256 imbalanceBps; // (coin at anchor − USDG) / TVL, signed bps
        uint256 suggestedFeeBps; // fee for bridging coin *in* (a sell into this pool)
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
    /// @dev Normalized USDG the hook's ERC-6909 claims must cover (curve liquid + tips + creator fees).
    uint256 public usdgClaimsNorm;

    bool internal _locked;

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
    error VaultAsset();
    error LzFee();
    error RefundFailed();
    error Amount();
    error Dust();
    error Invariant();
    /// @dev Keeper reads and the keeper tip exist only for cross-chain pools.
    error SameChain();
    error NoLoss();
    error OnlyVaultAdmin();
    error Timelock();
    error OnlyDelegate();

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
    event VaultDeposit(PoolId indexed id, uint256 assets);
    event VaultWithdraw(PoolId indexed id, uint256 assets);
    event CreatorSet(PoolId indexed id, address indexed creator);
    event CreatorClaimed(PoolId indexed id, address indexed to, uint256 amount);
    event TipFunded(PoolId indexed id, address indexed from, uint256 amount);
    event VaultProposed(PoolId indexed id, address indexed next, uint256 eta);
    event VaultSet(PoolId indexed id, address indexed vault);
    event VaultAdminRenounced(PoolId indexed id);
    event VaultLossPulled(PoolId indexed id, uint256 assetsOut, uint256 loss);

    constructor(
        IPoolManager manager_,
        address usdg_,
        address vault_,
        address lz_,
        uint8 usdgDecimals_,
        BridgeEngine engine_
    ) {
        if (usdgDecimals_ > 18 || address(engine_) == address(0)) revert BadCreate();
        if (IERC4626(vault_).asset() != usdg_) revert VaultAsset();
        poolManager = manager_;
        usdg = usdg_;
        usdgDec = usdgDecimals_;
        vault = vault_;
        lz = lz_;
        engine = engine_;
        usdgC = Currency.wrap(usdg_);
    }

    /// @dev `s` is the book the trade will use (already recentered, for a same-chain pool).
    ///      `refTvl` is the reference pool's TVL. `age` is ignored for same-chain: that mode has no stale fee
    ///      and no keeper tip, so the only fee cut is the creator's 10% after graduation.
    function _ctx(Pool storage p, BridgeCurve.S memory s, uint256 refTvl, uint256 age)
        internal
        view
        returns (BridgeCurve.Ctx memory ctx)
    {
        uint256 room = BridgeCurve.floorRoom(s, p.floorBps);
        uint256 cap = _outflowLeft(p, BridgeCurve.principalY(s));
        ctx.gradTvl = refTvl == 0 ? 0 : Math.mulDiv(refTvl, C.GRAD_NUM, C.GRAD_DEN);
        bool sameChain = p.anchorKind == C.ANCHOR_V3;
        ctx.age = sameChain ? 0 : age;
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
        if (p.anchorKind == C.ANCHOR_V3) {
            (uint256 price, uint256 tvl) = BridgeV3Anchor.read(p.v3Pool, p.coin, usdg, p.coinDec, usdgDec);
            if (price != s.anchor) BridgeCurve.onAnchor(s, price);
            return (s, tvl, 0);
        }
        return (s, p.ethTvl, _age(p));
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

    function _gradTvl(Pool storage p) internal view returns (uint256) {
        if (p.ethTvl == 0) return 0;
        return Math.mulDiv(p.ethTvl, C.GRAD_NUM, C.GRAD_DEN);
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
