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
import {DiscipleSwapMath as SM} from "../bridge/libraries/DiscipleSwapMath.sol";
import {DisciplePrice as PR} from "../bridge/libraries/DisciplePrice.sol";
import {DiscipleLedger as LG} from "../bridge/libraries/DiscipleLedger.sol";
import {DiscipleBooks as BK} from "./DiscipleBooks.sol";
import {ILzRead, ILzReadConsumer} from "../bridge/interfaces/ILzRead.sol";

interface IV2PairLike {
    function getReserves() external view returns (uint112, uint112, uint32);
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
///         Cross chain (new chain, anchor read from the home chain over LayerZero lzRead): the anchor is the last
///         accepted read. Keepers refresh on a 1% home move or a 59.5-min heartbeat and are refunded the LZ fee
///         plus 20% from the pool's ETH tank. Swaps that find the price an hour old fire a refresh from the tank.
///         The spread widens after 60 min; after 2 h the pool enters local mode (re-centres, drops the band,
///         keeps trading). A fresh read under 120 s old ends local mode and re-centres again. The pool never
///         stops trading.
///
///         Curve and fills: DiscipleSwapMath. Price rules: DisciplePrice. LP books: DiscipleLedger.
///         v4 concentrated liquidity is disabled; every swap is quoted in `beforeSwap`.
///         Custody: pool liquidity is held as the hook's ERC-6909 claims inside the PoolManager, so a swap only
///         mints and burns claims. Deposits, withdrawals and claims convert to and from ERC20 in one unlock.
contract Disciple is IHooks, ILzReadConsumer, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using CurrencySettler for Currency;
    using LG for LG.Book;

    // ---------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------

    uint8 public constant SRC_V2 = 1;
    uint8 public constant SRC_V3 = 2;
    uint8 public constant SRC_V4 = 3;

    uint256 internal constant Q128 = 1 << 128;
    uint256 internal constant WAD = 1e18;
    /// @dev Same-chain premium: 4% fading linearly over 30 s, reset when the anchor moves 0.25% from the reference.
    uint256 internal constant PREMIUM = 4e16;
    uint256 internal constant PREMIUM_TAU = 30;
    uint256 internal constant PREMIUM_RESET_BPS = 25;
    /// @dev Same-chain match edge: 1 bp inside the source's quotes.
    uint256 internal constant MATCH_EDGE_BPS = 1;
    /// @dev A pending keeper request older than this can be replaced.
    uint256 internal constant REQUEST_TIMEOUT = 10 minutes;
    /// @dev Pool fee bounds, in pips.
    uint24 internal constant MAX_FEE = 100_000;
    /// @dev `Source.remoteEid` marking a pool priced off its parent chain (Ethereum for Robinhood Chain) through the
    ///      rollup's own bridge: a permissionless sender there reads the source and drops it in the delayed inbox.
    uint32 public constant BRIDGE_EID = type(uint32).max;
    /// @dev Bridge deliveries take minutes, so a recovering bridge price may be this old on arrival.
    uint256 internal constant BRIDGE_RECOVERY_AGE = 20 minutes;
    /// @dev Cap on one bridge-push refund, so a gas spike on the parent chain cannot drain the tank.
    uint256 internal constant MAX_PUSH_REFUND = 0.002 ether;
    /// @dev Arbitrum-stack L1-to-L2 sender alias offset.
    uint160 internal constant ALIAS_OFFSET = uint160(0x1111000000000000000000000000000000001111);

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    struct Source {
        uint8 kind; // SRC_V2 / SRC_V3 / SRC_V4
        bool coinIs0; // the coin is token0 of the source
        uint24 v2Fee; // pips, v2 only (v3 and v4 read their own)
        uint32 remoteEid; // 0 = same chain; BRIDGE_EID = parent-chain push over the rollup bridge; else LZ eid
        address target; // v2 pair / v3 pool; for v4 the PoolManager (remote: the remote manager)
        bytes32 v4Id; // v4 source pool id
        address lens; // remote AnchorLens (cross chain only)
        int8 decShift; // cross chain: price * 10^decShift converts home raw units to local raw units
    }

    struct Pending {
        bytes32 guid;
        address keeper; // 0 for a tank-funded (swap-triggered) request
        uint64 requestedAt; // also the observation time the read is taken at
        uint64 ageAtRequest;
        uint128 lzFee;
    }

