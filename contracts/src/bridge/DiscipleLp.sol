// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {CurrencySettler} from "../libraries/CurrencySettler.sol";
import {BridgeConstants as C} from "./libraries/BridgeConstants.sol";
import {BridgeCurve} from "./libraries/BridgeCurve.sol";
import {BridgeStorage} from "./BridgeStorage.sol";
import {DiscipleBook} from "./DiscipleBook.sol";
import {DiscipleMath} from "./DiscipleMath.sol";

/// @title Disciple LP library
/// @notice Deposit, redeem, and creator claims. Linked into the hook. Custody stays on the hook:
///         this runs by `delegatecall`. Shared accounting stays in `DiscipleBook`.
library DiscipleLp {
    using CurrencySettler for Currency;
    using PoolIdLibrary for PoolKey;

    function deposit(DiscipleBook.Env memory env, PoolId id, uint256 coinRaw, uint256 usdgRaw)
        public
        returns (uint256 sharesMinted)
    {
        BridgeStorage.Layout storage l = BridgeStorage.layout();
        if (l.locked) revert BridgeStorage.Reentrancy();
        if (coinRaw == 0 && usdgRaw == 0) revert BridgeStorage.Dust();
        l.locked = true;
        bytes memory ret = env.poolManager
        .unlock(abi.encode(BridgeStorage.OP_DEPOSIT, PoolId.unwrap(id), msg.sender, coinRaw, usdgRaw));
        l.locked = false;
        sharesMinted = abi.decode(ret, (uint256));
    }

    function redeem(DiscipleBook.Env memory env, PoolId id, uint256 shares)
        public
        returns (uint256 coinRaw, uint256 usdgRaw)
    {
        BridgeStorage.Layout storage l = BridgeStorage.layout();
        if (l.locked) revert BridgeStorage.Reentrancy();
        if (shares == 0) revert BridgeStorage.Dust();
        l.locked = true;
        bytes memory ret =
            env.poolManager.unlock(abi.encode(BridgeStorage.OP_REDEEM, PoolId.unwrap(id), msg.sender, shares));
        l.locked = false;
        (coinRaw, usdgRaw) = abi.decode(ret, (uint256, uint256));
    }

    function claimCreatorFees(DiscipleBook.Env memory env, PoolId id) public returns (uint256 raw) {
        BridgeStorage.Layout storage l = BridgeStorage.layout();
        if (l.locked) revert BridgeStorage.Reentrancy();
        l.locked = true;
        bytes memory ret = env.poolManager.unlock(abi.encode(BridgeStorage.OP_CLAIM, PoolId.unwrap(id), msg.sender));
        l.locked = false;
        raw = abi.decode(ret, (uint256));
    }

    function pendingFee(PoolId id, address user) public view returns (uint256) {
        return _pendingFee(BridgeStorage.layout().pools[id], id, user);
    }

    function dutchQuote(DiscipleBook.Env memory env, PoolId id)
        public
        view
        returns (uint256 gapWad, uint256 bidWad, uint256 askWad, uint256 bidUsdg, uint256 askUsdg, uint256 feeBps)
    {
        (BridgeCurve.S memory s,,) = DiscipleBook.referenced(env, id);
        BridgeStorage.Pool storage p = BridgeStorage.layout().pools[id];
        uint256 bidGap = _gapAt(p, p.dutchBidAt);
        gapWad = _gapAt(p, p.dutchAskAt);
        uint256 tvl = DiscipleMath.tvlOf(s);
        uint256 target = _target(p);
        (bidWad, askWad, bidUsdg, askUsdg) = DiscipleMath.preview(s.anchor, tvl, target, bidGap, gapWad);
        feeBps = DiscipleMath.feeBps(tvl, target);
    }

    function bridgeQuote(DiscipleBook.Env memory env, PoolId id)
        public
        view
        returns (BridgeStorage.BridgeQuote memory q)
    {
        (BridgeCurve.S memory s,,) = DiscipleBook.referenced(env, id);
        BridgeStorage.Pool storage p = BridgeStorage.layout().pools[id];
        q.anchorPriceWad = s.anchor;
        q.poolPriceWad = DiscipleMath.spotOf(s);
        q.graduated = p.graduated;
        q.stale = p.updatedAt == 0 || block.timestamp >= p.updatedAt + C.STALE_AFTER;
        if (s.anchor > 0) q.priceGapBps = _signedBps(q.poolPriceWad, s.anchor);
        uint256 v = DiscipleMath.tvlOf(s);
        if (v > 0) {
            uint256 coinVal = Math.mulDiv(s.x, s.anchor, C.WAD);
            q.imbalanceBps = coinVal >= s.y
                ? int256(Math.mulDiv(coinVal - s.y, C.BPS, v))
                : -int256(Math.mulDiv(s.y - coinVal, C.BPS, v));
        }
        q.suggestedFeeBps = DiscipleMath.feeBps(v, _target(p));
    }

    function quoteExactIn(DiscipleBook.Env memory env, PoolKey memory key, bool zeroForOne, uint256 amountIn)
        public
        view
        returns (uint256 amountOut, uint256 fee, bool capped, uint256 amountInUsed)
    {
        PoolId id = key.toId();
        (BridgeCurve.S memory s,,) = DiscipleBook.referenced(env, id);
        if (s.anchor == 0) revert BridgeStorage.NoAnchor();
        BridgeStorage.Pool storage p = BridgeStorage.layout().pools[id];
        bool exactCoinIn = zeroForOne == p.coinIs0;
        BridgeCurve.Ctx memory ctx = DiscipleBook.tradeCtx(id, s);
        uint256 norm = _toNorm(amountIn, exactCoinIn ? p.coinDec : env.usdgDec);
        uint256 gap = exactCoinIn ? _gapAt(p, p.dutchBidAt) : _gapAt(p, p.dutchAskAt);
        BridgeCurve.Fill memory f;
        (, f) = DiscipleMath.trade(s, ctx, norm, exactCoinIn, gap);
        capped = f.capped;
        if (exactCoinIn) {
            amountInUsed = _toRaw(f.coinIn, p.coinDec);
            amountOut = _toRaw(f.usdgOut, env.usdgDec);
        } else {
            amountInUsed = _toRaw(f.usdgIn, env.usdgDec);
            amountOut = _toRaw(f.coinOut, p.coinDec);
        }
        fee = _toRaw(f.fee, env.usdgDec);
    }

    function arbQuote(DiscipleBook.Env memory env, PoolId id) public view returns (BridgeStorage.ArbQuote memory q) {
        (BridgeCurve.S memory s,,) = DiscipleBook.referenced(env, id);
        if (s.anchor == 0) return q;
        BridgeStorage.Pool storage p = BridgeStorage.layout().pools[id];
        BridgeCurve.Ctx memory ctx = DiscipleBook.tradeCtx(id, s);
        uint256 bidGap = _gapAt(p, p.dutchBidAt);
        uint256 askGap = _gapAt(p, p.dutchAskAt);
        (bool buyCoin, uint256 normIn,, uint256 profit) = DiscipleMath.quote(s, ctx, bidGap, askGap);
        q.buyCoin = buyCoin;
        if (normIn == 0 || profit == 0) return q;
        if (buyCoin) {
            q.amountIn = _toRaw(normIn, env.usdgDec);
            uint256 norm = _toNorm(q.amountIn, env.usdgDec);
            (uint256 out, uint256 profitRaw) = DiscipleMath.fill(s, ctx, norm, true, askGap);
            q.amountOut = _toRaw(out, p.coinDec);
            q.profitWad = profitRaw;
        } else {
            q.amountIn = _toRaw(normIn, p.coinDec);
            uint256 norm = _toNorm(q.amountIn, p.coinDec);
            (uint256 out, uint256 profitRaw) = DiscipleMath.fill(s, ctx, norm, false, bidGap);
            q.amountOut = _toRaw(out, env.usdgDec);
            q.profitWad = profitRaw;
        }
        if (q.amountIn == 0 || q.amountOut == 0 || q.profitWad == 0) {
            q.amountIn = 0;
            q.amountOut = 0;
            q.profitWad = 0;
        }
    }

    function onDeposit(DiscipleBook.Env memory env, bytes calldata data) public returns (bytes memory) {
        (, bytes32 rawId, address lp, uint256 coinRaw, uint256 usdgRaw) =
            abi.decode(data, (uint8, bytes32, address, uint256, uint256));
        PoolId id = PoolId.wrap(rawId);
        DiscipleBook.persist(env, id);
        BridgeStorage.Pool storage p = BridgeStorage.layout().pools[id];
        if (!p.exists || p.curve.anchor == 0) revert BridgeStorage.NoAnchor();
        DiscipleBook.rollBlock(id);
        uint256 coinGot = coinRaw == 0 ? 0 : DiscipleBook.pull(p.coin, lp, coinRaw);
        uint256 usdgGot = usdgRaw == 0 ? 0 : DiscipleBook.pull(env.usdg, lp, usdgRaw);
        uint256 coinNorm = _toNorm(coinGot, p.coinDec);
        uint256 usdgNorm = _toNorm(usdgGot, env.usdgDec);
        if (coinNorm == 0 && usdgNorm == 0) revert BridgeStorage.Dust();
        if (coinGot > 0) {
            Currency coinC = Currency.wrap(p.coin);
            coinC.settle(env.poolManager, address(this), coinGot, false);
            coinC.take(env.poolManager, address(this), coinGot, true);
        }
        if (usdgGot > 0) {
            Currency usdgC = Currency.wrap(env.usdg);
            usdgC.settle(env.poolManager, address(this), usdgGot, false);
            usdgC.take(env.poolManager, address(this), usdgGot, true);
            DiscipleBook.credit(id, usdgNorm);
        }
        uint256 added = usdgNorm + Math.mulDiv(coinNorm, p.curve.anchor, C.WAD);
        p.curve = DiscipleMath.addLiquidity(p.curve, coinNorm, usdgNorm);
        DiscipleBook.bumpOutflow(id);
        uint256 minted = DiscipleBook.mintShares(id, lp, added, coinNorm, usdgNorm);
        DiscipleBook.touchMark(id);
        DiscipleBook.touchGrad(id);
        DiscipleBook.requireReserve(id);
        emit BridgeStorage.Deposited(id, lp, minted, coinNorm, usdgNorm);
        return abi.encode(minted);
    }

    function onRedeem(DiscipleBook.Env memory env, bytes calldata data) public returns (bytes memory) {
        (, bytes32 rawId, address lp, uint256 sh) = abi.decode(data, (uint8, bytes32, address, uint256));
        PoolId id = PoolId.wrap(rawId);
        BridgeStorage.Layout storage l = BridgeStorage.layout();
        BridgeStorage.Pool storage p = l.pools[id];
        if (!p.exists) revert BridgeStorage.UnknownPool();
        if (sh == 0 || sh > l.sharesOf[id][lp]) revert BridgeStorage.Amount();
        DiscipleBook.touchMark(id);
        DiscipleBook.rollBlock(id);
        DiscipleBook.promote(id, lp);
        DiscipleBook.checkpoint(id, lp);

        uint256 fresh = l.freshBlock[id][lp] == uint64(block.number) ? l.freshShares[id][lp] : 0;
        uint256 freshBurn = sh > fresh ? fresh : sh;
        uint256 settledBurn = sh - freshBurn;
        BridgeCurve.S memory s = p.curve;
        uint256 liveSpot = DiscipleMath.spotOf(s);
        uint256 userX;
        uint256 userY;
        uint256 wfee;
        if (freshBurn > 0) {
            (uint256 ux, uint256 uy, uint256 fee) = _redeemFresh(p, id, lp, s, freshBurn);
            userX += ux;
            userY += uy;
            wfee += fee;
        }
        if (settledBurn > 0) {
            (uint256 ux, uint256 uy, uint256 fee) = _redeemSettled(p, id, lp, s, settledBurn, fresh);
            userX += ux;
            userY += uy;
            wfee += fee;
        }
        if (liveSpot != 0 && s.x != 0) s = DiscipleMath.retarget(s, liveSpot);
        p.curve = s;
        l.sharesOf[id][lp] -= sh;
        p.totalShares -= sh;
        if (p.totalShares == 0) {
            _foldLastLp(p);
            l.feeIndexOf[id][lp] = 0;
        }
        _payout(env, p, userX, userY, lp);
        DiscipleBook.touchGrad(id);
        DiscipleBook.requireReserve(id);
        emit BridgeStorage.Redeemed(id, lp, sh, userX, userY, wfee);
        return abi.encode(_toRaw(userX, p.coinDec), _toRaw(userY, env.usdgDec));
    }

    function onClaim(DiscipleBook.Env memory env, bytes calldata data) public returns (bytes memory) {
        (, bytes32 rawId, address caller) = abi.decode(data, (uint8, bytes32, address));
        PoolId id = PoolId.wrap(rawId);
        BridgeStorage.Pool storage p = BridgeStorage.layout().pools[id];
        if (caller != p.creator) revert BridgeStorage.OnlyCreator();
        uint256 amt = p.creatorAccrued;
        if (amt == 0) return abi.encode(uint256(0));
        uint256 raw = _toRaw(amt, env.usdgDec);
        uint256 norm = _toNorm(raw, env.usdgDec);
        p.creatorAccrued = amt - norm;
        if (raw == 0) return abi.encode(uint256(0));
        DiscipleBook.debit(id, norm);
        _claimsTo(env, Currency.wrap(env.usdg), raw, caller);
        DiscipleBook.requireReserve(id);
        emit BridgeStorage.CreatorClaimed(id, caller, norm);
        return abi.encode(raw);
    }

    function _redeemFresh(
        BridgeStorage.Pool storage p,
        PoolId id,
        address lp,
        BridgeCurve.S memory s,
        uint256 freshBurn
    ) private returns (uint256 userX, uint256 userY, uint256 wfee) {
        BridgeStorage.Layout storage l = BridgeStorage.layout();
        uint256 fSh = l.freshShares[id][lp];
        uint256 dx;
        uint256 dy;
        if (freshBurn == fSh) {
            dx = l.freshCoin[id][lp];
            dy = l.freshUsdg[id][lp];
        } else {
            dx = Math.mulDiv(l.freshCoin[id][lp], freshBurn, fSh);
            dy = Math.mulDiv(l.freshUsdg[id][lp], freshBurn, fSh);
        }
        l.freshShares[id][lp] = fSh - freshBurn;
        l.freshCoin[id][lp] -= dx;
        l.freshUsdg[id][lp] -= dy;
        if (l.freshShares[id][lp] == 0) l.freshBlock[id][lp] = 0;
        (userX, userY,, wfee) = _applyRedeem(p, s, dx, dy, 0, p.openSpot);
    }

    function _redeemSettled(
        BridgeStorage.Pool storage p,
        PoolId id,
        address lp,
        BridgeCurve.S memory s,
        uint256 settledBurn,
        uint256 freshOriginal
    ) private returns (uint256 userX, uint256 userY, uint256 wfee) {
        BridgeStorage.Layout storage l = BridgeStorage.layout();
        uint256 denom = p.openShares + C.SHARE_OFFSET;
        uint256 dx = Math.mulDiv(settledBurn, p.openLpX, denom);
        uint256 dy = Math.mulDiv(settledBurn, p.openLpY, denom);
        uint256 remX = p.openLpX > p.openTakenX ? p.openLpX - p.openTakenX : 0;
        uint256 remY = p.openLpY > p.openTakenY ? p.openLpY - p.openTakenY : 0;
        if (dx > remX) dx = remX;
        if (dy > remY) dy = remY;
        if (dx > s.x) dx = s.x;
        uint256 principal = s.protoY + s.lpY;
        if (dy > principal) dy = principal;
        uint256 settledBal = l.sharesOf[id][lp] - freshOriginal;
        uint256 creditAll = l.feeCreditOf[id][lp];
        uint256 credit =
            settledBurn == settledBal || settledBal == 0 ? creditAll : Math.mulDiv(creditAll, settledBurn, settledBal);
        (userX, userY,, wfee) = _applyRedeem(p, s, dx, dy, credit, p.openSpot);
        if (credit > creditAll) credit = creditAll;
        l.feeCreditOf[id][lp] = creditAll - credit;
        p.openTakenX += dx;
        p.openTakenY += dy;
        p.redeemedEligible += settledBurn;
    }

    /// @dev Graduated redeem fee is 3,333 creator / remainder LP / 3,333 locked.
    function _applyRedeem(
        BridgeStorage.Pool storage p,
        BridgeCurve.S memory s,
        uint256 outX,
        uint256 outY,
        uint256 credit,
        uint256 spotP
    ) private returns (uint256 userX, uint256 userY, uint256 paidCredit, uint256 wfee) {
        if (outX > s.x) outX = s.x;
        uint256 principal = s.protoY + s.lpY;
        if (outY > principal) outY = principal;
        uint256 floorAmt = (p.principalMark * C.FLOOR_BPS) / C.BPS;
        uint256 floorRoom = principal > floorAmt ? principal - floorAmt : 0;
        if (outY > floorRoom) revert BridgeStorage.ExceedsCap();
        uint256 value = outY + credit + (spotP == 0 ? 0 : Math.mulDiv(outX, spotP, C.WAD));
        uint256 target = p.smoothedTvl == 0 ? 0 : Math.mulDiv(p.smoothedTvl, C.GRAD_NUM, C.GRAD_DEN);
        uint256 bps = DiscipleMath.feeBps(DiscipleMath.tvlOf(s), target);
        wfee = value == 0 ? 0 : Math.mulDiv(value, bps, C.BPS, Math.Rounding.Ceil);
        uint256 left = wfee;
        uint256 feeY = left > outY ? outY : left;
        left -= feeY;
        uint256 feeCreditTaken = left > credit ? credit : left;
        left -= feeCreditTaken;
        uint256 feeX;
        if (left > 0 && spotP > 0) {
            feeX = Math.mulDiv(left, C.WAD, spotP, Math.Rounding.Ceil);
            if (feeX > outX) feeX = outX;
        }
        userX = outX - feeX;
        userY = outY - feeY;
        paidCredit = credit - feeCreditTaken;
        uint256 takeLX = outX <= s.lpX ? outX : s.lpX;
        uint256 takePX = outX - takeLX;
        if (takePX > s.protoX) revert BridgeStorage.Invariant();
        s.lpX -= takeLX;
        s.protoX = s.protoX - takePX + feeX;
        s.x -= userX;
        uint256 takeLY = outY <= s.lpY ? outY : s.lpY;
        uint256 takePY = outY - takeLY;
        if (takePY > s.protoY) revert BridgeStorage.Invariant();
        s.lpY -= takeLY;
        s.protoY = s.protoY - takePY;
        if (paidCredit > s.feePot) paidCredit = s.feePot;
        s.feePot -= paidCredit;
        uint256 toCreator;
        if (feeY > 0) {
            (uint256 creator, uint256 toLp, uint256 locked) = DiscipleMath.splitFee(feeY, p.graduated);
            s.feePot += toLp;
            s.lockedY += locked;
            if (toLp > 0) p.blockFee += toLp;
            p.creatorAccrued += creator;
            toCreator = creator;
        }
        if (feeCreditTaken > 0) {
            (uint256 cCreator, uint256 cLp, uint256 cLocked) = DiscipleMath.splitFee(feeCreditTaken, p.graduated);
            s.feePot -= cCreator + cLocked;
            s.lockedY += cLocked;
            if (cLp > 0) p.blockFee += cLp;
            p.creatorAccrued += cCreator;
            toCreator += cCreator;
        }
        s.y -= userY + paidCredit + toCreator;
        userY += paidCredit;
    }

    function _foldLastLp(BridgeStorage.Pool storage p) private {
        BridgeCurve.S memory s = p.curve;
        s.protoX += s.lpX;
        s.lpX = 0;
        s.protoY += s.lpY;
        s.lpY = 0;
        s.protoY += s.feePot;
        s.feePot = 0;
        s.y = s.protoY + s.lpY + s.feePot + s.lockedY;
        s.x = s.protoX + s.lpX;
        p.curve = s;
    }

    function _pendingFee(BridgeStorage.Pool storage p, PoolId id, address user) private view returns (uint256 credit) {
        BridgeStorage.Layout storage l = BridgeStorage.layout();
        credit = l.feeCreditOf[id][user];
        uint256 sh = l.sharesOf[id][user];
        if (sh == 0) return credit;
        uint256 fresh = l.freshShares[id][user];
        uint64 fb = l.freshBlock[id][user];
        uint256 prev = l.feeIndexOf[id][user];
        uint256 idx = p.feeIndex;
        if (p.openBlock != 0 && p.openBlock != uint64(block.number) && p.blockFee > 0) {
            uint256 eligible = p.openShares > p.redeemedEligible ? p.openShares - p.redeemedEligible : 0;
            if (eligible > 0) idx += Math.mulDiv(p.blockFee, C.RAY, eligible);
        }
        uint256 currentExtra;
        if (p.openBlock == uint64(block.number) && p.blockFee > 0) {
            uint256 eligible = p.openShares > p.redeemedEligible ? p.openShares - p.redeemedEligible : 0;
            if (eligible > 0) currentExtra = Math.mulDiv(p.blockFee, C.RAY, eligible);
        }
        if (fb == uint64(block.number) && fresh > 0) {
            uint256 settled = sh > fresh ? sh - fresh : 0;
            uint256 to = idx + currentExtra;
            if (settled > 0 && to > prev) credit += Math.mulDiv(settled, to - prev, C.RAY);
            return credit;
        }
        if (fb != 0 && fresh > 0) {
            uint256 start = l.indexAtBlock[id][fb];
            if (fb == p.openBlock && p.openBlock != uint64(block.number)) start = idx;
            uint256 settled = sh > fresh ? sh - fresh : 0;
            if (settled > 0 && start > prev) credit += Math.mulDiv(settled, start - prev, C.RAY);
            uint256 to = idx + currentExtra;
            if (to > start) credit += Math.mulDiv(sh, to - start, C.RAY);
            return credit;
        }
        uint256 endIdx = idx + currentExtra;
        if (endIdx > prev) credit += Math.mulDiv(sh, endIdx - prev, C.RAY);
    }

    function _payout(
        DiscipleBook.Env memory env,
        BridgeStorage.Pool storage p,
        uint256 coinNorm,
        uint256 usdgNorm,
        address to
    ) private {
        uint256 coinRaw = _toRaw(coinNorm, p.coinDec);
        uint256 usdgRaw = _toRaw(usdgNorm, env.usdgDec);
        if (coinRaw > 0) _claimsTo(env, Currency.wrap(p.coin), coinRaw, to);
        if (usdgRaw > 0) {
            DiscipleBook.debit(p.key.toId(), _toNorm(usdgRaw, env.usdgDec));
            _claimsTo(env, Currency.wrap(env.usdg), usdgRaw, to);
        }
    }

    function _claimsTo(DiscipleBook.Env memory env, Currency c, uint256 raw, address to) private {
        c.settle(env.poolManager, address(this), raw, true);
        c.take(env.poolManager, to, raw, false);
    }

    function _gapAt(BridgeStorage.Pool storage p, uint64 stamp) private view returns (uint256) {
        if (stamp == 0 || p.dutchDrift == 0 || block.timestamp <= uint256(stamp)) return 0;
        return (block.timestamp - uint256(stamp)) * uint256(p.dutchDrift);
    }

    function _target(BridgeStorage.Pool storage p) private view returns (uint256) {
        if (p.smoothedTvl == 0) return 0;
        return Math.mulDiv(p.smoothedTvl, C.GRAD_NUM, C.GRAD_DEN);
    }

    function _signedBps(uint256 a, uint256 b) private pure returns (int256) {
        if (b == 0) return 0;
        if (a >= b) return int256(Math.mulDiv(a - b, C.BPS, b));
        return -int256(Math.mulDiv(b - a, C.BPS, b));
    }

    function _toNorm(uint256 raw, uint8 dec) private pure returns (uint256) {
        if (dec >= 18) return raw / 10 ** (dec - 18);
        return raw * 10 ** (18 - dec);
    }

    function _toRaw(uint256 norm, uint8 dec) private pure returns (uint256) {
        if (dec >= 18) return norm * 10 ** (dec - 18);
        return norm / 10 ** (18 - dec);
    }
}
