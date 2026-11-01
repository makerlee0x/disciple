// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {CurrencySettler} from "../libraries/CurrencySettler.sol";
import {BridgeConstants as C} from "./libraries/BridgeConstants.sol";
import {BridgeCurve} from "./libraries/BridgeCurve.sol";
import {BridgeV4Anchor} from "./libraries/BridgeV4Anchor.sol";
import {BridgeStorage} from "./BridgeStorage.sol";
import {DiscipleMath} from "./DiscipleMath.sol";
import {DiscipleAnchor} from "./DiscipleAnchor.sol";

/// @title Disciple state machine
/// @notice Create, swap, LP, and quotes. Linked into `DiscipleHook` and run with `delegatecall`, so
///         every write lands in the hook and every token move uses the hook's address. This library
///         holds no funds of its own. It calls `DiscipleMath` and `DiscipleAnchor` for the heavy math.
library DiscipleBook {
    using PoolIdLibrary for PoolKey;
    using CurrencySettler for Currency;
    using SafeERC20 for IERC20;

    /// @dev Immutables of the hook, passed in so this library does not store them.
    struct Env {
        IPoolManager poolManager;
        address usdg;
        uint8 usdgDec;
        address v2Factory;
        address v3Factory;
    }

    uint24 internal constant DYNAMIC_FEE = 0x800000;
    /// @dev `TickMath.MAX_TICK_SPACING`. A literal so this library does not pull the tick tables.
    int24 internal constant MAX_SPACING = 32767;
    /// @dev sqrt price at tick 0.
    uint160 internal constant SQRT_1 = 79228162514264337593543950336;

    function createPool(Env memory env, BridgeStorage.CreateParams memory c)
        public
        returns (PoolKey memory key, PoolId id)
    {
        BridgeStorage.Layout storage l = BridgeStorage.layout();
        if (l.locked) revert BridgeStorage.Reentrancy();
        l.locked = true;
        if (c.coin == address(0) || c.coin == env.usdg || c.coin.code.length == 0) revert BridgeStorage.BadCreate();
        if (c.creator == address(0)) revert BridgeStorage.BadCreate();
        if (c.coinSeed == 0) revert BridgeStorage.BadCreate();
        if (c.anchorKind > C.ANCHOR_V4) revert BridgeStorage.BadCreate();
        // Discount, floor, outflow, and drift on `c` are ignored. The discount is 33% for every pool.
        _checkRef(env, c);

        uint8 coinDec = IERC20Metadata(c.coin).decimals();
        if (coinDec > 18) revert BridgeStorage.BadCreate();
        uint256 coinGot = _pull(c.coin, msg.sender, c.coinSeed);
        uint256 coinNorm = _toNorm(coinGot, coinDec);
        if (coinNorm == 0) revert BridgeStorage.Dust();

        bool coinIs0 = c.coin < env.usdg;
        int24 spacing = c.tickSpacing == 0 ? C.TICK_SPACING : c.tickSpacing;
        if (spacing <= 0 || spacing > MAX_SPACING) revert BridgeStorage.BadCreate();
        key = PoolKey({
            currency0: Currency.wrap(coinIs0 ? c.coin : env.usdg),
            currency1: Currency.wrap(coinIs0 ? env.usdg : c.coin),
            fee: DYNAMIC_FEE,
            tickSpacing: spacing,
            hooks: IHooks(address(this))
        });
        id = key.toId();
        if (l.pools[id].exists) revert BridgeStorage.BadCreate();

        BridgeStorage.Pool storage p = l.pools[id];
        p.exists = true;
        p.coinIs0 = coinIs0;
        p.coinDec = coinDec;
        p.coin = c.coin;
        p.creator = c.creator;
        p.anchorKind = c.anchorKind;
        p.refPool = c.refPool;
        p.refFee = c.refFee;
        p.refTickSpacing = c.refTickSpacing;
        p.refHooks = c.refHooks;
        p.refCoinIs0 = c.anchorKind == C.ANCHOR_V4 ? c.coin < env.usdg : coinIs0;
        p.refPoolId = c.refPoolId;
        p.dutchAt = _stamp();
        p.key = key;
        p.curve = DiscipleMath.init(coinNorm, uint256(C.DISCOUNT_BPS) * 1e14);
        _persist(env, p);
        if (c.anchorKind == C.ANCHOR_V3 && p.curve.anchor == 0) revert BridgeStorage.BadCreate();
        _touchGrad(id, p);

        env.poolManager.initialize(key, SQRT_1);
        env.poolManager.unlock(abi.encode(BridgeStorage.OP_SEED, PoolId.unwrap(id), coinGot));
        emit BridgeStorage.PoolCreated(id, c.coin, c.creator, 0, C.DISCOUNT_BPS, coinNorm, c.anchorKind);
        l.locked = false;
    }

    function poke(Env memory env, PoolId id) public {
        BridgeStorage.Layout storage l = BridgeStorage.layout();
        if (l.locked) revert BridgeStorage.Reentrancy();
        BridgeStorage.Pool storage p = l.pools[id];
        if (!p.exists) revert BridgeStorage.UnknownPool();
        l.locked = true;
        _persist(env, p);
        _touchGrad(id, p);
        l.locked = false;
    }

    function beforeSwap(
        Env memory env,
        address sender,
        PoolKey memory key,
        IPoolManager.SwapParams memory params,
        bytes memory hookData
    ) public returns (bytes4, BeforeSwapDelta, uint24) {
        if (msg.sender != address(env.poolManager)) {
            revert BridgeStorage.OnlyPoolManager();
        }
        BridgeStorage.Layout storage l = BridgeStorage.layout();
        if (l.locked) revert BridgeStorage.Reentrancy();
        l.locked = true;
        if (params.amountSpecified > 0) revert BridgeStorage.ExactOutUnsupported();
        uint256 specRaw = uint256(-params.amountSpecified);
        if (specRaw == 0 || specRaw > uint256(uint128(type(int128).max))) revert BridgeStorage.Amount();

        PoolId id = key.toId();
        BridgeStorage.Pool storage p = l.pools[id];
        if (!p.exists) revert BridgeStorage.UnknownPool();
        _persist(env, p);
        if (p.curve.anchor == 0) revert BridgeStorage.NoAnchor();
        if (p.updatedAt == 0 || block.timestamp >= p.updatedAt + C.STALE_AFTER) revert BridgeStorage.Stale();
        _rollBlock(p, id);

        bool specIsCoin = params.zeroForOne ? p.coinIs0 : !p.coinIs0;
        (bool mintLp, address recipient) = _decodeHookData(hookData, sender);
        BridgeCurve.S memory s = p.curve;
        BridgeCurve.Ctx memory ctx = _ctx(p, s);

        uint256 specNorm = _toNorm(specRaw, specIsCoin ? p.coinDec : env.usdgDec);
        uint256 q = specIsCoin ? Math.mulDiv(specNorm, s.anchor, C.WAD) : specNorm;
        uint256 avg;
        (p.bidGap, p.askGap, p.dutchAt, avg) = DiscipleMath.advanceDutch(
            p.bidGap, p.askGap, p.dutchAt, q, DiscipleMath.tvlOf(s), specIsCoin, block.timestamp
        );
        BridgeCurve.Fill memory f;
        (s, f) = DiscipleMath.trade(s, ctx, specNorm, specIsCoin, avg);
        if (f.capped) revert BridgeStorage.ExceedsCap();
        if (specIsCoin) {
            if (f.coinIn != specNorm || f.usdgOut == 0) revert BridgeStorage.ZeroOutput();
        } else if (f.usdgIn != specNorm || f.coinOut == 0) {
            revert BridgeStorage.ZeroOutput();
        }

        p.curve = s;
        if (f.toLp > 0) p.blockFee += f.toLp;
        p.creatorAccrued += f.creator;
        uint256 unspecRaw;
        if (!mintLp) {
            unspecRaw = specIsCoin ? _toRaw(f.usdgOut, env.usdgDec) : _toRaw(f.coinOut, p.coinDec);
            if (unspecRaw == 0) revert BridgeStorage.ZeroOutput();
        } else {
            _parkProceeds(p, id, recipient, f);
        }
        _settleSwap(env, p, specIsCoin, specRaw, unspecRaw);
        _noteClaims(env, p, specIsCoin, specRaw, unspecRaw);
        _requireReserve(p);
        _touchGrad(id, p);
        emit BridgeStorage.Swapped(
            id,
            sender,
            !specIsCoin,
            specIsCoin ? f.coinIn : f.coinOut,
            specIsCoin ? f.usdgOut : f.usdgIn,
            f.fee,
            f.spotAfter
        );
        l.locked = false;
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(uint128(specRaw)), -int128(uint128(unspecRaw))), 0);
    }

    function onSeed(Env memory env, bytes calldata data) public returns (bytes memory) {
        if (msg.sender != address(env.poolManager)) revert BridgeStorage.OnlyPoolManager();
        return _onSeed(env, data);
    }

    /// @dev Shared with the LP library. The bodies stay here so they are not copied into both.
    function persist(Env memory env, PoolId id) public {
        _persist(env, BridgeStorage.layout().pools[id]);
    }

    function rollBlock(PoolId id) public {
        _rollBlock(BridgeStorage.layout().pools[id], id);
    }

    function mintShares(PoolId id, address to, uint256 added, uint256 coinNorm, uint256 usdgNorm)
        public
        returns (uint256)
    {
        return _mintShares(BridgeStorage.layout().pools[id], id, to, added, coinNorm, usdgNorm);
    }

    function touchGrad(PoolId id) public {
        _touchGrad(id, BridgeStorage.layout().pools[id]);
    }

    function requireReserve(PoolId id) public view {
        _requireReserve(BridgeStorage.layout().pools[id]);
    }

    function promote(PoolId id, address user) public {
        _promote(BridgeStorage.layout().pools[id], id, user);
    }

    function checkpoint(PoolId id, address user) public {
        _checkpoint(BridgeStorage.layout().pools[id], id, user);
    }

    function credit(PoolId id, uint256 norm) public {
        _credit(BridgeStorage.layout().pools[id], norm);
    }

    function debit(PoolId id, uint256 norm) public {
        _debit(BridgeStorage.layout().pools[id], norm);
    }

    function pull(address token, address from, uint256 raw) public returns (uint256) {
        return _pull(token, from, raw);
    }

    function spotPrice(Env memory env, PoolId id) public view returns (uint256) {
        BridgeStorage.Pool storage p = _pool(id);
        (BridgeCurve.S memory s,,) = _referenced(env, p);
        return DiscipleMath.spotOf(s);
    }

    function liveAnchor(Env memory env, PoolId id) public view returns (uint256 priceWad, uint256 tvlWad) {
        BridgeStorage.Pool storage p = _pool(id);
        (bool ready, uint256 price, uint256 tvl) = _peek(env, p);
        if (ready && price != 0) return (price, tvl);
        return (p.curve.anchor, p.ethTvl);
    }

    function floorState(PoolId id) public view returns (uint256 mark, uint256 principal) {
        BridgeStorage.Pool storage p = BridgeStorage.layout().pools[id];
        principal = p.curve.protoY + p.curve.lpY;
        mark = 0;
    }

    function curve(Env memory env, PoolId id) public view returns (BridgeCurve.S memory s) {
        (s,,) = _referenced(env, _pool(id));
    }

    function referenced(Env memory env, PoolId id)
        public
        view
        returns (BridgeCurve.S memory s, uint256 refTvl, uint256 age)
    {
        return _referenced(env, _pool(id));
    }

    function tradeCtx(PoolId id, BridgeCurve.S memory s) public view returns (BridgeCurve.Ctx memory) {
        return _ctx(BridgeStorage.layout().pools[id], s);
    }

    function reserveOk(PoolId id) public view returns (bool) {
        BridgeStorage.Pool storage p = BridgeStorage.layout().pools[id];
        BridgeCurve.S memory s = p.curve;
        return s.protoX + s.lpX == s.x && s.protoY + s.lpY + s.feePot + s.lockedY == s.y
            && p.usdgHeld >= s.y + p.creatorAccrued;
    }

    function _onSeed(Env memory env, bytes calldata data) internal returns (bytes memory) {
        (, bytes32 rawId, uint256 coinRaw) = abi.decode(data, (uint8, bytes32, uint256));
        BridgeStorage.Pool storage p = BridgeStorage.layout().pools[PoolId.wrap(rawId)];
        Currency coinC = Currency.wrap(p.coin);
        coinC.settle(env.poolManager, address(this), coinRaw, false);
        coinC.take(env.poolManager, address(this), coinRaw, true);
        return "";
    }

    function _checkRef(Env memory env, BridgeStorage.CreateParams memory c) internal {
        uint8 k = c.anchorKind;
        if (k == C.ANCHOR_V2) {
            if (!DiscipleAnchor.v2Matches(env.v2Factory, c.refPool, c.coin, env.usdg)) {
                revert BridgeStorage.BadCreate();
            }
            if (!_aged(k, c.refPool, bytes32(0))) revert BridgeStorage.BadCreate();
            uint8 coinDec = _dec(c.coin);
            // Create-time reserves are a size gate only. The trading anchor is the cumulative TWAP.
            (bool ok, uint256 px) =
                DiscipleAnchor.v2SpotPrice(env.v2Factory, c.refPool, c.coin, env.usdg, coinDec, env.usdgDec);
            if (!ok) revert BridgeStorage.BadCreate();
            if (DiscipleAnchor.v2Tvl(c.refPool, c.coin, env.usdg, coinDec, env.usdgDec, px) < C.MIN_REF_TVL) {
                revert BridgeStorage.BadCreate();
            }
        } else if (k == C.ANCHOR_V3) {
            if (!DiscipleAnchor.v3FactoryMatch(env.v3Factory, c.refPool, c.coin, env.usdg, c.refFee)) {
                revert BridgeStorage.BadCreate();
            }
            if (!DiscipleAnchor.prepareV3(c.refPool)) revert BridgeStorage.BadCreate();
        } else if (k == C.ANCHOR_V4) {
            if (c.refPoolId == bytes32(0) || c.refTickSpacing <= 0 || c.refTickSpacing > MAX_SPACING) {
                revert BridgeStorage.BadCreate();
            }
            if (!DiscipleAnchor.hookAllowed(c.refHooks)) revert BridgeStorage.BadCreate();
            if (!_aged(k, address(0), c.refPoolId)) revert BridgeStorage.BadCreate();
            bool ref0 = c.coin < env.usdg;
            PoolKey memory refKey = PoolKey({
                currency0: Currency.wrap(ref0 ? c.coin : env.usdg),
                currency1: Currency.wrap(ref0 ? env.usdg : c.coin),
                fee: c.refFee,
                tickSpacing: c.refTickSpacing,
                hooks: IHooks(c.refHooks)
            });
            if (PoolId.unwrap(refKey.toId()) != c.refPoolId) revert BridgeStorage.BadCreate();
            (bool ok,, uint160 sqrtP, uint128 liq) = DiscipleAnchor.v4Slot(env.poolManager, c.refPoolId);
            if (!ok) revert BridgeStorage.BadCreate();
            // Current sqrt is the size gate only. No past sample exists yet, so it is not the anchor.
            uint256 tvl = DiscipleAnchor.inRangeQuote(sqrtP, liq, ref0, env.usdgDec);
            if (tvl < C.MIN_REF_TVL) revert BridgeStorage.BadCreate();
        }
    }

    function _aged(uint8 kind, address ref, bytes32 refId) internal view returns (bool) {
        uint64 seen = BridgeStorage.layout().seenAt[_sourceKey(kind, ref, refId)];
        return seen != 0 && block.timestamp >= uint256(seen) + C.MIN_REF_AGE;
    }

    function _sourceKey(uint8 kind, address ref, bytes32 refId) internal pure returns (bytes32) {
        return keccak256(abi.encode(kind, ref, refId));
    }

    function _dec(address token) internal view returns (uint8) {
        return IERC20Metadata(token).decimals();
    }

    function _persist(Env memory env, BridgeStorage.Pool storage p) internal {
        uint8 k = p.anchorKind;
        if (k == C.ANCHOR_V3) {
            (bool ok, uint256 price, uint256 tvl) =
                DiscipleAnchor.readV3(env.v3Factory, p.refPool, p.coin, env.usdg, p.refFee, p.coinDec, env.usdgDec);
            if (ok && price != 0) _applyAnchor(p, price, tvl);
            return;
        }
        if (k == C.ANCHOR_V2) {
            _sampleV2(p);
            (bool ready, uint256 price,) = _storedPrice(p, 0, 0, env.usdgDec);
            if (!ready || price == 0) return;
            uint256 tvl = DiscipleAnchor.v2Tvl(p.refPool, p.coin, env.usdg, p.coinDec, env.usdgDec, price);
            _applyAnchor(p, price, tvl);
            return;
        }
        if (k == C.ANCHOR_V4 && _v4KeyOk(env, p)) {
            (bool ok, int24 tick, uint160 sqrtP, uint128 liq) = DiscipleAnchor.v4Slot(env.poolManager, p.refPoolId);
            if (!ok) return;
            _record(p, tick);
            (bool ready, uint256 price, uint256 tvl) = _storedPrice(p, sqrtP, liq, env.usdgDec);
            if (ready && price != 0) _applyAnchor(p, price, tvl);
        }
    }

    function _peek(Env memory env, BridgeStorage.Pool storage p)
        internal
        view
        returns (bool ready, uint256 price, uint256 tvl)
    {
        uint8 k = p.anchorKind;
        if (k == C.ANCHOR_V3) {
            return DiscipleAnchor.readV3(env.v3Factory, p.refPool, p.coin, env.usdg, p.refFee, p.coinDec, env.usdgDec);
        }
        bytes32 raw = PoolId.unwrap(p.key.toId());
        BridgeStorage.Layout storage l = BridgeStorage.layout();
        if (k == C.ANCHOR_V2) {
            (bool sampled, int24 tick) = _v2TickView(p);
            BridgeV4Anchor.Ring memory ring = l.rings[raw];
            BridgeV4Anchor.Write memory w;
            if (sampled) {
                (ring, w) = DiscipleAnchor.advance(ring, tick, uint32(block.timestamp), uint64(block.number));
            }
            (ready, price,) = DiscipleAnchor.consult(ring, l.obs[raw], w, 0, 0, p.refCoinIs0, p.coinDec, env.usdgDec);
            if (!ready || price == 0) return (false, 0, 0);
            tvl = DiscipleAnchor.v2Tvl(p.refPool, p.coin, env.usdg, p.coinDec, env.usdgDec, price);
            return (true, price, tvl);
        }
        if (k == C.ANCHOR_V4 && _v4KeyOk(env, p)) {
            (bool ok, int24 tick, uint160 sqrtP, uint128 liq) = DiscipleAnchor.v4Slot(env.poolManager, p.refPoolId);
            if (!ok) return (false, 0, 0);
            (BridgeV4Anchor.Ring memory next, BridgeV4Anchor.Write memory w) =
                DiscipleAnchor.advance(l.rings[raw], tick, uint32(block.timestamp), uint64(block.number));
            return DiscipleAnchor.consult(next, l.obs[raw], w, sqrtP, liq, p.refCoinIs0, p.coinDec, env.usdgDec);
        }
        return (false, 0, 0);
    }

    function _record(BridgeStorage.Pool storage p, int24 tick) internal {
        bytes32 raw = PoolId.unwrap(p.key.toId());
        BridgeStorage.Layout storage l = BridgeStorage.layout();
        (BridgeV4Anchor.Ring memory next, BridgeV4Anchor.Write memory w) =
            DiscipleAnchor.advance(l.rings[raw], tick, uint32(block.timestamp), uint64(block.number));
        if (w.wrote) l.obs[raw][w.index] = w.word;
        l.rings[raw] = next;
    }

    function _storedPrice(BridgeStorage.Pool storage p, uint160 sqrtP, uint128 liq, uint8 quoteDec)
        internal
        view
        returns (bool ready, uint256 price, uint256 tvl)
    {
        bytes32 raw = PoolId.unwrap(p.key.toId());
        BridgeStorage.Layout storage l = BridgeStorage.layout();
        BridgeV4Anchor.Write memory none;
        return DiscipleAnchor.consult(l.rings[raw], l.obs[raw], none, sqrtP, liq, p.refCoinIs0, p.coinDec, quoteDec);
    }

    function _v4KeyOk(Env memory env, BridgeStorage.Pool storage p) internal view returns (bool) {
        if (p.refPoolId == bytes32(0) || p.refTickSpacing <= 0) return false;
        bool ref0 = p.coin < env.usdg;
        if (p.refCoinIs0 != ref0) return false;
        PoolKey memory refKey = PoolKey({
            currency0: Currency.wrap(ref0 ? p.coin : env.usdg),
            currency1: Currency.wrap(ref0 ? env.usdg : p.coin),
            fee: p.refFee,
            tickSpacing: p.refTickSpacing,
            hooks: IHooks(p.refHooks)
        });
        return PoolId.unwrap(refKey.toId()) == p.refPoolId;
    }

    function _sampleV2(BridgeStorage.Pool storage p) internal {
        (bool ok, uint256 p0, uint256 p1) = DiscipleAnchor.v2Accrued(p.refPool);
        if (!ok) return;
        (bool sampled, int24 tick) = _v2TickView(p);
        BridgeStorage.V2Sample storage sample = BridgeStorage.layout().v2Sample[PoolId.unwrap(p.key.toId())];
        if (sample.init && sample.ts == uint32(block.timestamp)) return;
        sample.init = true;
        sample.ts = uint32(block.timestamp);
        sample.price0Cum = p0;
        sample.price1Cum = p1;
        if (sampled) _record(p, tick);
    }

    /// @dev True when this block should append one cumulative interval. The first call only stores the cum.
    function _v2TickView(BridgeStorage.Pool storage p) internal view returns (bool sampled, int24 tick) {
        (bool ok, uint256 p0, uint256 p1) = DiscipleAnchor.v2Accrued(p.refPool);
        if (!ok) return (false, 0);
        BridgeStorage.V2Sample memory sample = BridgeStorage.layout().v2Sample[PoolId.unwrap(p.key.toId())];
        if (!sample.init || sample.ts == uint32(block.timestamp)) return (false, 0);
        uint32 dt;
        unchecked {
            dt = uint32(block.timestamp) - sample.ts;
        }
        bool coin0 = DiscipleAnchor.v2Coin0(p.refPool, p.coin);
        uint256 newer = coin0 ? p0 : p1;
        uint256 older = coin0 ? sample.price0Cum : sample.price1Cum;
        return DiscipleAnchor.v2IntervalTick(newer, older, dt, !coin0);
    }

    function _applyAnchor(BridgeStorage.Pool storage p, uint256 price, uint256 tvl) internal {
        if (tvl < C.MIN_REF_TVL) return;
        if (price != p.curve.anchor) p.curve = DiscipleMath.onAnchor(p.curve, price);
        p.updatedAt = block.timestamp;
        p.ethTvl = tvl;
        _smooth(p, tvl);
        emit BridgeStorage.PriceUpdated(p.key.toId(), price, tvl);
    }

    function _smooth(BridgeStorage.Pool storage p, uint256 next) internal {
        uint256 prev = p.smoothedTvl;
        if (prev == 0) {
            p.smoothedTvl = next;
            p.smoothAt = uint64(block.timestamp);
            return;
        }
        uint256 dt =
            p.smoothAt == 0 || block.timestamp <= uint256(p.smoothAt) ? 0 : block.timestamp - uint256(p.smoothAt);
        if (dt == 0) return;
        if (dt > C.SMOOTH_STEP) dt = C.SMOOTH_STEP;
        uint256 mag = prev > next ? prev - next : next - prev;
        uint256 left = DiscipleMath.decayed(mag, dt, C.TWAP_WINDOW);
        p.smoothedTvl = prev > next ? next + left : (next > left ? next - left : 0);
        p.smoothAt = uint64(block.timestamp);
    }

    function _referenced(Env memory env, BridgeStorage.Pool storage p)
        internal
        view
        returns (BridgeCurve.S memory s, uint256 refTvl, uint256 age)
    {
        s = p.curve;
        (bool ready, uint256 price, uint256 tvl) = _peek(env, p);
        if (ready && price != 0) {
            if (price != s.anchor) s = DiscipleMath.onAnchor(s, price);
            return (s, tvl, 0);
        }
        return (s, p.ethTvl, _age(p));
    }

    function _ctx(BridgeStorage.Pool storage p, BridgeCurve.S memory s)
        internal
        view
        returns (BridgeCurve.Ctx memory ctx)
    {
        uint256 target = _gradTvl(p);
        (,,,, uint256 boost) = DiscipleMath.measures(s, 0, p.graduated, target);
        ctx.gradTvl = target;
        ctx.graduated = p.graduated;
        ctx.maxUsdgOut = type(uint256).max;
        ctx.totalShares = p.totalShares;
        ctx.useOpen = true;
        if (p.openBlock == uint64(block.number)) {
            ctx.openLpVal = p.openLpY + Math.mulDiv(p.openLpX, s.anchor, C.WAD);
            ctx.openShares = p.openShares;
        } else {
            ctx.openLpVal = s.lpY + Math.mulDiv(s.lpX, s.anchor, C.WAD);
            ctx.openShares = p.totalShares;
        }
        ctx.boostWad = boost;
    }

    function _rollBlock(BridgeStorage.Pool storage p, PoolId id) internal {
        if (p.openBlock == uint64(block.number)) return;
        BridgeStorage.Layout storage l = BridgeStorage.layout();
        uint64 prev = p.openBlock;
        if (prev != 0 && p.blockFee > 0) {
            uint256 eligible = p.openShares > p.redeemedEligible ? p.openShares - p.redeemedEligible : 0;
            if (eligible == 0) {
                uint256 amt = p.blockFee > p.curve.feePot ? p.curve.feePot : p.blockFee;
                p.curve.feePot -= amt;
                p.curve.protoY += amt;
            } else {
                p.feeIndex += Math.mulDiv(p.blockFee, C.RAY, eligible);
            }
        }
        if (prev != 0) l.indexAtBlock[id][prev] = p.feeIndex;
        p.blockFee = 0;
        p.openBlock = uint64(block.number);
        p.openSpot = DiscipleMath.spotOf(p.curve);
        p.openLpX = p.curve.lpX;
        p.openLpY = p.curve.lpY;
        p.openShares = p.totalShares;
        p.openTakenX = 0;
        p.openTakenY = 0;
        p.redeemedEligible = 0;
    }

    function _mintShares(
        BridgeStorage.Pool storage p,
        PoolId id,
        address to,
        uint256 added,
        uint256 coinNorm,
        uint256 usdgNorm
    ) internal returns (uint256 sh) {
        if (added == 0) revert BridgeStorage.Dust();
        _promote(p, id, to);
        _checkpoint(p, id, to);
        uint256 valBefore = p.openLpY + Math.mulDiv(p.openLpX, p.curve.anchor, C.WAD);
        sh = Math.mulDiv(added, p.openShares + C.SHARE_OFFSET, valBefore + 1);
        if (sh == 0) revert BridgeStorage.Dust();
        BridgeStorage.Layout storage l = BridgeStorage.layout();
        l.sharesOf[id][to] += sh;
        p.totalShares += sh;
        l.freshShares[id][to] += sh;
        l.freshCoin[id][to] += coinNorm;
        l.freshUsdg[id][to] += usdgNorm;
        l.freshBlock[id][to] = uint64(block.number);
    }

    function _checkpoint(BridgeStorage.Pool storage p, PoolId id, address user) internal {
        BridgeStorage.Layout storage l = BridgeStorage.layout();
        uint256 fresh = l.freshBlock[id][user] == uint64(block.number) ? l.freshShares[id][user] : 0;
        uint256 sh = l.sharesOf[id][user];
        uint256 settled = sh > fresh ? sh - fresh : 0;
        uint256 prev = l.feeIndexOf[id][user];
        if (settled > 0 && p.feeIndex > prev) {
            l.feeCreditOf[id][user] += Math.mulDiv(settled, p.feeIndex - prev, C.RAY);
        }
        l.feeIndexOf[id][user] = p.feeIndex;
    }

    function _promote(BridgeStorage.Pool storage p, PoolId id, address user) internal {
        BridgeStorage.Layout storage l = BridgeStorage.layout();
        uint64 fb = l.freshBlock[id][user];
        if (fb == 0 || fb == uint64(block.number)) return;
        uint256 start = l.indexAtBlock[id][fb];
        uint256 fresh = l.freshShares[id][user];
        uint256 sh = l.sharesOf[id][user];
        uint256 settled = sh > fresh ? sh - fresh : 0;
        uint256 prev = l.feeIndexOf[id][user];
        if (settled > 0 && start > prev) l.feeCreditOf[id][user] += Math.mulDiv(settled, start - prev, C.RAY);
        if (sh > 0 && p.feeIndex > start) l.feeCreditOf[id][user] += Math.mulDiv(sh, p.feeIndex - start, C.RAY);
        l.feeIndexOf[id][user] = p.feeIndex;
        l.freshShares[id][user] = 0;
        l.freshCoin[id][user] = 0;
        l.freshUsdg[id][user] = 0;
        l.freshBlock[id][user] = 0;
    }

    function _touchGrad(PoolId id, BridgeStorage.Pool storage p) internal {
        BridgeCurve.S memory s = p.curve;
        uint256 v = DiscipleMath.tvlOf(s);
        uint256 target = _gradTvl(p);
        (bool grad, uint8 edge) = DiscipleMath.stepGrad(v, target, p.graduated);
        p.graduated = grad;
        if (edge == 1) emit BridgeStorage.Graduated(id, v, p.smoothedTvl);
        else if (edge == 2) emit BridgeStorage.Ungraduated(id, v, target);
    }

    function _parkProceeds(BridgeStorage.Pool storage p, PoolId id, address recipient, BridgeCurve.Fill memory f)
        internal
    {
        uint256 dx = f.coinOut;
        uint256 dy = f.usdgOut;
        if (dx == 0 && dy == 0) revert BridgeStorage.ZeroOutput();
        uint256 added = dy + Math.mulDiv(dx, p.curve.anchor, C.WAD);
        p.curve = DiscipleMath.addLiquidity(p.curve, dx, dy);
        _mintShares(p, id, recipient, added, dx, dy);
        emit BridgeStorage.MintedLp(id, recipient, BridgeStorage.layout().sharesOf[id][recipient], dx, dy);
    }

    function _settleSwap(
        Env memory env,
        BridgeStorage.Pool storage p,
        bool specIsCoin,
        uint256 specRaw,
        uint256 unspecRaw
    ) internal {
        Currency coinC = Currency.wrap(p.coin);
        Currency usdgC = Currency.wrap(env.usdg);
        Currency spec = specIsCoin ? coinC : usdgC;
        Currency unspec = specIsCoin ? usdgC : coinC;
        spec.take(env.poolManager, address(this), specRaw, true);
        if (unspecRaw > 0) unspec.settle(env.poolManager, address(this), unspecRaw, true);
    }

    function _noteClaims(
        Env memory env,
        BridgeStorage.Pool storage p,
        bool specIsCoin,
        uint256 specRaw,
        uint256 unspecRaw
    ) internal {
        if (specIsCoin) {
            if (unspecRaw > 0) _debit(p, _toNorm(unspecRaw, env.usdgDec));
        } else {
            _credit(p, _toNorm(specRaw, env.usdgDec));
        }
    }

    function _credit(BridgeStorage.Pool storage p, uint256 norm) internal {
        if (norm == 0) return;
        p.usdgHeld += norm;
        BridgeStorage.layout().usdgClaimsNorm += norm;
    }

    function _debit(BridgeStorage.Pool storage p, uint256 norm) internal {
        if (norm == 0) return;
        if (norm > p.usdgHeld) revert BridgeStorage.Invariant();
        p.usdgHeld -= norm;
        BridgeStorage.layout().usdgClaimsNorm -= norm;
    }

    function _requireReserve(BridgeStorage.Pool storage p) internal view {
        BridgeCurve.S memory s = p.curve;
        if (s.protoX + s.lpX != s.x || s.protoY + s.lpY + s.feePot + s.lockedY != s.y) {
            revert BridgeStorage.Invariant();
        }
        if (p.usdgHeld < s.y + p.creatorAccrued) revert BridgeStorage.Invariant();
    }

    function _pull(address token, address from, uint256 raw) internal returns (uint256 got) {
        uint256 beforeBal = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(from, address(this), raw);
        got = IERC20(token).balanceOf(address(this)) - beforeBal;
    }

    function _decodeHookData(bytes memory hookData, address sender) internal pure returns (bool mintLp, address to) {
        if (hookData.length == 0) return (false, sender);
        (mintLp, to) = abi.decode(hookData, (bool, address));
        if (to == address(0)) to = sender;
    }

    function _gradTvl(BridgeStorage.Pool storage p) internal view returns (uint256) {
        if (p.smoothedTvl == 0) return 0;
        return Math.mulDiv(p.smoothedTvl, C.GRAD_NUM, C.GRAD_DEN);
    }

    function _age(BridgeStorage.Pool storage p) internal view returns (uint256) {
        if (p.updatedAt == 0 || block.timestamp <= p.updatedAt) return 0;
        return block.timestamp - p.updatedAt;
    }

    function _pool(PoolId id) internal view returns (BridgeStorage.Pool storage p) {
        p = BridgeStorage.layout().pools[id];
        if (!p.exists) revert BridgeStorage.UnknownPool();
    }

    /// @dev Same gap update a buy or sell of `q` USDG would write. `q == 0` does nothing.
    function moveDutch(PoolId id, uint256 q, bool sellCoin) public {
        if (q == 0) return;
        BridgeStorage.Pool storage p = BridgeStorage.layout().pools[id];
        uint256 depth = DiscipleMath.tvlOf(p.curve);
        (p.bidGap, p.askGap, p.dutchAt,) =
            DiscipleMath.advanceDutch(p.bidGap, p.askGap, p.dutchAt, q, depth, sellCoin, block.timestamp);
    }

    function transferCreator(PoolId id, address next) public {
        if (next == address(0)) revert BridgeStorage.BadCreate();
        BridgeStorage.Pool storage p = _pool(id);
        if (msg.sender != p.creator) revert BridgeStorage.OnlyCreator();
        address prev = p.creator;
        p.creator = next;
        emit BridgeStorage.CreatorTransferred(id, prev, next);
    }

    function witnessSource(bytes32 key) public {
        if (key == bytes32(0)) revert BridgeStorage.BadCreate();
        BridgeStorage.Layout storage l = BridgeStorage.layout();
        if (l.seenAt[key] != 0) return;
        uint64 seen = _stamp();
        l.seenAt[key] = seen;
        emit BridgeStorage.SourceWitnessed(key, seen);
    }

    function sourceKey(uint8 kind, address ref, bytes32 refId) public pure returns (bytes32) {
        return _sourceKey(kind, ref, refId);
    }

    function accruedGaps(PoolId id) public view returns (uint256 bid, uint256 ask) {
        BridgeStorage.Pool storage p = _pool(id);
        bid = DiscipleMath.accrueGap(p.bidGap, p.dutchAt, block.timestamp);
        ask = DiscipleMath.accrueGap(p.askGap, p.dutchAt, block.timestamp);
    }

    function _stamp() internal view returns (uint64) {
        return block.timestamp == 0 ? 1 : uint64(block.timestamp);
    }

    function _toNorm(uint256 raw, uint8 dec) internal pure returns (uint256) {
        if (dec >= 18) return raw / 10 ** (dec - 18);
        return raw * 10 ** (18 - dec);
    }

    function _toRaw(uint256 norm, uint8 dec) internal pure returns (uint256) {
        if (dec >= 18) return norm * 10 ** (dec - 18);
        return norm / 10 ** (18 - dec);
    }

    function _signedBps(uint256 a, uint256 b) internal pure returns (int256) {
        if (b == 0) return 0;
        if (a >= b) return int256(Math.mulDiv(a - b, C.BPS, b));
        return -int256(Math.mulDiv(b - a, C.BPS, b));
    }
}
