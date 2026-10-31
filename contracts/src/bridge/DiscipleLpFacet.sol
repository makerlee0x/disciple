// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {CurrencySettler} from "../libraries/CurrencySettler.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeConstants as C} from "./libraries/BridgeConstants.sol";
import {BridgeCurve} from "./libraries/BridgeCurve.sol";
import {BridgeFee} from "./libraries/BridgeFee.sol";
import {BridgeV4Anchor} from "./libraries/BridgeV4Anchor.sol";
import {DiscipleEngine} from "./DiscipleEngine.sol";
import {DiscipleFacetBase} from "./DiscipleFacetBase.sol";

/// @title Disciple LP facet
/// @notice Create, deposit, redeem, and the keeper callback for Disciple (`DiscipleHook`).
///         Runs as the hook via `delegatecall`. v4 still sees the hook address.
interface IBridgeReference {
    function onReference(PoolId id) external;
}

contract DiscipleLpFacet is DiscipleFacetBase {
    using PoolIdLibrary for PoolKey;
    using CurrencySettler for Currency;

    address internal immutable adminFacet;

    constructor(
        IPoolManager manager_,
        address usdg_,
        address vault_,
        address lz_,
        uint8 usdgDecimals_,
        DiscipleEngine engine_,
        address adminFacet_
    ) DiscipleFacetBase(manager_, usdg_, vault_, lz_, usdgDecimals_, engine_) {
        if (adminFacet_ == address(0)) revert BadCreate();
        adminFacet = adminFacet_;
    }

    function createPool(CreateParams calldata c) external returns (PoolKey memory key, PoolId id) {
        _onlyDelegate();
        if (_locked) revert Reentrancy();
        _locked = true;

        if (c.coin == address(0) || c.coin == usdg || c.coin.code.length == 0) revert BadCreate();
        if (c.creator == address(0)) revert BadCreate();
        if (!engine.anchorOk(c.anchorKind, c.remoteOracle, c.v3Pool, c.refPoolId, c.refHook, c.tipSeed, c.remoteEid)) {
            revert BadCreate();
        }
        if (c.floorBps < 100 || c.floorBps > 5_000) revert BadCreate();
        if (c.discountBps < 1_000 || c.discountBps > 5_000) revert BadCreate();
        if (c.coinSeed == 0) revert BadCreate();
        if (c.outflowWindow != 0 || c.outflowCapBps != 0) {
            if (c.outflowWindow != C.OUTFLOW_PER_BLOCK && c.outflowWindow != C.OUTFLOW_PER_HOUR) revert BadCreate();
            if (c.outflowCapBps == 0 || c.outflowCapBps > C.BPS) revert BadCreate();
        }
        if (c.morphoCapBps > C.BPS) revert BadCreate();
        uint64 drift = engine.normalizeDrift(c.dutchDrift);
        if (drift == 0) revert BadCreate();

        uint8 coinDec = IERC20Metadata(c.coin).decimals();
        if (coinDec > 18) revert BadCreate();

        uint256 coinGot = _pull(c.coin, msg.sender, c.coinSeed);
        uint256 tipGot = c.tipSeed == 0 ? 0 : _pull(usdg, msg.sender, c.tipSeed);
        uint256 coinNorm = _toNorm(coinGot, coinDec);
        uint256 tipNorm = _toNorm(tipGot, usdgDec);
        if (coinNorm == 0) revert Dust();

        bool coinIs0 = c.coin < usdg;
        key = PoolKey({
            currency0: Currency.wrap(coinIs0 ? c.coin : usdg),
            currency1: Currency.wrap(coinIs0 ? usdg : c.coin),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: C.TICK_SPACING,
            hooks: IHooks(address(this))
        });
        id = key.toId();
        if (pools[id].exists) revert BadCreate();

        Pool storage p = pools[id];
        p.exists = true;
        p.coinIs0 = coinIs0;
        p.coinDec = coinDec;
        p.coin = c.coin;
        p.creator = c.creator;
        p.floorBps = c.floorBps;
        p.outflowCapBps = c.outflowCapBps;
        p.outflowWindow = c.outflowWindow;
        p.remoteEid = c.remoteEid;
        p.remoteOracle = c.remoteOracle;
        p.anchorKind = c.anchorKind;
        p.v3Pool = c.v3Pool;
        p.tipBudget = tipNorm;
        p.poolVault = vault;
        p.morphoCapBps = c.morphoCapBps;
        p.vaultAdmin = c.vaultAdmin;
        p.dutchDrift = drift;
        p.dutchAt = block.timestamp == 0 ? 1 : uint64(block.timestamp);
        p.refPoolId = c.refPoolId;
        p.refHook = c.refHook;
        p.refCoinIs0 = c.refCoinIs0;
        p.key = key;
        // `init` takes memory. Assigning the copy is what actually stores the seed.
        BridgeCurve.S memory seeded;
        BridgeCurve.init(seeded, coinNorm, uint256(c.discountBps) * 1e14); // bps → WAD (3300 bps = 0.33e18)
        p.curve = seeded;
        if (_sameChain(c.anchorKind)) {
            // v3 `observe` reverts when the pair is wrong or the pool has no 30-minute history.
            // A v4 self-sample that is not warm yet leaves the anchor at 0. Swaps revert until it is.
            _persistReference(p);
            _touchGrad(id, p);
        }

        // Self-call: v4 skips beforeInitialize when the hook is msg.sender. Anyone else hits the revert below.
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(0));
        poolManager.unlock(abi.encode(OP_SEED, PoolId.unwrap(id), coinGot, tipGot));

        if (tipNorm > 0) usdgClaimsNorm += tipNorm;
        emit PoolCreated(id, c.coin, c.creator, c.floorBps, c.discountBps, coinNorm, c.anchorKind);
        _locked = false;
    }

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
        if (op == OP_READ) return _onRead(data);
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
            usdgClaimsNorm += usdgNorm;
        }

        uint256 added = usdgNorm + Math.mulDiv(coinNorm, p.curve.anchor, C.WAD);
        BridgeCurve.S memory deposited = p.curve;
        BridgeCurve.addLiquidity(deposited, coinNorm, usdgNorm);
        p.curve = deposited;
        // Share price is the block's opening NAV, so a same-block buy cannot cheapen or enrich the mint.
        uint256 minted = _mintShares(p, id, lp, added, coinNorm, usdgNorm);
        emit Deposited(id, lp, minted, coinNorm, usdgNorm);
        return abi.encode(minted);
    }

    function _onRedeem(bytes calldata data) internal returns (bytes memory) {
        (, bytes32 rawId, address lp, uint256 sh) = abi.decode(data, (uint8, bytes32, address, uint256));
        PoolId id = PoolId.wrap(rawId);
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        if (sh == 0 || sh > sharesOf[id][lp]) revert Amount();
        _persistReference(p);
        if (p.curve.anchor == 0) revert NoAnchor();
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
        _claimsTo(usdgC, raw, caller);
        usdgClaimsNorm -= norm;
        emit CreatorClaimed(id, caller, norm);
        return abi.encode(raw);
    }

    function _onRead(bytes calldata data) internal returns (bytes memory) {
        (, bytes32 guid, bytes memory result) = abi.decode(data, (uint8, bytes32, bytes));
        PendingRead memory pend = pendingReads[guid];
        if (pend.caller == address(0)) revert UnknownRead();
        delete pendingReads[guid];

        Pool storage p = pools[pend.poolId];
        uint256 price;
        uint256 ethTvl;
        if (p.anchorKind == C.ANCHOR_LZ_V4_SLOT) {
            (uint160 sqrtP, int24 tick, uint128 liq) = abi.decode(result, (uint160, int24, uint128));
            bytes32 raw = PoolId.unwrap(pend.poolId);
            BridgeV4Anchor.record(rings[raw], obs[raw], tick);
            (bool ready, uint256 px, uint256 tvl) =
                BridgeV4Anchor.read(rings[raw], obs[raw], sqrtP, liq, p.refCoinIs0, p.coinDec, usdgDec);
            // A cold ring is not a bad read. The callback records the tick and leaves the anchor.
            if (ready && px != 0) {
                _applyAnchor(p, px, tvl);
                price = px;
                ethTvl = tvl;
            }
        } else {
            (price, ethTvl) = abi.decode(result, (uint256, uint256));
            if (price == 0) revert BadPrice();
            _applyAnchor(p, price, ethTvl);
        }
        _delegate(adminFacet, abi.encodeCall(IBridgeReference.onReference, (pend.poolId)));

        uint256 tip;
        if (p.tipBudget > 0) {
            tip = p.tipBudget < C.TIP_USDG ? p.tipBudget : C.TIP_USDG;
            uint256 raw = _toRaw(tip, usdgDec);
            uint256 norm = _toNorm(raw, usdgDec);
            if (norm > p.tipBudget) norm = p.tipBudget;
            p.tipBudget -= norm;
            tip = norm;
            if (raw > 0 && norm > 0) {
                _claimsTo(usdgC, raw, pend.caller);
                usdgClaimsNorm -= norm;
            }
        }
        emit PriceUpdated(pend.poolId, price, ethTvl, tip);
        return "";
    }

    function _onTip(bytes calldata data) internal returns (bytes memory) {
        (, bytes32 rawId, uint256 raw, address funder) = abi.decode(data, (uint8, bytes32, uint256, address));
        Pool storage p = pools[PoolId.wrap(rawId)];
        uint256 norm = _toNorm(raw, usdgDec);
        usdgC.settle(poolManager, address(this), raw, false);
        usdgC.take(poolManager, address(this), raw, true);
        // Donations above the per-update tip still sit in the budget for the next stale read.
        p.tipBudget += norm;
        usdgClaimsNorm += norm;
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
        s.y = s.protoY + s.lpY + s.feePot;
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

    /// @dev Remove `outX`/`outY` from LP reserves (proto covers a same-block reshuffle). The fee slice stays
    ///      as protocol principal. `spotP` prices the fee. Retarget is the caller's job.
    function _applyRedeem(
        Pool storage p,
        BridgeCurve.S memory s,
        uint256 outX,
        uint256 outY,
        uint256 credit,
        uint256 spotP
    ) internal view returns (uint256 userX, uint256 userY, uint256 paidCredit, uint256 wfee) {
        if (outX > s.x) outX = s.x;
        uint256 principal = s.protoY + s.lpY;
        if (outY > principal) outY = principal;

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
        s.protoY = s.protoY - takePY + feeY;
        if (paidCredit > s.feePot) paidCredit = s.feePot;
        s.feePot -= paidCredit;
        s.y -= userY + paidCredit;
        userY += paidCredit;
    }
}
