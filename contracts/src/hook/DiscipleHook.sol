// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {IERC20Minimal} from "@uniswap/v4-core/src/interfaces/external/IERC20Minimal.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CurrencySettler} from "../libraries/CurrencySettler.sol";
import {DiscipleSwapMath as SM} from "./libraries/DiscipleSwapMath.sol";
import {DisciplePrice as PR} from "./libraries/DisciplePrice.sol";
import {DiscipleLedger as LG} from "./libraries/DiscipleLedger.sol";
import {DiscipleDepth as DP} from "./libraries/DiscipleDepth.sol";
import {DiscipleBooks as BK} from "./DiscipleBooks.sol";

interface IV2PairLike {
    function getReserves() external view returns (uint112, uint112, uint32);
}

/// @title Disciple
/// @notice A Uniswap v4 hook that runs small coin/quote pools priced off an anchor from a source pool.
///         One deployment serves many pools. Permissionless: anyone creates a pool against any source.
///
///         Same chain (beside a v2, v3 or v4 source on this chain): the anchor is latched once per block from
///         the source's spot as seen in an earlier block. Anyone may call sample() to take that price sample
///         without a trade; it does not settle the books or read source TVL. Each latch moves the anchor toward
///         the sample by at most one step (the pool fee, at least `minStep`), so a faked one-block sample shifts
///         the centre by no more than the fee. There is no lag premium. Every fill respects the live source
///         boundary (ask >= source ask * 0.9999, bid <= source bid * 1.0001), read in the same call.
///         Tip jar: 12% of each interval's earnings goes to the pool's own jar (both tokens, pro rata) until it
///         holds about JAR_TIPS tips. sample() pays its caller gas + 20% from the jar, but only while the centre
///         is at least 1% from the leader, so the pool catches up after a move even with no trades.
///
///         Cross chain (new chain, anchor pushed from the home chain over LayerZero by a DisciplePushSender there
///         and authenticated by the DisciplePushReceiver here): the anchor is the last accepted push. Keepers push on
///         a 1% home move or a 59.5-min heartbeat and are refunded their cost plus 20% from the pool's ETH tank (a
///         heartbeat only if the pool traded since the last price). lzRead and the rollup-bridge route were cut
///         from v0 (maker, 2026-11-04). The spread widens after 60 min; after 2 h the pool enters local mode (re-centres, drops the band,
///         keeps trading). A fresh push under 20 min old (PUSH_RECOVERY_AGE) ends local mode and re-centres again. The pool never
///         stops trading.
///
///         Curve and fills: DiscipleSwapMath. Price rules: DisciplePrice. LP books: DiscipleLedger.
///         v4 concentrated liquidity is disabled; every swap is quoted in `beforeSwap`.
///         Custody: pool liquidity is held as the hook's ERC-6909 claims inside the PoolManager, so a swap only
///         mints and burns claims. Deposits, withdrawals and claims convert to and from ERC20 in one unlock.
contract DiscipleHook is IHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using CurrencySettler for Currency;
    using LG for LG.Book;

    // ---------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------

    /// @dev Source kinds for `Source.kind`: 1 = v2, 2 = v3, 3 = v4.
    uint8 internal constant SRC_V2 = 1;
    uint8 internal constant SRC_V3 = 2;
    uint8 internal constant SRC_V4 = 3;

    uint256 internal constant Q128 = 1 << 128;
    uint256 internal constant WAD = 1e18;
    /// @dev sample() pays a tip only while the centre is at least this far (bps) from the live leader price.
    uint256 internal constant DUE_BPS = 100;
    /// @dev Jar cap: this many reference tips (TIP_GAS_REF gas at the current basefee, +20%).
    uint256 internal constant JAR_TIPS = 320;
    uint256 internal constant TIP_GAS_REF = 150_000;
    /// @dev Gas a tipped sample() spends outside the measured span (intrinsic, calldata, the payout itself).
    uint256 internal constant TIP_OVERHEAD = 80_000;
    /// @dev One tip is at most this fraction of the jar, so a basefee spike cannot empty it in a few calls.
    uint256 internal constant TIP_DIV = 32;
    /// @dev Pool fee bounds, in pips.
    uint24 internal constant MAX_FEE = 100_000;
    /// @dev v4 source depth counter: storage reads per block (first touch) and at createPool (creator pays).
    uint256 internal constant WALK_STEPS = 4;
    /// @dev Largest cross-chain decimal shift (10^36 fits any realistic price or TVL product).
    int8 internal constant MAX_SHIFT = 36;
    /// @dev The creator cut remembers the highest confirmed source TVL, fading linearly to nothing over this long.
    uint256 internal constant TVL_MEMORY = 1 days;
    /// @dev After creation (same chain) or the first price (cross chain) nothing graduates and the creator gets no cut.
    uint256 internal constant WARM_UP = 1 days;
    uint256 internal constant WALK_INIT_STEPS = 256;
    /// @dev A recovering pushed price may be this old on arrival.
    uint256 internal constant PUSH_RECOVERY_AGE = 20 minutes;
    /// @dev Cap on one push refund, so a gas spike on the home chain cannot drain the tank.
    uint256 internal constant MAX_PUSH_REFUND = 0.002 ether;

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    /// @dev Leg 1 is a pool of the coin and a token X. With no leg 2 (`kind2 == 0`, the mirror case) X is the quote.
    ///      With leg 2 (same chain only) it is a pool of X and the quote, and the price is leg 1 x leg 2 (two-hop).
    ///      Native ETH in a pool counts as `weth`.
    struct Source {
        uint8 kind; // leg 1: SRC_V2 / SRC_V3 / SRC_V4
        bool coinIs0; // the coin is token0 of leg 1
        uint32 remoteEid; // 0 = same chain; else the home chain's LayerZero eid
        address target; // v2 pair / v3 pool; for v4 the PoolManager (remote: the remote manager)
        bytes32 v4Id; // v4 source pool id
        int8 decShift; // cross chain: price * 10^decShift converts home raw quote-per-coin to local raw units
        int8 tvlShift; // cross chain: TVL * 10^tvlShift converts home raw quote units to local raw quote units
        bool push; // must be true for a cross-chain pool (LayerZero push from a sender on chain `remoteEid`)
        uint8 kind2; // leg 2 kind, 0 = none
        bool xIs0; // X is token0 of leg 2
        address target2; // leg 2 v2 pair / v3 pool (v4: unused)
        bytes32 v4Id2; // leg 2 v4 pool id
    }

    struct Pool {
        bool exists;
        bool live; // ledger initialised (cross chain waits for its first price)
        bool coinIs0; // coin is currency0 of the Disciple pool
        bool local; // cross chain local mode
        uint24 fee; // pips
        address coin;
        address quote;
        Source src;
        uint256 tX128; // curve seed ratio T (quote raw per coin raw, X128)
        uint256 anchorX128; // A
        uint64 obsAt; // cross: source observation time of A
        uint64 settledBlock; // same chain: last block the ledger settled
        uint256 sampleX128; // same chain: last source spot sampled
        uint64 sampleBlock;
        uint64 sampleAt; // timestamp of sampleX128
        uint256 jarX; // same chain tip jar, coin raw (held as claims, outside the book)
        uint256 jarY; // tip jar, quote raw
        uint256 srcTvl; // latest source TVL reading in quote raw; 0 = not known yet
        uint256 prevTvl; // the reading before it
        uint256 recTvl; // highest confirmed reading (the lower of two in a row), fading over TVL_MEMORY from recAt
        uint64 recAt;
        uint64 warmEnd; // until then the creator cut and graduation stay off
        uint8 seen; // readings since launch / first price, up to 2 (the launch reading never counts)
        address x; // same chain: leg 1's other token (the quote, or X for two-hop)
        DP.Walk walk; // same-chain v4 leg 1: the depth counter that measures its TVL
        uint256 tank; // ETH for refreshes
        uint256 seedX; // cross chain: creator's seed, held until the first price
        uint256 seedY;
        LG.Book book;
    }

    struct CreateParams {
        address coin;
        address quote; // any ERC20 other than the coin
        uint24 fee; // Disciple fee in pips
        Source src;
        uint256 coinIn;
        uint256 quoteIn;
        PoolKey srcKey; // same-chain v4 leg 1 only: its key, which must hash to `src.v4Id`
        PoolKey srcKey2; // same-chain v4 leg 2 only: its key, which must hash to `src.v4Id2`
    }

    /// @dev One token movement inside an unlock: `into` the pool's claims from `who`, or out of them to `who`.
    struct Move {
        address token;
        address who;
        uint256 amt;
        bool into;
    }

    IPoolManager public immutable poolManager;
    /// @notice The DisciplePushReceiver beside this hook (0 = LayerZero push off). It authenticates the LayerZero
    ///         message and its home-chain sender, then calls `onBridgePrice` with the home chain's eid.
    address public immutable pushReceiver;
    /// @notice Same-chain v2 / v3 sources must be pools of these factories (0 = that kind is off).
    address public immutable v2Factory;
    address public immutable v3Factory;
    /// @notice Native ETH in a same-chain source pool counts as this token (the chain's WETH).
    address public immutable weth;
    /// @notice Smallest per-reading anchor step, in pips (the step is max(pool fee, minStep)). Robinhood 1%,
    ///         Ethereum 5% (slower blocks: a move up to ~10% is caught up in two readings).
    uint24 public immutable minStep;
    /// @notice The chain's reference WETH/stable pool, used only to value tip-jar gas in a non-ETH quote.
    address public immutable refToken;
    uint8 internal immutable refKind;
    address internal immutable refTarget;
    bytes32 internal immutable refV4Id;
    bool internal immutable refWethIs0;

    /// @dev Per-chain settings fixed at deploy. `ref*`: one WETH/refToken pool (kind 0 = none: tips then pay only
    ///      pools quoted in WETH or refToken, others fall back to the ETH tank).
    struct Config {
        uint24 minStep;
        address refToken;
        uint8 refKind;
        address refTarget;
        bytes32 refV4Id;
        bool refWethIs0;
    }
    /// @notice Disciple pools per pair so far, by sorted (currency0, currency1). Pool n of a pair has tickSpacing n,
    ///         so a pair is never squatted.
    mapping(address => mapping(address => uint256)) public poolsOf;

    mapping(PoolId => Pool) internal pools;
    bool internal _locked;

    // ---------------------------------------------------------------------------------------------
    // Events and errors
    // ---------------------------------------------------------------------------------------------

    event Created(
        PoolId indexed id, address indexed coin, address quote, address indexed creator, uint32 remoteEid, uint24 fee
    );
    /// @dev Standard hook events (OpenZeppelin IHookEvents) so indexers see a custom-curve pool's flow. Amounts
    ///      are the pool's view per currency: positive = into the pool, negative = out. Fee is the LP fee, in the
    ///      input currency.
    event HookSwap(
        bytes32 indexed id,
        address indexed sender,
        int128 amount0,
        int128 amount1,
        uint128 hookLPfeeAmount0,
        uint128 hookLPfeeAmount1
    );
    event HookModifyLiquidity(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1);
    event Tipped(PoolId indexed id, address indexed to, uint256 x, uint256 y, uint256 eth);
    event Deposited(PoolId indexed id, address indexed owner, uint256 lot, uint256 shares, uint256 x, uint256 y);
    event Withdrawn(PoolId indexed id, address indexed owner, uint256 lot, uint256 x, uint256 y);
    event Restaked(PoolId indexed id, address indexed owner, uint256 fromLot, uint256 newLot);
    event Claimed(PoolId indexed id, address indexed to, uint256 x, uint256 y);
    event PriceAccepted(PoolId indexed id, uint256 anchorX128, uint64 observedAt, uint256 refund, bool recovered);
    event PriceRejected(PoolId indexed id, bytes32 guid);
    event LocalMode(PoolId indexed id, bool on);
    event TankFunded(PoolId indexed id, uint256 amount);
    event CreatorSet(PoolId indexed id, address creator, bool compounds);

    error OnlyPoolManager();
    error Reentrancy();
    error UnknownPool();
    error BadParams();
    error NotLive();
    error NoAnchor();
    error SameChain();
    error PendingTrades();
    error OnlyCreator();
    error LiquidityDisabled();
    error ExternalInit();
    error HookNotImplemented();
    error ZeroOutput();
    error OnlyBridge();
    /// @notice The result of `quote` (always reverted with).
    error Quote(uint256 amountIn, uint256 amountOut);

    modifier lock() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(
        IPoolManager manager_,
        address pushReceiver_,
        address v2Factory_,
        address v3Factory_,
        address weth_,
        Config memory cfg
    ) {
        if (address(manager_) == address(0) || cfg.minStep == 0 || cfg.minStep >= 1e6) {
            revert BadParams();
        }
        poolManager = manager_;
        pushReceiver = pushReceiver_;
        v2Factory = v2Factory_;
        v3Factory = v3Factory_;
        weth = weth_;
        minStep = cfg.minStep;
        refToken = cfg.refToken;
        refKind = cfg.refKind;
        refTarget = cfg.refTarget;
        refV4Id = cfg.refV4Id;
        refWethIs0 = cfg.refWethIs0;
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeAddLiquidity = true;
        p.beforeRemoveLiquidity = true;
        p.beforeSwap = true;
        p.beforeSwapReturnDelta = true;
    }

    // ---------------------------------------------------------------------------------------------
    // Pool creation
    // ---------------------------------------------------------------------------------------------

    /// @notice Create a pool. Same chain: the seed is trimmed to 50/50 by value at the source's current spot and
    ///         the rest refunded. Cross chain: both tokens are held until the first pushed price lands (any ETH sent
    ///         goes to the pool's tank); then the seed is trimmed the same way.
    function createPool(CreateParams calldata cp) external payable lock returns (PoolKey memory key, PoolId id) {
        address quote = cp.quote;
        if (cp.coin == address(0) || quote == address(0) || cp.coin == quote) revert BadParams();
        if (cp.fee == 0 || cp.fee > MAX_FEE || cp.coinIn == 0 || cp.quoteIn == 0) revert BadParams();
        Source calldata s = cp.src;
        if (s.kind < SRC_V2 || s.kind > SRC_V4 || s.kind2 > SRC_V4) revert BadParams();
        if (s.push != (s.remoteEid != 0) || (s.push && (pushReceiver == address(0) || s.kind2 != 0))) {
            revert BadParams();
        }
        // decimal shifts: zero on the same chain, bounded on a remote one (so a pool can never be stuck unpriced)
        if (s.remoteEid == 0 ? (s.decShift != 0 || s.tvlShift != 0) : (_badShift(s.decShift) || _badShift(s.tvlShift)))
        {
            revert BadParams();
        }

        address x1;
        if (s.remoteEid == 0) x1 = _checkSource(cp);

        bool coinIs0 = cp.coin < quote;
        (address c0, address c1) = coinIs0 ? (cp.coin, quote) : (quote, cp.coin);
        // the PoolManager refuses tickSpacing above 32767, and a wrapped value lands on an existing pool
        uint256 n = ++poolsOf[c0][c1];
        key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 0,
            tickSpacing: int24(int256(n)),
            hooks: IHooks(address(this))
        });
        id = key.toId();
        Pool storage p = pools[id];
        if (p.exists) revert BadParams();
        p.exists = true;
        p.coinIs0 = coinIs0;
        p.coin = cp.coin;
        p.quote = quote;
        p.fee = cp.fee;
        p.src = s;
        p.book.creator = msg.sender;

        if (s.remoteEid == 0) {
            if (msg.value != 0) revert SameChain();
            p.x = x1;
            if (s.kind == SRC_V4) {
                // the creator pays for a first full count; most pools finish inside it
                p.walk.spacing = cp.srcKey.tickSpacing;
                BK.walk(p.walk, poolManager, PoolId.wrap(s.v4Id), WALK_INIT_STEPS);
            }
            (uint256 spot,, uint256 s1) = _sourceSpot(p);
            if (spot == 0) revert NoAnchor();
            p.srcTvl = _sourceTvl(p, s1, spot);
            p.warmEnd = uint64(block.timestamp + WARM_UP);
            p.sampleX128 = spot;
            p.sampleBlock = uint64(block.number);
            p.sampleAt = uint64(block.timestamp);
            p.anchorX128 = spot;
            p.settledBlock = uint64(block.number);
            _goLive(id, p, cp.coinIn, cp.quoteIn, spot, msg.sender);
        } else {
            // held as plain ERC20 until the first price lands
            _pull(cp.coin, cp.coinIn);
            _pull(quote, cp.quoteIn);
            p.seedX = cp.coinIn;
            p.seedY = cp.quoteIn;
            // the first pushed price opens the pool; all ETH goes to the tank
            p.tank = msg.value;
        }

        poolManager.initialize(key, uint160(1 << 96));
        emit Created(id, cp.coin, quote, msg.sender, s.remoteEid, cp.fee);
    }

    /// @dev A same-chain source is real pools only: leg 1 holds the coin and X (the quote when there is no leg 2),
    ///      leg 2 holds X and the quote, each oriented as the source says. v2 / v3 are checked through their factory,
    ///      v4 through its key (never one of this hook's own pools). Native ETH counts as `weth`.
    function _checkSource(CreateParams calldata cp) internal view returns (address x1) {
        Source calldata s = cp.src;
        address a;
        (a, x1) = _legTokens(s.kind, s.target, s.v4Id, cp.srcKey, s.coinIs0);
        if (a != cp.coin) revert BadParams();
        address x = x1;
        if (s.kind2 != 0) {
            (address x2, address q) = _legTokens(s.kind2, s.target2, s.v4Id2, cp.srcKey2, s.xIs0);
            if (x2 != x) revert BadParams();
            x = q;
        }
        if (x != cp.quote) revert BadParams();
    }

    function _legTokens(uint8 kind, address target, bytes32 v4Id, PoolKey calldata k, bool baseIs0)
        internal
        view
        returns (address, address)
    {
        return BK.legTokens(kind, target, v4Id, k, baseIs0, weth, kind == SRC_V2 ? v2Factory : v3Factory);
    }

    /// @dev Trim the seed to 50/50 by value at `spot` and open the books. `from` pays the trimmed seed into the
    ///         pool's claims: the creator (same chain, nothing extra is taken) or this contract (cross chain, the
    ///         held seed; the excess goes back to the creator).
    function _goLive(PoolId id, Pool storage p, uint256 xIn, uint256 yIn, uint256 spot, address from) internal {
        uint256 x = xIn;
        uint256 y = Math.mulDiv(x, spot, Q128);
        if (y > yIn) {
            y = yIn;
            x = Math.mulDiv(y, Q128, spot);
        }
        if (x == 0 || y == 0) revert BadParams();
        address creator = p.book.creator;
        BK.init(p.book, creator, x, y, spot);
        p.tX128 = PR.recentre(x, y);
        p.live = true;
        _moves(_pair(p, x, y, from, true));
        _liq(id, p, creator, x, y, true);
        if (from == address(this)) {
            if (xIn > x) _push(p.coin, creator, xIn - x);
            if (yIn > y) _push(p.quote, creator, yIn - y);
        }
    }

    /// @notice The creator may hand the role to a new wallet and choose to compound their cut instead of being
    ///         paid. This is the only mutable setting.
    function setCreator(PoolId id, address creator, bool compounds) external lock {
        Pool storage p = _live(id);
        if (msg.sender != p.book.creator) revert OnlyCreator();
        if (creator == address(0)) revert BadParams();
        p.book.creator = creator;
        p.book.creatorCompounds = compounds;
        uint256 cl = p.book.creatorLot;
        if (cl != 0) p.book.lots[cl].owner = creator;
        emit CreatorSet(id, creator, compounds);
    }

    // ---------------------------------------------------------------------------------------------
    // Swaps
    // ---------------------------------------------------------------------------------------------

    function beforeSwap(address sender, PoolKey calldata key, IPoolManager.SwapParams calldata params, bytes calldata)
        external
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        if (_locked) revert Reentrancy();
        _locked = true;
        PoolId id = key.toId();
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        if (!p.live) revert NotLive();
        if (params.amountSpecified == 0) revert BadParams();

        (uint256 kb, uint256 ks, uint256 pb, uint256 ps) = _prepare(p, id);

        bool exactIn = params.amountSpecified < 0;
        uint256 spec = exactIn ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        if (spec > uint256(uint128(type(int128).max))) revert BadParams();
        // input is currency0 when zeroForOne; the input is the coin on a sell
        bool sell = params.zeroForOne == p.coinIs0;
        (uint256 coinAmt, uint256 quoteAmt) = _fill(p, sell, exactIn, spec, kb, ks, pb, ps);
        if (sell) p.book.swap(int256(coinAmt), -int256(quoteAmt));
        else p.book.swap(-int256(coinAmt), int256(quoteAmt));

        Currency coinC = Currency.wrap(p.coin);
        Currency quoteC = Currency.wrap(p.quote);
        Currency inC = sell ? coinC : quoteC;
        Currency outC = sell ? quoteC : coinC;
        uint256 inAmt = sell ? coinAmt : quoteAmt;
        uint256 outAmt = sell ? quoteAmt : coinAmt;
        // both sides must fit the int128 swap delta (scanner finding, 2026-11-04)
        if (inAmt > uint128(type(int128).max) || outAmt > uint128(type(int128).max)) revert BadParams();
        // claims only: the PoolManager need not hold the input token yet (the swapper pays after the hook runs)
        inC.take(poolManager, address(this), inAmt, true);
        outC.settle(poolManager, address(this), outAmt, true);

        {
            // input is currency0 when zeroForOne
            int128 i = int128(uint128(inAmt));
            int128 o = -int128(uint128(outAmt));
            uint128 f = uint128(Math.mulDiv(inAmt, p.fee, 1e6));
            (int128 a0, int128 a1, uint128 f0, uint128 f1) =
                params.zeroForOne ? (i, o, f, uint128(0)) : (o, i, uint128(0), f);
            emit HookSwap(PoolId.unwrap(id), sender, a0, a1, f0, f1);
        }
        _locked = false;
        // exact in: the specified currency is the input; exact out: it is the output
        BeforeSwapDelta delta = exactIn
            ? toBeforeSwapDelta(int128(uint128(inAmt)), -int128(uint128(outAmt)))
            : toBeforeSwapDelta(-int128(uint128(outAmt)), int128(uint128(inAmt)));
        return (IHooks.beforeSwap.selector, delta, 0);
    }

    /// @dev The curve fill against the current reserves: (coin, quote) amounts for `spec` in or out.
    function _fill(
        Pool storage p,
        bool sell,
        bool exactIn,
        uint256 spec,
        uint256 kb,
        uint256 ks,
        uint256 pb,
        uint256 ps
    ) internal view returns (uint256 coinAmt, uint256 quoteAmt) {
        uint256 u = p.book.x;
        uint256 v = p.book.y;
        if (sell) {
            (coinAmt, quoteAmt) =
                exactIn ? (spec, SM.sellExactIn(u, v, ks, ps, spec)) : (SM.sellExactOut(u, v, ks, ps, spec), spec);
        } else {
            (quoteAmt, coinAmt) =
                exactIn ? (spec, SM.buyExactIn(u, v, kb, pb, spec)) : (SM.buyExactOut(u, v, kb, pb, spec), spec);
        }
        if (quoteAmt == 0 || coinAmt == 0) revert ZeroOutput();
    }

    /// @notice Exact quote for a swap on pool `id`, for routers and front ends. Use it with eth_call: it runs
    ///         the same first-touch work as a real swap (the price latch and, if due, the settle), prices the
    ///         fill against the live source, then ALWAYS reverts with `Quote(amountIn, amountOut)`, so nothing
    ///         it did is kept. `zeroForOne` and `amountSpecified` mean what they do in a v4 swap (negative =
    ///         exact in). The result matches a swap sent in the same block against the same state.
    function quote(PoolId id, bool zeroForOne, int256 amountSpecified) external lock {
        Pool storage p = _live(id);
        if (amountSpecified == 0 || amountSpecified == type(int256).min) revert BadParams();
        (uint256 kb, uint256 ks, uint256 pb, uint256 ps) = _prepare(p, id);
        bool exactIn = amountSpecified < 0;
        bool sell = zeroForOne == p.coinIs0;
        (uint256 c, uint256 q) =
            _fill(p, sell, exactIn, uint256(exactIn ? -amountSpecified : amountSpecified), kb, ks, pb, ps);
        (uint256 i, uint256 o) = sell ? (c, q) : (q, c);
        revert Quote(i, o);
    }

    /// @notice Refresh a same-chain pool's source price sample without a trade. Anyone may call. The first call
    ///         in a block steps the anchor toward the previous sample and records the live one. It does not settle,
    ///         observe source TVL, or move graduation. While the centre is at least 1% from the leader the caller
    ///         is paid gas + 20% from the pool's tip jar (or, if the quote cannot be valued in ETH, its tank).
    function sample(PoolId id) external lock {
        uint256 g0 = gasleft();
        Pool storage p = _known(id);
        if (p.src.remoteEid != 0) revert BadParams();
        if (!p.live) revert NotLive();
        if (p.sampleBlock >= block.number) return;
        uint256 a0 = p.anchorX128;
        (uint256 spot,) = _latchSame(p, false);
        if (!SM.movedBeyond(a0, spot, DUE_BPS)) return;
        uint256 w = (g0 - gasleft() + TIP_OVERHEAD) * block.basefee * 12 / 10;
        uint256 q = _weiToQuote(p, w);
        uint256 cx;
        uint256 cy;
        uint256 eth;
        if (q == 0) {
            eth = w < MAX_PUSH_REFUND ? w : MAX_PUSH_REFUND;
            if (eth > p.tank) eth = p.tank;
            p.tank -= eth;
        } else {
            (cx, cy) = BK.tip(p.jarX, p.jarY, a0, q, TIP_DIV);
            p.jarX -= cx;
            p.jarY -= cy;
            _moves(_pair(p, cx, cy, msg.sender, false));
        }
        if (eth > 0) {
            (bool sent,) = msg.sender.call{value: eth, gas: 30_000}("");
            if (!sent) {
                p.tank += eth;
                eth = 0;
            }
        }
        emit Tipped(id, msg.sender, cx, cy, eth);
    }

    /// @dev `w` wei in the pool's quote, at the pool's centre and the reference pool (0 = cannot value).
    function _weiToQuote(Pool storage p, uint256 w) internal view returns (uint256) {
        address q = p.quote;
        address c = p.coin;
        if (q == weth) return w;
        bool viaRef = q == refToken || c == refToken;
        if (viaRef) {
            if (refKind == 0) return 0;
            (uint256 r,) = _leg(refKind, refTarget, refV4Id, refWethIs0);
            w = Math.mulDiv(w, r, Q128);
            if (q == refToken) return w;
        } else if (c != weth) {
            return 0;
        }
        return Math.mulDiv(w, p.anchorX128, Q128);
    }

    /// @dev Room left in the jar, in quote raw: JAR_TIPS reference tips at today's basefee, less what it holds.
    function _jarRoom(Pool storage p) internal view returns (uint256) {
        uint256 cap = _weiToQuote(p, JAR_TIPS * TIP_GAS_REF * block.basefee * 12 / 10);
        uint256 have = Math.mulDiv(p.jarX, p.anchorX128, Q128) + p.jarY;
        return cap > have ? cap - have : 0;
    }

    /// @dev Close a same-chain interval at `mark`, skimming into the jar.
    function _settleSame(Pool storage p, uint256 mark) internal {
        (uint256 tOn, uint256 tOff, uint256 tg) = _judge(p);
        (uint256 jx, uint256 jy) = BK.settle(p.book, mark, tOn, tOff, tg, true, _jarRoom(p));
        p.jarX += jx;
        p.jarY += jy;
    }

    /// @dev The anchor the next latch would set: one step from the anchor toward the newest sample.
    function _stepped(Pool storage p) internal view returns (uint256) {
        uint24 st = p.fee > minStep ? p.fee : minStep;
        return SM.stepToward(p.anchorX128, p.sampleX128, st);
    }

    /// @dev Settle the books if due, update the anchor state, and return the curve slopes and boundaries.
    function _prepare(Pool storage p, PoolId id) internal returns (uint256 kb, uint256 ks, uint256 pb, uint256 ps) {
        if (p.src.remoteEid == 0) return _prepareSame(p);
        return _prepareCross(p, id);
    }

    function _prepareSame(Pool storage p) internal returns (uint256 kb, uint256 ks, uint256 pb, uint256 ps) {
        (uint256 spot, uint24 srcFee) = _latchSame(p, true);
        return BK.sameQuote(p.anchorX128, p.tX128, p.fee, spot, srcFee);
    }

    /// @dev Same chain, first price touch of a block: step the anchor toward the newest source sample taken in an
    ///      earlier block (at most max(fee, minStep) per reading). Then record the live source for the next block. `settleBooks` (swaps and capital changes) also walks a v4 source,
    ///      observes TVL, and settles the open interval. sample() passes false, so it cannot graduate a pool.
    ///      Returns the live spot and the source fee for the match boundary.
    function _latchSame(Pool storage p, bool settleBooks) internal returns (uint256 spot, uint24 srcFee) {
        uint256 s1;
        (spot, srcFee, s1) = _sourceSpot(p);
        if (spot == 0) revert NoAnchor();
        if (p.sampleBlock < block.number) {
            p.anchorX128 = _stepped(p);
            p.sampleX128 = spot;
            p.sampleBlock = uint64(block.number);
            p.sampleAt = uint64(block.timestamp);
        }
        if (settleBooks && p.settledBlock < block.number) {
            Source storage s = p.src;
            if (s.kind == SRC_V4) BK.walk(p.walk, poolManager, PoolId.wrap(s.v4Id), WALK_STEPS);
            uint256 tvl = _sourceTvl(p, s1, spot);
            // a v4 source's TVL is a new reading only when the counter finished a pass in this block
            _observe(p, tvl, s.kind != SRC_V4 || !p.walk.active);
            _settleSame(p, p.anchorX128);
            p.settledBlock = uint64(block.number);
        }
    }

    function _prepareCross(Pool storage p, PoolId id)
        internal
        returns (uint256 kb, uint256 ks, uint256 pb, uint256 ps)
    {
        uint256 a = p.anchorX128;
        uint256 age = block.timestamp - p.obsAt;
        if (age >= PR.LOCAL_AFTER && !p.local) {
            // the feed is treated as down: re-centre on the reserves and keep trading on the curve
            p.local = true;
            p.tX128 = PR.recentre(p.book.x, p.book.y);
            emit LocalMode(id, true);
        }
        (uint256 g, bool bandOn) = PR.markup(p.fee, age);
        (kb, ks) = SM.slopes(a, p.tX128, g, g);
        (pb, ps) = PR.band(a, g, bandOn);
    }

    /// @notice Top up a pool's refresh tank (anyone; a TJAR releaser can point here through a PoolTank).
    function fundTank(PoolId id) external payable {
        Pool storage p = _known(id);
        p.tank += msg.value;
        emit TankFunded(id, msg.value);
    }

    /// @notice A pushed price over LayerZero (caller = pushReceiver, `srcEid` = the home chain, which must be the
    ///         pool's). The name is kept for the receiver's interface. The sender read the source itself in the same
    ///         transaction,
    ///         so `a`/`b` are raw source state (v2: reserve0, reserve1; v3/v4: sqrtPriceX96, liquidity) observed at
    ///         `observedAt`. The source fields must match the pool's. Order and replay: only an observation newer
    ///         than the last accepted one is taken; a late or replayed message is ignored.
    function onBridgePrice(
        PoolId id,
        uint32 srcEid,
        uint8 kind,
        address target,
        bytes32 v4Id,
        uint256 a,
        uint256 b,
        uint64 observedAt,
        address keeper,
        uint256 keeperCost
    ) external {
        if (pushReceiver == address(0) || msg.sender != pushReceiver) revert OnlyBridge();
        if (_locked) revert Reentrancy();
        _locked = true;
        Pool storage p = pools[id];
        Source storage s = p.src;
        uint256 price;
        uint256 tvl;
        bool route = s.push && s.remoteEid == srcEid;
        // a pushed v3/v4 state must fit (sqrtPriceX96, liquidity); anything larger is refused, never truncated
        bool fits = kind == SRC_V2 || (a <= type(uint160).max && b <= type(uint128).max);
        if (p.exists && route && fits && s.kind == kind && s.target == target && s.v4Id == v4Id) {
            (price, tvl) = BK.pushed(s.kind == SRC_V2, a, b, s.coinIs0);
            price = _shift(s.decShift, price);
            tvl = _shift(s.tvlShift, tvl);
        }
        uint256 ageAtSend = p.live && observedAt > p.obsAt ? observedAt - p.obsAt : 0;
        if (keeperCost > MAX_PUSH_REFUND) keeperCost = MAX_PUSH_REFUND;
        _accept(p, id, price, tvl, observedAt, keeper, keeperCost, ageAtSend, PUSH_RECOVERY_AGE);
        _locked = false;
    }

    /// @dev Take a delivered observation: first price opens the pool; otherwise the update or recovery gate, the
    ///      deferred-mark settle, re-centre on recovery, and the keeper refund (cost * 1.2 if due) from the tank.
    function _accept(
        Pool storage p,
        PoolId id,
        uint256 price,
        uint256 tvl,
        uint64 observedAt,
        address keeper,
        uint256 cost,
        uint256 ageAtRequest,
        uint256 maxRecoveryAge
    ) internal {
        if (price == 0 || !p.exists) {
            emit PriceRejected(id, bytes32(0));
            return;
        }
        if (!p.live) {
            if (observedAt > block.timestamp) {
                emit PriceRejected(id, bytes32(0));
                return;
            }
            p.anchorX128 = price;
            p.obsAt = observedAt;
            p.srcTvl = tvl;
            p.warmEnd = uint64(block.timestamp + WARM_UP);
            uint256 sx = p.seedX;
            uint256 sy = p.seedY;
            p.seedX = 0;
            p.seedY = 0;
            _goLive(id, p, sx, sy, price, address(this));
            emit PriceAccepted(id, price, observedAt, 0, false);
            return;
        }
        bool wasLocal = p.local;
        bool ok = wasLocal
            ? PR.recoveryOkWithin(observedAt, p.obsAt, block.timestamp, maxRecoveryAge)
            : PR.updateOk(observedAt, p.obsAt, block.timestamp);
        if (!ok) {
            emit PriceRejected(id, bytes32(0));
            return;
        }
        // a heartbeat is paid only if the pool traded since the last price (maker, 2026-11-04); a 1% move always
        if (p.book.dx == 0 && p.book.dy == 0) ageAtRequest = 0;
        // close the interval at the fresh mark (deferred mark); local-mode results stay pro rata
        _observe(p, tvl, true);
        (uint256 tOn, uint256 tOff, uint256 tg) = _judge(p);
        BK.settle(p.book, price, tOn, tOff, tg, !wasLocal, 0);
        uint256 old = p.anchorX128;
        p.anchorX128 = price;
        p.obsAt = observedAt;
        if (wasLocal) {
            p.local = false;
            p.tX128 = PR.recentre(p.book.x, p.book.y);
            emit LocalMode(id, false);
        }
        uint256 refund;
        if (keeper != address(0)) {
            refund = PR.refund(old, price, ageAtRequest, cost);
            if (refund > p.tank) refund = p.tank;
            if (refund > 0) {
                p.tank -= refund;
                (bool sent,) = keeper.call{value: refund, gas: 30_000}("");
                if (!sent) {
                    p.tank += refund;
                    refund = 0;
                }
            }
        }
        emit PriceAccepted(id, price, observedAt, refund, wasLocal);
    }

    /// @dev v * 10^sh; |sh| <= MAX_SHIFT (checked at creation). An overflowing product reads as 0 (refused).
    function _shift(int8 sh, uint256 v) internal pure returns (uint256) {
        if (sh < 0) return v / 10 ** uint8(-sh);
        if (sh == 0) return v;
        uint256 m = 10 ** uint8(sh);
        return v > type(uint256).max / m ? 0 : v * m;
    }

    function _badShift(int8 sh) internal pure returns (bool) {
        return sh > MAX_SHIFT || sh < -MAX_SHIFT;
    }

    /// @dev Source TVL against manipulation (review D-02). Spot TVL can be pushed down or up for one transaction,
    ///      so no single reading decides anything:
    ///      - graduation is judged against the higher of the last two readings, so a dip must be seen twice in a
    ///        row and a spike delays it by at most two readings;
    ///      - the creator cut has hysteresis. It turns on only against the higher of the last two readings and a
    ///        memory (the highest reading confirmed by the next one, the lower of two in a row, fading linearly to 0
    ///        over TVL_MEMORY of real time). It turns off only against the lower of the last two readings. So one
    ///        spike or one dip does nothing to it; two spikes in a row turn it off for at most TVL_MEMORY; turning it
    ///        on by dips takes no honest pair of readings for TVL_MEMORY, then two dips in a row, and it stays on
    ///        until two honest readings in a row.
    ///      The launch reading never counts, and nothing is judged before two later readings and the end of the
    ///      warm-up. Same chain v4: one reading per finished counter pass (the cached total is not new evidence).
    function _observe(Pool storage p, uint256 cur, bool fresh) internal {
        if (cur == 0 || !fresh) return;
        uint256 prev = p.srcTvl;
        p.prevTvl = prev;
        p.srcTvl = cur;
        uint8 n = p.seen;
        if (n < 2) p.seen = ++n;
        if (n < 2) return;
        uint256 m = cur < prev ? cur : prev;
        if (m >= _rec(p)) {
            p.recTvl = m;
            p.recAt = uint64(block.timestamp);
        }
    }

    function _rec(Pool storage p) internal view returns (uint256) {
        uint256 age = block.timestamp - p.recAt;
        return age >= TVL_MEMORY ? 0 : Math.mulDiv(p.recTvl, TVL_MEMORY - age, TVL_MEMORY);
    }

    /// @dev TVLs for the ledger; all 0 = not judged yet (warm-up, too few readings). The creator cut turns on only
    ///      if both of the last two readings and the memory allow it, and off only if both readings say so.
    function _judge(Pool storage p) internal view returns (uint256 on, uint256 off, uint256 g) {
        if (block.timestamp < p.warmEnd || p.seen < 2) return (0, 0, 0);
        (g, off) = p.srcTvl > p.prevTvl ? (p.srcTvl, p.prevTvl) : (p.prevTvl, p.srcTvl);
        on = _rec(p);
        if (g > on) on = g;
    }

    // ---------------------------------------------------------------------------------------------
    // LP actions
    // ---------------------------------------------------------------------------------------------

    /// @notice Add both tokens at the current reserve ratio; the lot joins the back of the boost line.
    ///         Unused tokens stay with the caller.
    function deposit(PoolId id, uint256 maxX, uint256 maxY) external lock returns (uint256 lot, uint256 shares) {
        Pool storage p = _live(id);
        _settleForCapital(p);
        uint256 tx_;
        uint256 ty_;
        (lot, shares, tx_, ty_) = BK.deposit(p.book, msg.sender, maxX, maxY);
        if (shares == 0) revert ZeroOutput();
        _moves(_pair(p, tx_, ty_, msg.sender, true));
        _liq(id, p, msg.sender, tx_, ty_, true);
        emit Deposited(id, msg.sender, lot, shares, tx_, ty_);
    }

    /// @notice Burn principal shares `s` and compound balance `bal` from a lot, paid in both tokens pro rata.
    function withdraw(PoolId id, uint256 lot, uint256 s, uint256 bal) external lock returns (uint256 x, uint256 y) {
        Pool storage p = _live(id);
        // Same chain settles first. Cross chain exits mid-interval at actual reserves (which already hold its share
        // of the open trades) and forfeits the interval: the open flows shrink with the capital that left, so the
        // remaining LPs are later credited only their own share (review D-01).
        if (p.src.remoteEid == 0) {
            _settleForCapital(p);
            (x, y) = BK.withdraw(p.book, lot, msg.sender, s, bal);
        } else {
            uint256 st = p.book.sp + p.book.b;
            (x, y) = BK.withdraw(p.book, lot, msg.sender, s, bal);
            uint256 left = p.book.sp + p.book.b;
            p.book.dx = p.book.dx * int256(left) / int256(st);
            p.book.dy = p.book.dy * int256(left) / int256(st);
        }
        _moves(_pair(p, x, y, msg.sender, false));
        _liq(id, p, msg.sender, x, y, false);
        emit Withdrawn(id, msg.sender, lot, x, y);
    }

    /// @notice Move a lot's compounded balance into a new principal lot at the back of the line.
    function restake(PoolId id, uint256 lot) external lock returns (uint256 newLot) {
        Pool storage p = _live(id);
        _settleForCapital(p);
        newLot = BK.restake(p.book, lot, msg.sender);
        emit Restaked(id, msg.sender, lot, newLot);
    }

    /// @notice Collect a lot's escrowed payouts (after graduation).
    function claim(PoolId id, uint256 lot) external lock returns (uint256 x, uint256 y) {
        Pool storage p = _live(id);
        (x, y) = BK.claim(p.book, lot, msg.sender);
        _moves(_pair(p, x, y, msg.sender, false));
        emit Claimed(id, msg.sender, x, y);
    }

    /// @notice Collect the creator's cut (when not compounding). Paid to the current creator wallet.
    function claimCreator(PoolId id) external lock returns (uint256 x, uint256 y) {
        Pool storage p = _live(id);
        (x, y) = BK.claimCreator(p.book);
        address to = p.book.creator;
        _moves(_pair(p, x, y, to, false));
        emit Claimed(id, to, x, y);
    }

    function _settleForCapital(Pool storage p) internal {
        if (p.src.remoteEid == 0) {
            _latchSame(p, true);
            // trades earlier in this block: close them now, at the mark the next block would use (one step toward
            // this block's sample), so capital joining or leaving never shares in fees earned before it (review D-01)
            if (p.book.dx != 0 || p.book.dy != 0) _settleSame(p, _stepped(p));
        } else if (p.book.dx != 0 || p.book.dy != 0 || p.local) {
            // cross chain: open trades are marked at the next fresh price; join after it lands
            revert PendingTrades();
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    struct PoolView {
        address coin;
        address quote;
        bool live;
        bool local;
        bool graduated;
        bool creatorOn;
        uint256 coinReserve;
        uint256 quoteReserve;
        uint256 anchorX128;
        uint256 ageOrBlock;
        uint256 tank;
        uint256 srcTvl;
        uint256 principal;
        uint256 compounded;
        uint256 lots;
        uint64 sampleAt;
        uint256 jarX;
        uint256 jarY;
    }

    function poolState(PoolId id) external view returns (PoolView memory v) {
        Pool storage p = _known(id);
        LG.Book storage b = p.book;
        v.coin = p.coin;
        v.quote = p.quote;
        v.live = p.live;
        v.local = p.local;
        v.graduated = b.graduated;
        v.creatorOn = b.creatorOn;
        v.coinReserve = b.x;
        v.quoteReserve = b.y;
        v.anchorX128 = p.anchorX128;
        v.ageOrBlock = p.src.remoteEid == 0 ? p.settledBlock : block.timestamp - p.obsAt;
        v.tank = p.tank;
        v.srcTvl = p.srcTvl;
        v.principal = b.sp;
        v.compounded = b.b;
        v.lots = b.count;
        v.sampleAt = p.sampleAt;
        v.jarX = p.jarX;
        v.jarY = p.jarY;
    }

    /// @notice Lot info. Call from a static context for up-to-date figures (it checkpoints the lot).
    function lotState(PoolId id, uint256 lot)
        external
        returns (address owner, uint256 principal, uint256 compounded, uint256 claimX, uint256 claimY)
    {
        Pool storage p = _live(id);
        (principal, compounded, claimX, claimY) = BK.poke(p.book, lot);
        owner = p.book.lots[lot].owner;
    }

    // ---------------------------------------------------------------------------------------------
    // Source reads
    // ---------------------------------------------------------------------------------------------

    /// @dev Same-chain source spot (X128 quote raw per coin raw), its fee in pips, and leg 1's own spot (X raw
    ///      per coin raw). Two-hop: spot = leg 1 x leg 2, fee = both legs' fees compounded (rounded up).
    function _sourceSpot(Pool storage p) internal view returns (uint256 spot, uint24 fee, uint256 s1) {
        Source storage s = p.src;
        (spot, fee) = _leg(s.kind, s.target, s.v4Id, s.coinIs0);
        s1 = spot;
        if (s.kind2 != 0) {
            (uint256 s2, uint24 f2) = _leg(s.kind2, s.target2, s.v4Id2, s.xIs0);
            spot = Math.mulDiv(spot, s2, Q128);
            uint256 f = uint256(fee) + f2 - uint256(fee) * f2 / 1e6;
            fee = f >= 1e6 ? 999_999 : uint24(f);
        }
    }

    function _leg(uint8 kind, address target, bytes32 v4Id, bool baseIs0)
        internal
        view
        returns (uint256 spot, uint24 fee)
    {
        return BK.leg(poolManager, kind, target, v4Id, baseIs0);
    }

    /// @dev Same-chain source TVL in quote raw: the real tokens in leg 1, valued at leg 1's spot `s1`, converted to
    ///      the quote at the full spot for two-hop. v2: its reserves. v3: the pool's token balances (what Uniswap
    ///      shows; unclaimed fees make it read slightly high). v4: the depth counter's last finished pass (0 until
    ///      the first pass finishes, which leaves graduation as it is).
    function _sourceTvl(Pool storage p, uint256 s1, uint256 spot) internal view returns (uint256 tvl) {
        Source storage s = p.src;
        uint256 b;
        uint256 o;
        if (s.kind == SRC_V2) {
            (uint112 r0, uint112 r1,) = IV2PairLike(s.target).getReserves();
            (b, o) = s.coinIs0 ? (r0, r1) : (r1, r0);
        } else if (s.kind == SRC_V3) {
            b = IERC20Minimal(p.coin).balanceOf(s.target);
            o = IERC20Minimal(p.x).balanceOf(s.target);
        } else {
            DP.Walk storage w = p.walk;
            if (!w.done) return 0;
            (b, o) = s.coinIs0 ? (w.tot0, w.tot1) : (w.tot1, w.tot0);
        }
        tvl = Math.mulDiv(b, s1, Q128) + o;
        if (s.kind2 != 0) tvl = Math.mulDiv(tvl, spot, s1);
    }

    // ---------------------------------------------------------------------------------------------
    // Hook plumbing
    // ---------------------------------------------------------------------------------------------

    function beforeInitialize(address, PoolKey calldata, uint160) external view returns (bytes4) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        revert ExternalInit();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert LiquidityDisabled();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert LiquidityDisabled();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    receive() external payable {}

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _known(PoolId id) internal view returns (Pool storage p) {
        p = pools[id];
        if (!p.exists) revert UnknownPool();
    }

    function _live(PoolId id) internal view returns (Pool storage p) {
        p = _known(id);
        if (!p.live) revert NotLive();
    }

    /// @dev HookModifyLiquidity in currency order; `add` = into the pool.
    function _liq(PoolId id, Pool storage p, address who, uint256 x, uint256 y, bool add) internal {
        int128 a = int128(uint128(x));
        int128 b = int128(uint128(y));
        if (!add) (a, b) = (-a, -b);
        if (!p.coinIs0) (a, b) = (b, a);
        emit HookModifyLiquidity(PoolId.unwrap(id), who, a, b);
    }

    function _pair(Pool storage p, uint256 x, uint256 y, address who, bool into)
        internal
        view
        returns (Move[] memory m)
    {
        m = new Move[](2);
        m[0] = Move(p.coin, who, x, into);
        m[1] = Move(p.quote, who, y, into);
    }

    /// @dev Run token movements between ERC20 and the pool's claims in one PoolManager unlock.
    function _moves(Move[] memory m) internal {
        poolManager.unlock(abi.encode(m));
    }

    /// @notice PoolManager callback for `_moves`. Only reachable through this contract's own `unlock` call.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        Move[] memory m = abi.decode(data, (Move[]));
        for (uint256 i = 0; i < m.length; i++) {
            Move memory mv = m[i];
            if (mv.amt == 0) continue;
            Currency c = Currency.wrap(mv.token);
            if (mv.into) {
                c.settle(poolManager, mv.who, mv.amt, false);
                c.take(poolManager, address(this), mv.amt, true);
            } else {
                c.settle(poolManager, address(this), mv.amt, true);
                c.take(poolManager, mv.who, mv.amt, false);
            }
        }
        return "";
    }

    function _pull(address token, uint256 amt) internal {
        if (amt == 0) return;
        if (!IERC20Minimal(token).transferFrom(msg.sender, address(this), amt)) revert BadParams();
    }

    function _push(address token, address to, uint256 amt) internal {
        if (amt == 0) return;
        if (!IERC20Minimal(token).transfer(to, amt)) revert BadParams();
    }
}
