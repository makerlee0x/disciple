// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {CurrencySettler} from "../libraries/CurrencySettler.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeConstants as C} from "./libraries/BridgeConstants.sol";
import {BridgeCurve} from "./libraries/BridgeCurve.sol";
import {BridgeFee} from "./libraries/BridgeFee.sol";
import {DiscipleEngine} from "./DiscipleEngine.sol";
import {DiscipleFacetBase} from "./DiscipleFacetBase.sol";

/// @title Disciple LP facet
/// @notice Deposit, redeem, and the keeper callback for Disciple (`DiscipleHook`). Creation lives on
///         `DiscipleCreateFacet`.
///         Runs as the hook via `delegatecall`. v4 still sees the hook address.
contract DiscipleLpFacet is DiscipleFacetBase {
    using CurrencySettler for Currency;

    constructor(
        IPoolManager manager_,
        address usdg_,
        address lz_,
        uint8 usdgDecimals_,
        DiscipleEngine engine_,
        address v3Factory_
    ) DiscipleFacetBase(manager_, usdg_, lz_, usdgDecimals_, engine_, v3Factory_) {}

    function setCreator(PoolId id, address next) external {
        _onlyDelegate();
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        if (msg.sender != p.creator) revert OnlyCreator();
        if (next == address(0)) revert BadCreate();
        p.creator = next;
        emit CreatorSet(id, next);
    }

    function onLzRead(bytes32 guid, bytes calldata result) external {
        _onlyDelegate();
        if (msg.sender != lz) revert OnlyLz();
        if (_locked) revert Reentrancy();
        _locked = true;
        poolManager.unlock(abi.encode(OP_READ, guid, result));
        _locked = false;
    }

    function fundTip(PoolId id, uint256 raw) external {
        _onlyDelegate();
        if (_locked) revert Reentrancy();
        Pool storage p = pools[id];
        if (!p.exists || raw == 0) revert BadCreate();
        if (_sameChain(p.anchorKind)) revert SameChain();
        _locked = true;
        uint256 got = _pull(usdg, msg.sender, raw);
        poolManager.unlock(abi.encode(OP_TIP, PoolId.unwrap(id), got, msg.sender));
        _locked = false;
    }

    /// @notice Spot-preserving deposit. Not v4 `modifyLiquidity` — that path always reverts.
    function deposit(PoolId id, uint256 coinRaw, uint256 usdgRaw) external returns (uint256 sharesMinted) {
        _onlyDelegate();
        if (_locked) revert Reentrancy();
        if (coinRaw == 0 && usdgRaw == 0) revert Dust();
        _locked = true;
        bytes memory ret = poolManager.unlock(abi.encode(OP_DEPOSIT, PoolId.unwrap(id), msg.sender, coinRaw, usdgRaw));
        _locked = false;
        sharesMinted = abi.decode(ret, (uint256));
    }

    /// @notice Redeem `shares` now. Pays the progress fee on the value removed.
    function redeem(PoolId id, uint256 shares) external returns (uint256 coinRaw, uint256 usdgRaw) {
        _onlyDelegate();
        if (_locked) revert Reentrancy();
        if (shares == 0) revert Dust();
        _locked = true;
        bytes memory ret = poolManager.unlock(abi.encode(OP_REDEEM, PoolId.unwrap(id), msg.sender, shares));
        _locked = false;
        (coinRaw, usdgRaw) = abi.decode(ret, (uint256, uint256));
    }

    function claimCreatorFees(PoolId id) external returns (uint256 raw) {
        _onlyDelegate();
        if (_locked) revert Reentrancy();
        _locked = true;
        bytes memory ret = poolManager.unlock(abi.encode(OP_CLAIM, PoolId.unwrap(id), msg.sender));
        _locked = false;
        raw = abi.decode(ret, (uint256));
    }

    function handle(bytes calldata data) external returns (bytes memory) {
        _onlyDelegate();
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        uint8 op = abi.decode(data, (uint8));
        if (op == OP_SEED) return _onSeed(data);
        if (op == OP_DEPOSIT) return _onDeposit(data);
        if (op == OP_REDEEM) return _onRedeem(data);
        if (op == OP_CLAIM) return _onClaim(data);
        if (op == OP_TIP) return _onTip(data);
        revert HookNotImplemented();
    }

    function _onSeed(bytes calldata data) internal returns (bytes memory) {
        (, bytes32 rawId, uint256 coinRaw, uint256 tipRaw) = abi.decode(data, (uint8, bytes32, uint256, uint256));
        Pool storage p = pools[PoolId.wrap(rawId)];
        Currency coinC = Currency.wrap(p.coin);
        coinC.settle(poolManager, address(this), coinRaw, false);
        coinC.take(poolManager, address(this), coinRaw, true);
        if (tipRaw > 0) {
            usdgC.settle(poolManager, address(this), tipRaw, false);
            usdgC.take(poolManager, address(this), tipRaw, true);
        }
        return "";
    }

    function _onDeposit(bytes calldata data) internal returns (bytes memory) {
        (, bytes32 rawId, address lp, uint256 coinRaw, uint256 usdgRaw) =
            abi.decode(data, (uint8, bytes32, address, uint256, uint256));
        PoolId id = PoolId.wrap(rawId);
        Pool storage p = pools[id];
        _persistReference(p);
        if (!p.exists || p.curve.anchor == 0) revert NoAnchor();
        _rollBlock(p, id);

        uint256 coinGot = coinRaw == 0 ? 0 : _pull(p.coin, lp, coinRaw);
        uint256 usdgGot = usdgRaw == 0 ? 0 : _pull(usdg, lp, usdgRaw);
        uint256 coinNorm = _toNorm(coinGot, p.coinDec);
        uint256 usdgNorm = _toNorm(usdgGot, usdgDec);
        if (coinNorm == 0 && usdgNorm == 0) revert Dust();

        if (coinGot > 0) {
            Currency coinC = Currency.wrap(p.coin);
            coinC.settle(poolManager, address(this), coinGot, false);
            coinC.take(poolManager, address(this), coinGot, true);
        }
        if (usdgGot > 0) {
            usdgC.settle(poolManager, address(this), usdgGot, false);
            usdgC.take(poolManager, address(this), usdgGot, true);
            _creditPoolUsdg(p, usdgNorm);
        }

        uint256 added = usdgNorm + Math.mulDiv(coinNorm, p.curve.anchor, C.WAD);
        BridgeCurve.S memory deposited = p.curve;
        BridgeCurve.addLiquidity(deposited, coinNorm, usdgNorm);
        p.curve = deposited;
        // The deposit is principal. The open outflow window has to see it or the cap stays at the
        // pre-deposit baseline and a later sell in the same hour quotes nothing.
        _bumpOutflowBasis(p);
        // Share price is the block's opening NAV, so a same-block buy cannot cheapen or enrich the mint.
        uint256 minted = _mintShares(p, id, lp, added, coinNorm, usdgNorm);
        _touchMark(p);
        _touchGrad(id, p);
        _requireReserve(p);
        emit Deposited(id, lp, minted, coinNorm, usdgNorm);
        return abi.encode(minted);
    }

    function _onRedeem(bytes calldata data) internal returns (bytes memory) {
        (, bytes32 rawId, address lp, uint256 sh) = abi.decode(data, (uint8, bytes32, address, uint256));
        PoolId id = PoolId.wrap(rawId);
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        if (sh == 0 || sh > sharesOf[id][lp]) revert Amount();
        // Redeems do not read the oracle. A dead or zero reference cannot freeze withdrawals.
        _touchMark(p);
        _rollBlock(p, id);
        _promote(p, id, lp);
        _checkpoint(p, id, lp);

        uint256 fresh = freshBlock[id][lp] == uint64(block.number) ? freshShares[id][lp] : 0;
        uint256 freshBurn = sh > fresh ? fresh : sh;
        uint256 settledBurn = sh - freshBurn;

        BridgeCurve.S memory s = p.curve;
        uint256 liveSpot = BridgeCurve.spot(s);
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
        if (liveSpot != 0 && s.x != 0) BridgeCurve.retarget(s, liveSpot);
        p.curve = s;

        sharesOf[id][lp] -= sh;
        p.totalShares -= sh;
        if (p.totalShares == 0) {
            _foldLastLp(p);
            feeIndexOf[id][lp] = 0;
        }

        _payout(p, userX, userY, lp);
        _touchGrad(id, p);
        _requireReserve(p);
        emit Redeemed(id, lp, sh, userX, userY, wfee);
        return abi.encode(_toRaw(userX, p.coinDec), _toRaw(userY, usdgDec));
    }

    function _onClaim(bytes calldata data) internal returns (bytes memory) {
        (, bytes32 rawId, address caller) = abi.decode(data, (uint8, bytes32, address));
        PoolId id = PoolId.wrap(rawId);
        Pool storage p = pools[id];
        if (caller != p.creator) revert OnlyCreator();
        uint256 amt = p.creatorAccrued;
        if (amt == 0) return abi.encode(uint256(0));
        uint256 raw = _toRaw(amt, usdgDec);
        uint256 norm = _toNorm(raw, usdgDec);
        p.creatorAccrued = amt - norm;
        if (raw == 0) return abi.encode(uint256(0));
        _debitPoolUsdg(p, norm);
        _claimsTo(usdgC, raw, caller);
        _requireReserve(p);
        emit CreatorClaimed(id, caller, norm);
        return abi.encode(raw);
    }

    function _onTip(bytes calldata data) internal returns (bytes memory) {
        (, bytes32 rawId, uint256 raw, address funder) = abi.decode(data, (uint8, bytes32, uint256, address));
        Pool storage p = pools[PoolId.wrap(rawId)];
        uint256 norm = _toNorm(raw, usdgDec);
        usdgC.settle(poolManager, address(this), raw, false);
        usdgC.take(poolManager, address(this), raw, true);
        // Donations above the per-update tip still sit in the budget for the next stale read.
        p.tipBudget += norm;
        _creditPoolUsdg(p, norm);
        emit TipFunded(PoolId.wrap(rawId), funder, norm);
        return "";
    }

    function _foldLastLp(Pool storage p) internal {
        BridgeCurve.S memory s = p.curve;
        s.protoX += s.lpX;
        s.lpX = 0;
        s.protoY += s.lpY;
        s.lpY = 0;
        // feePot stays claimable only if someone still holds a credit. With zero shares, move it to proto
        // so it isn't orphaned. Outstanding feeCredit was paid in this redeem (the last holder).
        s.protoY += s.feePot;
        s.feePot = 0;
        s.y = s.protoY + s.lpY + s.feePot + s.lockedY;
        s.x = s.protoX + s.lpX;
        p.curve = s;
    }

    /// @dev Same-block mint: give back the escrowed tokens, not a pro-rata of the post-trade book.
    function _redeemFresh(Pool storage p, PoolId id, address lp, BridgeCurve.S memory s, uint256 freshBurn)
        internal
        returns (uint256 userX, uint256 userY, uint256 wfee)
    {
        uint256 fSh = freshShares[id][lp];
        uint256 dx;
        uint256 dy;
        if (freshBurn == fSh) {
            dx = freshCoin[id][lp];
            dy = freshUsdg[id][lp];
        } else {
            dx = Math.mulDiv(freshCoin[id][lp], freshBurn, fSh);
            dy = Math.mulDiv(freshUsdg[id][lp], freshBurn, fSh);
        }
        freshShares[id][lp] = fSh - freshBurn;
        freshCoin[id][lp] -= dx;
        freshUsdg[id][lp] -= dy;
        if (freshShares[id][lp] == 0) freshBlock[id][lp] = 0;
        (userX, userY,, wfee) = _applyRedeem(p, s, dx, dy, 0, p.openSpot);
    }

    /// @dev Shares from before this block: pro-rata of the opening LP reserves, capped by what is still there.
    function _redeemSettled(
        Pool storage p,
        PoolId id,
        address lp,
        BridgeCurve.S memory s,
        uint256 settledBurn,
        uint256 freshOriginal
    ) internal returns (uint256 userX, uint256 userY, uint256 wfee) {
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

        uint256 settledBal = sharesOf[id][lp] - freshOriginal;
        uint256 creditAll = feeCreditOf[id][lp];
        uint256 credit =
            settledBurn == settledBal || settledBal == 0 ? creditAll : Math.mulDiv(creditAll, settledBurn, settledBal);
        (userX, userY,, wfee) = _applyRedeem(p, s, dx, dy, credit, p.openSpot);
        if (credit > creditAll) credit = creditAll;
        feeCreditOf[id][lp] = creditAll - credit;
        p.openTakenX += dx;
        p.openTakenY += dy;
        p.redeemedEligible += settledBurn;
    }

    /// @dev Remove `outX`/`outY` from LP reserves (proto covers a same-block reshuffle). The USDG fee
    ///      uses the same split as a swap: all of it to LPs before graduation, and 33/33/33/1 while
    ///      graduated. Coin taken as a fee stays in protocol inventory. `spotP` prices the fee.
    function _applyRedeem(
        Pool storage p,
        BridgeCurve.S memory s,
        uint256 outX,
        uint256 outY,
        uint256 credit,
        uint256 spotP
    ) internal returns (uint256 userX, uint256 userY, uint256 paidCredit, uint256 wfee) {
        if (outX > s.x) outX = s.x;
        uint256 principal = s.protoY + s.lpY;
        if (outY > principal) outY = principal;
        uint256 floorAmt = (p.principalMark * C.FLOOR_BPS) / C.BPS;
        uint256 floorRoom = principal > floorAmt ? principal - floorAmt : 0;
        if (outY > floorRoom) revert ExceedsCap();

        uint256 value = outY + credit + (spotP == 0 ? 0 : Math.mulDiv(outX, spotP, C.WAD));
        uint256 bps = BridgeFee.baseFeeBps(BridgeCurve.tvl(s), _gradTvl(p));
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
        if (takePX > s.protoX) revert Invariant();
        s.lpX -= takeLX;
        s.protoX = s.protoX - takePX + feeX;
        s.x -= userX;

        uint256 takeLY = outY <= s.lpY ? outY : s.lpY;
        uint256 takePY = outY - takeLY;
        if (takePY > s.protoY) revert Invariant();
        s.lpY -= takeLY;
        s.protoY = s.protoY - takePY;
        if (paidCredit > s.feePot) paidCredit = s.feePot;
        s.feePot -= paidCredit;
        uint256 toCreator;
        uint256 toLp;
        uint256 toLocked;
        uint256 toBuilder;
        if (feeY > 0) {
            (toCreator, toLp, toLocked, toBuilder) = engine.splitFee(feeY, p.graduated);
            s.feePot += toLp;
            s.lockedY += toLocked;
            if (toLp > 0) p.blockFee += toLp;
            p.creatorAccrued += toCreator;
            p.builderAccrued += toBuilder;
        }
        if (feeCreditTaken > 0) {
            (uint256 cCreator, uint256 cLp, uint256 cLocked, uint256 cBuilder) =
                engine.splitFee(feeCreditTaken, p.graduated);
            // The taken credit is still in `feePot`. The LP share stays and is indexed. The rest leaves.
            s.feePot -= cCreator + cLocked + cBuilder;
            s.lockedY += cLocked;
            if (cLp > 0) p.blockFee += cLp;
            p.creatorAccrued += cCreator;
            p.builderAccrued += cBuilder;
            toCreator += cCreator;
            toBuilder += cBuilder;
        }
        s.y -= userY + paidCredit + toCreator + toBuilder;
        userY += paidCredit;
    }
}
