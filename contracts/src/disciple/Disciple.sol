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
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IV2FactoryLike {
    function getPair(address, address) external view returns (address);
}

interface IV3FactoryLike {
    function getPool(address, address, uint24) external view returns (address);
}

interface IV3PoolLike {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
    function fee() external view returns (uint24);
}

/// @title Disciple
/// @notice A Uniswap v4 hook that runs small coin/quote pools priced off an anchor from a source pool.
///         One deployment serves many pools. Permissionless: anyone creates a pool against any source.
///
///         Same chain (beside a v2, v3 or v4 source on this chain): the anchor is latched once per block from
///         the source's spot as seen in an earlier block, a 4% premium fades linearly over 30 s after the anchor
///         moves 0.25%, and every fill respects the live source boundary (ask >= source ask * 0.9999,
///         bid <= source bid * 1.0001).
///
///         Cross chain (new chain, anchor pushed from the home chain over LayerZero by a DisciplePushSender there
///         and authenticated by the DisciplePushReceiver here): the anchor is the last accepted push. Keepers push on
///         a 1% home move or a 59.5-min heartbeat and are refunded their cost plus 20% from the pool's ETH tank (a
///         heartbeat only if the pool traded since the last price). lzRead and the rollup-bridge route were cut
///         from v0 (maker, 2026-11-04). The spread widens after 60 min; after 2 h the pool enters local mode (re-centres, drops the band,
///         keeps trading). A fresh read under 120 s old ends local mode and re-centres again. The pool never
///         stops trading.
///
///         Curve and fills: DiscipleSwapMath. Price rules: DisciplePrice. LP books: DiscipleLedger.
///         v4 concentrated liquidity is disabled; every swap is quoted in `beforeSwap`.
///         Custody: pool liquidity is held as the hook's ERC-6909 claims inside the PoolManager, so a swap only
///         mints and burns claims. Deposits, withdrawals and claims convert to and from ERC20 in one unlock.
contract Disciple is IHooks, IUnlockCallback {
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
    /// @dev Same-chain premium: 4% fading linearly over 30 s, reset when the anchor moves 0.25% from the reference.
    uint256 internal constant PREMIUM = 4e16;
    uint256 internal constant PREMIUM_TAU = 30;
    uint256 internal constant PREMIUM_RESET_BPS = 25;
    /// @dev Same-chain match edge: 1 bp inside the source's quotes.
    uint256 internal constant MATCH_EDGE_BPS = 1;
    /// @dev Pool fee bounds, in pips.
    uint24 internal constant MAX_FEE = 100_000;
    /// @dev v4 source depth counter: storage reads per block (first touch) and at createPool (creator pays).
    uint256 internal constant WALK_STEPS = 4;
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
        int8 decShift; // cross chain: price * 10^decShift converts home raw units to local raw units
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
        uint256 premRefX128; // same chain premium reset reference
        uint64 premAt;
        uint256 srcTvl; // source TVL in quote raw (graduation); 0 = not known yet
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
    event Swapped(PoolId indexed id, address indexed sender, bool buy, uint256 coinAmt, uint256 quoteAmt);
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
        address weth_
    ) {
        if (address(manager_) == address(0)) revert BadParams();
        poolManager = manager_;
        pushReceiver = pushReceiver_;
        v2Factory = v2Factory_;
        v3Factory = v3Factory_;
        weth = weth_;
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
            p.sampleX128 = spot;
            p.sampleBlock = uint64(block.number);
            p.anchorX128 = spot;
            p.premRefX128 = spot;
            p.premAt = uint64(block.timestamp);
            p.settledBlock = uint64(block.number);
            _goLive(p, cp.coinIn, cp.quoteIn, spot, msg.sender);
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

    /// @dev A verified pool's (base, other) tokens, native ETH mapped to `weth`.
    function _legTokens(uint8 kind, address target, bytes32 v4Id, PoolKey calldata k, bool baseIs0)
        internal
        view
        returns (address base, address other)
    {
        address t0;
        address t1;
        if (kind == SRC_V4) {
            if (keccak256(abi.encode(k)) != v4Id || address(k.hooks) == address(this)) revert BadParams();
            (t0, t1) = (Currency.unwrap(k.currency0), Currency.unwrap(k.currency1));
        } else {
            t0 = IV2PairLike(target).token0();
            t1 = IV2PairLike(target).token1();
            // a zero factory has no code, so the call reverts: that source kind is off
            address real = kind == SRC_V2
                ? IV2FactoryLike(v2Factory).getPair(t0, t1)
                : IV3FactoryLike(v3Factory).getPool(t0, t1, IV3PoolLike(target).fee());
            if (real != target) revert BadParams();
        }
        if (t0 == address(0)) t0 = weth;
        (base, other) = baseIs0 ? (t0, t1) : (t1, t0);
    }

    /// @dev Trim the seed to 50/50 by value at `spot` and open the books. `from` pays the trimmed seed into the
    ///         pool's claims: the creator (same chain, nothing extra is taken) or this contract (cross chain, the
    ///         held seed; the excess goes back to the creator).
    function _goLive(Pool storage p, uint256 xIn, uint256 yIn, uint256 spot, address from) internal {
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
        uint256 u = p.book.x;
        uint256 v = p.book.y;
        uint256 coinAmt;
        uint256 quoteAmt;
        if (sell) {
            if (exactIn) {
                coinAmt = spec;
                quoteAmt = SM.sellExactIn(u, v, ks, ps, spec);
            } else {
                quoteAmt = spec;
                coinAmt = SM.sellExactOut(u, v, ks, ps, spec);
            }
            if (quoteAmt == 0 || coinAmt == 0) revert ZeroOutput();
            p.book.swap(int256(coinAmt), -int256(quoteAmt));
        } else {
            if (exactIn) {
                quoteAmt = spec;
                coinAmt = SM.buyExactIn(u, v, kb, pb, spec);
            } else {
                coinAmt = spec;
                quoteAmt = SM.buyExactOut(u, v, kb, pb, spec);
            }
            if (quoteAmt == 0 || coinAmt == 0) revert ZeroOutput();
            p.book.swap(-int256(coinAmt), int256(quoteAmt));
        }

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

        emit Swapped(id, sender, !sell, coinAmt, quoteAmt);
        _locked = false;
        // exact in: the specified currency is the input; exact out: it is the output
        BeforeSwapDelta delta = exactIn
            ? toBeforeSwapDelta(int128(uint128(inAmt)), -int128(uint128(outAmt)))
            : toBeforeSwapDelta(-int128(uint128(outAmt)), int128(uint128(inAmt)));
        return (IHooks.beforeSwap.selector, delta, 0);
    }

    /// @dev Settle the books if due, update the anchor state, and return the curve slopes and boundaries.
    function _prepare(Pool storage p, PoolId id) internal returns (uint256 kb, uint256 ks, uint256 pb, uint256 ps) {
        if (p.src.remoteEid == 0) return _prepareSame(p);
        return _prepareCross(p, id);
    }

    function _prepareSame(Pool storage p) internal returns (uint256 kb, uint256 ks, uint256 pb, uint256 ps) {
        (uint256 spot, uint24 srcFee) = _latchSame(p);
        uint256 a = p.anchorX128;
        if (SM.movedBeyond(p.premRefX128, a, PREMIUM_RESET_BPS)) {
            p.premRefX128 = a;
            p.premAt = uint64(block.timestamp);
        }
        uint256 h = SM.premium(PREMIUM, PREMIUM_TAU, block.timestamp - p.premAt);
        uint256 g = SM.markup(h, p.fee);
        (kb, ks) = SM.slopes(a, p.tX128, g);
        uint256 srcAsk = Math.mulDiv(spot, 1e6, 1e6 - srcFee, Math.Rounding.Ceil);
        uint256 srcBid = Math.mulDiv(spot, 1e6 - srcFee, 1e6);
        (pb, ps) = SM.matchBounds(srcAsk, srcBid, MATCH_EDGE_BPS);
    }

    /// @dev Same chain, first touch of a block (swap or capital change): latch the newest source sample taken in
    ///      an earlier block as the anchor and settle the last interval at it. Then sample the live source for the
    ///      next block. Returns the live spot and the source fee for the match boundary.
    function _latchSame(Pool storage p) internal returns (uint256 spot, uint24 srcFee) {
        uint256 s1;
        (spot, srcFee, s1) = _sourceSpot(p);
        if (spot == 0) revert NoAnchor();
        if (p.sampleBlock < block.number) {
            Source storage s = p.src;
            if (s.kind == SRC_V4) BK.walk(p.walk, poolManager, PoolId.wrap(s.v4Id), WALK_STEPS);
            uint256 tvl = _sourceTvl(p, s1, spot);
            p.anchorX128 = p.sampleX128;
            p.srcTvl = tvl;
            BK.settle(p.book, p.anchorX128, tvl, true);
            p.settledBlock = uint64(block.number);
            p.sampleX128 = spot;
            p.sampleBlock = uint64(block.number);
        }
    }

    function _prepareCross(Pool storage p, PoolId id) internal returns (uint256 kb, uint256 ks, uint256 pb, uint256 ps) {
        uint256 a = p.anchorX128;
        uint256 age = block.timestamp - p.obsAt;
        if (age >= PR.LOCAL_AFTER && !p.local) {
            // the feed is treated as down: re-centre on the reserves and keep trading on the curve
            p.local = true;
            p.tX128 = PR.recentre(p.book.x, p.book.y);
            emit LocalMode(id, true);
        }
        (uint256 g, bool bandOn) = PR.markup(p.fee, age);
        (kb, ks) = SM.slopes(a, p.tX128, g);
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
            (price, tvl) = s.kind == SRC_V2 ? _v2(a, b, s.coinIs0) : _concentrated(uint160(a), uint128(b), s.coinIs0);
            (price, tvl) = _shift(s.decShift, price, tvl);
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
            uint256 sx = p.seedX;
            uint256 sy = p.seedY;
            p.seedX = 0;
            p.seedY = 0;
            _goLive(p, sx, sy, price, address(this));
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
        BK.settle(p.book, price, tvl, !wasLocal);
        uint256 old = p.anchorX128;
        p.anchorX128 = price;
        p.obsAt = observedAt;
        p.srcTvl = tvl;
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

    function _shift(int8 sh, uint256 price, uint256 tvl) internal pure returns (uint256, uint256) {
        if (sh > 0) return (price * 10 ** uint8(sh), tvl * 10 ** uint8(sh));
        if (sh < 0) return (price / 10 ** uint8(-sh), tvl / 10 ** uint8(-sh));
        return (price, tvl);
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
        emit Deposited(id, msg.sender, lot, shares, tx_, ty_);
    }

    /// @notice Burn principal shares `s` and compound balance `bal` from a lot, paid in both tokens pro rata.
    function withdraw(PoolId id, uint256 lot, uint256 s, uint256 bal) external lock returns (uint256 x, uint256 y) {
        Pool storage p = _live(id);
        // Same chain settles first. Cross chain exits mid-interval at actual reserves and forfeits the interval.
        if (p.src.remoteEid == 0) _latchSame(p);
        (x, y) = BK.withdraw(p.book, lot, msg.sender, s, bal);
        _moves(_pair(p, x, y, msg.sender, false));
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
            _latchSame(p);
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

    /// @dev One pool's spot (X128 other raw per base raw) and fee in pips (v2: Uniswap's 0.3%).
    function _leg(uint8 kind, address target, bytes32 v4Id, bool baseIs0)
        internal
        view
        returns (uint256 spot, uint24 fee)
    {
        if (kind == SRC_V2) {
            (uint112 r0, uint112 r1,) = IV2PairLike(target).getReserves();
            (spot,) = _v2(r0, r1, baseIs0);
            fee = 3000;
        } else if (kind == SRC_V3) {
            (uint160 sqrtP,,,,,,) = IV3PoolLike(target).slot0();
            (spot,) = _concentrated(sqrtP, 0, baseIs0);
            fee = IV3PoolLike(target).fee();
        } else {
            (uint160 sqrtP,,, uint24 lpFee) = StateLibrary.getSlot0(poolManager, PoolId.wrap(v4Id));
            (spot,) = _concentrated(sqrtP, 0, baseIs0);
            fee = lpFee;
        }
        if (fee >= 1e6) fee = 999_999;
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

    function _v2(uint256 r0, uint256 r1, bool coinIs0) internal pure returns (uint256 spot, uint256 tvl) {
        (uint256 rc, uint256 rq) = coinIs0 ? (r0, r1) : (r1, r0);
        if (rc == 0 || rq == 0) return (0, 0);
        spot = Math.mulDiv(rq, Q128, rc);
        tvl = 2 * rq;
    }

    /// @dev Spot from sqrtPriceX96 and a TVL proxy (virtual reserves at the current price, both sides in quote).
    function _concentrated(uint160 sqrtP, uint128 liq, bool coinIs0) internal pure returns (uint256 spot, uint256 tvl) {
        if (sqrtP == 0) return (0, 0);
        uint256 sp = uint256(sqrtP);
        uint256 q96 = 1 << 96;
        if (coinIs0) {
            spot = Math.mulDiv(sp, sp, 1 << 64); // sqrtP^2 / 2^192 * 2^128
            tvl = 2 * Math.mulDiv(uint256(liq), sp, q96);
        } else {
            spot = Math.mulDiv(Math.mulDiv(Q128, q96, sp), q96, sp); // 2^192 / sqrtP^2 * 2^128
            tvl = 2 * Math.mulDiv(uint256(liq), q96, sp);
        }
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