    struct Pool {
        bool exists;
        bool live; // ledger initialised (cross chain waits for its first price)
        bool coinIs0; // coin is currency0 of the Disciple pool
        bool local; // cross chain local mode
        uint24 fee; // pips
        address coin;
        Source src;
        uint256 tX128; // curve seed ratio T (quote raw per coin raw, X128)
        uint256 anchorX128; // A
        uint64 obsAt; // cross: source observation time of A
        uint64 settledBlock; // same chain: last block the ledger settled
        uint256 sampleX128; // same chain: last source spot sampled
        uint64 sampleBlock;
        uint256 premRefX128; // same chain premium reset reference
        uint64 premAt;
        uint256 srcTvl; // source TVL in quote raw (graduation)
        uint256 tank; // ETH for refreshes
        uint256 seedX; // cross chain: creator's seed, held until the first price
        uint256 seedY;
        Pending pending;
        LG.Book book;
    }

    struct CreateParams {
        address coin;
        uint24 fee; // Disciple fee in pips
        Source src;
        uint256 coinIn;
        uint256 quoteIn;
    }

    /// @dev One token movement inside an unlock: `into` the pool's claims from `who`, or out of them to `who`.
    struct Move {
        address token;
        address who;
        uint256 amt;
        bool into;
    }

    IPoolManager public immutable poolManager;
    address public immutable quote;
    ILzRead public immutable lz;
    /// @notice The DiscipleBridgeSender on the parent chain (0 = bridge pricing off). Its messages arrive from its
    ///         aliased address.
    address public immutable bridgeSender;

    mapping(PoolId => Pool) internal pools;
    mapping(bytes32 guid => PoolId) public guidPool;
    bool internal _locked;

    // ---------------------------------------------------------------------------------------------
    // Events and errors
    // ---------------------------------------------------------------------------------------------

    event Created(PoolId indexed id, address indexed coin, address indexed creator, uint32 remoteEid, uint24 fee);
    event Swapped(PoolId indexed id, address indexed sender, bool buy, uint256 coinAmt, uint256 quoteAmt);
    event Deposited(PoolId indexed id, address indexed owner, uint256 lot, uint256 shares, uint256 x, uint256 y);
    event Withdrawn(PoolId indexed id, address indexed owner, uint256 lot, uint256 x, uint256 y);
    event Restaked(PoolId indexed id, address indexed owner, uint256 fromLot, uint256 newLot);
    event Claimed(PoolId indexed id, address indexed to, uint256 x, uint256 y);
    event PriceRequested(PoolId indexed id, bytes32 guid, address keeper, uint256 lzFee);
    event PriceAccepted(PoolId indexed id, uint256 anchorX128, uint64 observedAt, uint256 refund, bool recovered);
    event PriceRejected(PoolId indexed id, bytes32 guid);
    event LocalMode(PoolId indexed id, bool on);
    event TankFunded(PoolId indexed id, uint256 amount);
    event CreatorSet(PoolId indexed id, address creator, bool compounds);

    error OnlyPoolManager();
    error OnlyLz();
    error Reentrancy();
    error UnknownPool();
    error BadParams();
    error NotLive();
    error NoAnchor();
    error SameChain();
    error RequestPending();
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

    constructor(IPoolManager manager_, address quote_, ILzRead lz_, address bridgeSender_) {
        if (address(manager_) == address(0) || quote_ == address(0)) revert BadParams();
        poolManager = manager_;
        quote = quote_;
        lz = lz_;
        bridgeSender = bridgeSender_;
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
    ///         the rest refunded. Cross chain: both tokens are held until the first price lands (send ETH for the
    ///         first read and the tank); then the seed is trimmed the same way.
    function createPool(CreateParams calldata cp) external payable lock returns (PoolKey memory key, PoolId id) {
        if (cp.coin == address(0) || cp.coin == quote || cp.fee == 0 || cp.fee > MAX_FEE) revert BadParams();
        if (cp.coinIn == 0 || cp.quoteIn == 0) revert BadParams();
        Source calldata s = cp.src;
        if (s.kind < SRC_V2 || s.kind > SRC_V4) revert BadParams();
        if (s.remoteEid == BRIDGE_EID) {
            if (bridgeSender == address(0)) revert BadParams();
        } else if (s.remoteEid != 0 && (address(lz) == address(0) || s.lens == address(0))) {
            revert BadParams();
        }

        bool coinIs0 = cp.coin < quote;
        key = PoolKey({
            currency0: Currency.wrap(coinIs0 ? cp.coin : quote),
            currency1: Currency.wrap(coinIs0 ? quote : cp.coin),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(this))
        });
        id = key.toId();
        Pool storage p = pools[id];
        if (p.exists) revert BadParams();
        p.exists = true;
        p.coinIs0 = coinIs0;
        p.coin = cp.coin;
        p.fee = cp.fee;
        p.src = s;
        p.book.creator = msg.sender;

        if (s.remoteEid == 0) {
            if (msg.value != 0) revert SameChain();
            (uint256 spot,,) = _sourceSpot(p);
            if (spot == 0) revert NoAnchor();
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
            if (s.remoteEid == BRIDGE_EID) {
                // the first push from the parent chain opens the pool; all ETH goes to the tank
                p.tank = msg.value;
            } else {
                uint256 fee = lz.quoteRead(_readCmd(p));
                if (msg.value < fee) revert BadParams();
                p.tank = msg.value - fee;
                _send(p, id, address(0), fee);
            }
        }

        poolManager.initialize(key, uint160(1 << 96));
        emit Created(id, cp.coin, msg.sender, s.remoteEid, cp.fee);
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
        _moves(_pair(p.coin, x, y, from, true));
        if (from == address(this)) {
            if (xIn > x) _push(p.coin, creator, xIn - x);
            if (yIn > y) _push(quote, creator, yIn - y);
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
        Currency quoteC = Currency.wrap(quote);
        Currency inC = sell ? coinC : quoteC;
        Currency outC = sell ? quoteC : coinC;
        uint256 inAmt = sell ? coinAmt : quoteAmt;
        uint256 outAmt = sell ? quoteAmt : coinAmt;
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
        uint256 tvl;
        (spot, srcFee, tvl) = _sourceSpot(p);
        if (spot == 0) revert NoAnchor();
        if (p.sampleBlock < block.number) {
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
        if (age >= PR.HEARTBEAT && p.src.remoteEid != BRIDGE_EID) _autoRefresh(p, id);
        (uint256 g, bool bandOn) = PR.markup(p.fee, age);
        (kb, ks) = SM.slopes(a, p.tX128, g);
        (pb, ps) = PR.band(a, g, bandOn);
    }

    /// @dev Swap-triggered refresh, paid from the tank. Never blocks the swap.
    function _autoRefresh(Pool storage p, PoolId id) internal {
        Pending storage q = p.pending;
        if (q.guid != bytes32(0) && block.timestamp < uint256(q.requestedAt) + REQUEST_TIMEOUT) return;
        ILzRead.EvmRead memory cmd = _readCmd(p);
        try lz.quoteRead(cmd) returns (uint256 fee) {
            if (fee == 0 || fee > p.tank) return;
            p.tank -= fee;
            try lz.sendRead{value: fee}(cmd, address(this)) returns (bytes32 guid) {
                _recordPending(p, id, guid, address(0), fee);
            } catch {
                p.tank += fee;
            }
        } catch {}
    }

    // ---------------------------------------------------------------------------------------------
    // Cross-chain price updates
    // ---------------------------------------------------------------------------------------------

    /// @notice Anyone may request a fresh price for a cross-chain pool, paying the LayerZero fee. If the delivered
    ///         price moved at least 1% or this was a heartbeat (anchor at least 59 min old), the pool's tank
    ///         refunds the fee plus 20%.
    function updatePrice(PoolId id) external payable lock returns (bytes32 guid) {
        Pool storage p = _known(id);
        if (p.src.remoteEid == 0 || p.src.remoteEid == BRIDGE_EID) revert SameChain();
        Pending storage q = p.pending;
        if (q.guid != bytes32(0) && block.timestamp < uint256(q.requestedAt) + REQUEST_TIMEOUT) {
            revert RequestPending();
        }
        uint256 fee = lz.quoteRead(_readCmd(p));
        if (msg.value < fee) revert BadParams();
        if (msg.value > fee) p.tank += msg.value - fee; // overpayment tops up the tank
        guid = _send(p, id, msg.sender, fee);
    }

    /// @notice Top up a pool's refresh tank (anyone; a TJAR releaser can point here through a PoolTank).
    function fundTank(PoolId id) external payable {
        Pool storage p = _known(id);
        p.tank += msg.value;
        emit TankFunded(id, msg.value);
    }

    function _send(Pool storage p, PoolId id, address keeper, uint256 fee) internal returns (bytes32 guid) {
        guid = lz.sendRead{value: fee}(_readCmd(p), keeper == address(0) ? address(this) : keeper);
        _recordPending(p, id, guid, keeper, fee);
    }

    function _recordPending(Pool storage p, PoolId id, bytes32 guid, address keeper, uint256 fee) internal {
        Pending storage q = p.pending;
        if (q.guid != bytes32(0)) guidPool[q.guid] = PoolId.wrap(bytes32(0));
        q.guid = guid;
        q.keeper = keeper;
        q.requestedAt = uint64(block.timestamp);
        q.ageAtRequest = p.live ? uint64(block.timestamp - p.obsAt) : 0;
        q.lzFee = uint128(fee);
        guidPool[guid] = id;
        emit PriceRequested(id, guid, keeper, fee);
    }

    /// @notice LayerZero delivery. Only the adapter. Unknown or superseded results are ignored.
    function onLzRead(bytes32 guid, bytes calldata result) external {
        if (msg.sender != address(lz)) revert OnlyLz();
        if (_locked) revert Reentrancy();
        _locked = true;
        PoolId id = guidPool[guid];
        Pool storage p = pools[id];
        Pending memory q = p.pending;
        if (!p.exists || q.guid != guid) {
            emit PriceRejected(id, guid);
            _locked = false;
            return;
        }
        guidPool[guid] = PoolId.wrap(bytes32(0));
        delete p.pending;
        (uint256 price, uint256 tvl) = _decode(p, result);
        _accept(p, id, price, tvl, q.requestedAt, q.keeper, q.lzFee, q.ageAtRequest, PR.MAX_RECOVERY_AGE);
        _locked = false;
    }

    /// @notice A price pushed from the parent chain through the rollup bridge (retryable ticket). Only the
    ///         DiscipleBridgeSender's aliased address. The sender read the source itself in the same transaction,
    ///         so `a`/`b` are raw source state (v2: reserve0, reserve1; v3/v4: sqrtPriceX96, liquidity) observed at
    ///         `observedAt`. The source fields must match the pool's. Order and replay: only an observation newer
    ///         than the last accepted one is taken; a late or re-redeemed ticket is ignored.
    function onBridgePrice(
        PoolId id,
        uint8 kind,
        address target,
        bytes32 v4Id,
        uint256 a,
        uint256 b,
        uint64 observedAt,
        address keeper,
        uint256 keeperCost
    ) external {
        if (bridgeSender == address(0) || msg.sender != address(uint160(bridgeSender) + ALIAS_OFFSET)) {
            revert OnlyBridge();
        }
        if (_locked) revert Reentrancy();
        _locked = true;
        Pool storage p = pools[id];
        Source storage s = p.src;
        uint256 price;
        uint256 tvl;
        if (p.exists && s.remoteEid == BRIDGE_EID && s.kind == kind && s.target == target && s.v4Id == v4Id) {
            (price, tvl) = s.kind == SRC_V2 ? _v2(a, b, s.coinIs0) : _concentrated(uint160(a), uint128(b), s.coinIs0);
            (price, tvl) = _shift(s.decShift, price, tvl);
        }
        uint256 ageAtSend = p.live && observedAt > p.obsAt ? observedAt - p.obsAt : 0;
        if (keeperCost > MAX_PUSH_REFUND) keeperCost = MAX_PUSH_REFUND;
        _accept(p, id, price, tvl, observedAt, keeper, keeperCost, ageAtSend, BRIDGE_RECOVERY_AGE);
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

    function _readCmd(Pool storage p) internal view returns (ILzRead.EvmRead memory cmd) {
        Source storage s = p.src;
        cmd.targetEid = s.remoteEid;
        cmd.target = s.lens;
        if (s.kind == SRC_V4) {
            cmd.callData = abi.encodeWithSignature("readV4Slot(address,bytes32)", s.target, s.v4Id);
        } else if (s.kind == SRC_V3) {
            cmd.callData = abi.encodeWithSignature("readV3Slot(address)", s.target);
        } else {
            cmd.callData = abi.encodeWithSignature("readV2(address)", s.target);
        }
    }

    function _decode(Pool storage p, bytes calldata r) internal view returns (uint256 price, uint256 tvl) {
        Source storage s = p.src;
        if (s.kind == SRC_V2) {
            if (r.length < 64) return (0, 0);
            (uint256 r0, uint256 r1) = abi.decode(r, (uint256, uint256));
            (price, tvl) = _v2(r0, r1, s.coinIs0);
        } else {
            if (r.length < 64) return (0, 0);
            uint160 sqrtP;
            uint128 liq;
            if (s.kind == SRC_V4) (sqrtP,, liq) = abi.decode(r, (uint160, int24, uint128));
            else (sqrtP, liq) = abi.decode(r, (uint160, uint128));
            (price, tvl) = _concentrated(sqrtP, liq, s.coinIs0);
        }
        (price, tvl) = _shift(s.decShift, price, tvl);
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
        _moves(_pair(p.coin, tx_, ty_, msg.sender, true));
        emit Deposited(id, msg.sender, lot, shares, tx_, ty_);
    }

    /// @notice Burn principal shares `s` and compound balance `bal` from a lot, paid in both tokens pro rata.
    function withdraw(PoolId id, uint256 lot, uint256 s, uint256 bal) external lock returns (uint256 x, uint256 y) {
        Pool storage p = _live(id);
        // Same chain settles first. Cross chain exits mid-interval at actual reserves and forfeits the interval.
        if (p.src.remoteEid == 0) _latchSame(p);
        (x, y) = BK.withdraw(p.book, lot, msg.sender, s, bal);
        _moves(_pair(p.coin, x, y, msg.sender, false));
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
        _moves(_pair(p.coin, x, y, msg.sender, false));
        emit Claimed(id, msg.sender, x, y);
    }

    /// @notice Collect the creator's cut (when not compounding). Paid to the current creator wallet.
    function claimCreator(PoolId id) external lock returns (uint256 x, uint256 y) {
        Pool storage p = _live(id);
        (x, y) = BK.claimCreator(p.book);
        address to = p.book.creator;
        _moves(_pair(p.coin, x, y, to, false));
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
        bool live;
        bool local;
        bool graduated;
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
        v.live = p.live;
        v.local = p.local;
        v.graduated = b.graduated;
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

    /// @notice Whether a keeper should request a price now, given the home price it sees (X128, local units).
    function refreshDue(PoolId id, uint256 homePriceX128) external view returns (bool) {
        Pool storage p = _known(id);
        if (p.src.remoteEid == 0 || !p.live) return false;
        return PR.refreshDue(p.anchorX128, homePriceX128, block.timestamp - p.obsAt);
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

    /// @dev Same-chain source spot (X128 quote raw per coin raw), its fee in pips, and TVL in quote raw.
    function _sourceSpot(Pool storage p) internal view returns (uint256 spot, uint24 fee, uint256 tvl) {
        Source storage s = p.src;
        if (s.kind == SRC_V2) {
            (uint112 r0, uint112 r1,) = IV2PairLike(s.target).getReserves();
            (spot, tvl) = _v2(r0, r1, s.coinIs0);
            fee = s.v2Fee == 0 ? 3000 : s.v2Fee;
        } else if (s.kind == SRC_V3) {
            (uint160 sqrtP,,,,,,) = IV3PoolLike(s.target).slot0();
            (spot, tvl) = _concentrated(sqrtP, IV3PoolLike(s.target).liquidity(), s.coinIs0);
            fee = IV3PoolLike(s.target).fee();
        } else {
            PoolId pid = PoolId.wrap(s.v4Id);
            (uint160 sqrtP,,, uint24 lpFee) = StateLibrary.getSlot0(poolManager, pid);
            (spot, tvl) = _concentrated(sqrtP, StateLibrary.getLiquidity(poolManager, pid), s.coinIs0);
            fee = lpFee;
        }
        if (fee >= 1e6) fee = 999_999;
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

    function _pair(address coin, uint256 x, uint256 y, address who, bool into)
        internal
        view
        returns (Move[] memory m)
    {
        m = new Move[](2);
        m[0] = Move(coin, who, x, into);
        m[1] = Move(quote, who, y, into);
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
