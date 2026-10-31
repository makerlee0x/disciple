// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BridgeConstants as C} from "./libraries/BridgeConstants.sol";
import {DiscipleEngine} from "./DiscipleEngine.sol";
import {ILzRead} from "./interfaces/ILzRead.sol";
import {AnchorLens} from "./AnchorLens.sol";
import {BridgeV4Anchor} from "./libraries/BridgeV4Anchor.sol";
import {DiscipleFacetBase} from "./DiscipleFacetBase.sol";

/// @title Disciple admin facet
/// @notice Cross-chain price requests, the permissionless graduation poke, and the hook builder's
///         fee claim for Disciple (`DiscipleHook`). Called through the hook. There is no vault.
///         The builder address is global. Pool creators cannot change it.
contract DiscipleAdminFacet is DiscipleFacetBase {
    constructor(
        IPoolManager manager_,
        address usdg_,
        address lz_,
        uint8 usdgDecimals_,
        DiscipleEngine engine_,
        address v3Factory_
    ) DiscipleFacetBase(manager_, usdg_, lz_, usdgDecimals_, engine_, v3Factory_) {}

    /// @notice Allow or revoke a v4 oracle hook, or the remote PoolManager used by an lzRead slot.
    ///         Only the builder. Pool creators cannot add a reference.
    function setOracleAllowed(address oracle, bool ok) external {
        _onlyDelegate();
        if (msg.sender != builder) revert OnlyBuilder();
        if (oracle == address(0)) revert BadCreate();
        allowedOracle[oracle] = ok;
    }

    /// @notice Allow or revoke a remote lens address (`remoteOracle` on a cross-chain pool).
    function setLensAllowed(address lens, bool ok) external {
        _onlyDelegate();
        if (msg.sender != builder) revert OnlyBuilder();
        if (lens == address(0)) revert BadCreate();
        allowedLens[lens] = ok;
    }

    /// @notice Send this contract's ETH to `to`. Only the builder. Does not move tokens.
    function rescueEth(address to) external {
        _onlyDelegate();
        if (msg.sender != builder) revert OnlyBuilder();
        if (to == address(0)) revert BadCreate();
        uint256 bal = address(this).balance;
        (bool sent,) = to.call{value: bal}("");
        if (!sent) revert RefundFailed();
    }

    /// @notice Ask LayerZero to read the pool's remote anchor. The caller pays the native lzRead fee
    ///         and never submits a price. Same-chain pools revert. A fresh quote reverts.
    ///         Calldata is `AnchorLens.readV3`, `readV4Oracle`, or `readV4Slot`, chosen by the anchor kind.
    function updatePrice(PoolId id) external payable {
        _onlyDelegate();
        if (_locked) revert Reentrancy();
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        if (_sameChain(p.anchorKind)) revert SameChain();
        bool stale = p.curve.anchor == 0 || block.timestamp >= p.updatedAt + C.STALE_AFTER;
        if (!stale) revert Fresh();

        _locked = true;
        ILzRead.EvmRead memory read = ILzRead.EvmRead({
            targetEid: p.remoteEid, target: p.remoteOracle, callData: _readCallData(p), minConfirmations: 1
        });
        uint256 nativeFee = ILzRead(lz).quoteRead(read);
        if (msg.value < nativeFee) revert LzFee();
        bytes32 guid = ILzRead(lz).sendRead{value: nativeFee}(read, msg.sender);
        p.readNonce += 1;
        pendingReads[guid] = PendingRead({
            poolId: id,
            caller: msg.sender,
            nonce: p.readNonce,
            requestedAt: block.timestamp == 0 ? 1 : uint64(block.timestamp)
        });
        uint256 extra = msg.value - nativeFee;
        if (extra > 0) {
            (bool ok,) = msg.sender.call{value: extra}("");
            if (!ok) revert RefundFailed();
        }
        emit PriceRequested(id, guid, msg.sender);
        _locked = false;
    }

    /// @notice Permissionless. Sync a same-chain anchor, then move graduated status if its
    ///         77-minute window has elapsed. Time alone does not write storage.
    function poke(PoolId id) external {
        _onlyDelegate();
        if (_locked) revert Reentrancy();
        if (!pools[id].exists) revert UnknownPool();
        _locked = true;
        poolManager.unlock(abi.encode(OP_POKE, PoolId.unwrap(id)));
        _locked = false;
    }

    /// @notice Name the next builder. Only the current builder. A later propose overwrites the pending
    ///         address. Zero is rejected. This does not move tokens.
    function proposeBuilder(address next) external {
        _onlyDelegate();
        if (msg.sender != builder) revert OnlyBuilder();
        if (next == address(0)) revert BadCreate();
        pendingBuilder = next;
        emit BuilderProposed(next);
    }

    /// @notice Pending address becomes the builder. Only that address can accept.
    function acceptBuilder() external {
        _onlyDelegate();
        if (msg.sender != pendingBuilder) revert OnlyBuilder();
        builder = msg.sender;
        pendingBuilder = address(0);
        emit BuilderAccepted(msg.sender);
    }

    /// @notice Pull this pool's accrued builder share. Pull pattern. Only the current builder.
    function claimBuilderFees(PoolId id) external returns (uint256 raw) {
        _onlyDelegate();
        if (_locked) revert Reentrancy();
        _locked = true;
        bytes memory ret = poolManager.unlock(abi.encode(OP_BUILDER, PoolId.unwrap(id), msg.sender));
        _locked = false;
        raw = abi.decode(ret, (uint256));
    }

    function handle(bytes calldata data) external returns (bytes memory) {
        _onlyDelegate();
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        uint8 op = abi.decode(data, (uint8));
        if (op == OP_POKE) return _onPoke(data);
        if (op == OP_BUILDER) return _onBuilder(data);
        if (op == OP_READ) return _onRead(data);
        revert HookNotImplemented();
    }

    /// @dev Accept a read only when its nonce is newer than the last one applied, and only when the
    ///      price stays inside the move bound. The keeper tip is paid once for a stale quote: a
    ///      second result that lands after the quote is already fresh pays nothing.
    function _onRead(bytes calldata data) internal returns (bytes memory) {
        (, bytes32 guid, bytes memory result) = abi.decode(data, (uint8, bytes32, bytes));
        PendingRead memory pend = pendingReads[guid];
        if (pend.caller == address(0) || pend.nonce == 0) revert UnknownRead();
        delete pendingReads[guid];

        Pool storage p = pools[pend.poolId];
        if (pend.nonce <= p.appliedNonce) revert OutOfOrder();
        bool wasStale = p.curve.anchor == 0 || p.updatedAt == 0 || block.timestamp >= p.updatedAt + C.STALE_AFTER;

        uint256 price;
        uint256 ethTvl;
        if (p.anchorKind == C.ANCHOR_LZ_V4_SLOT) {
            (uint160 sqrtP, int24 tick, uint128 liq) = abi.decode(result, (uint160, int24, uint128));
            bytes32 raw = PoolId.unwrap(pend.poolId);
            BridgeV4Anchor.record(rings[raw], obs[raw], tick);
            (bool ready, uint256 px, uint256 tvl) =
                BridgeV4Anchor.read(rings[raw], obs[raw], sqrtP, liq, p.refCoinIs0, p.coinDec, usdgDec);
            if (ready && px != 0) {
                if (!engine.anchorMoveOk(p.curve.anchor, px)) revert AnchorMove();
                _applyAnchor(p, px, tvl);
                price = px;
                ethTvl = tvl;
            }
        } else {
            (price, ethTvl) = abi.decode(result, (uint256, uint256));
            if (price == 0) revert BadPrice();
            if (!engine.anchorMoveOk(p.curve.anchor, price)) revert AnchorMove();
            _applyAnchor(p, price, ethTvl);
        }
        p.appliedNonce = pend.nonce;
        _touchGrad(pend.poolId, p);

        uint256 tip;
        if (wasStale && price != 0 && p.tipBudget > 0) {
            tip = p.tipBudget < C.TIP_USDG ? p.tipBudget : C.TIP_USDG;
            uint256 raw = _toRaw(tip, usdgDec);
            uint256 norm = _toNorm(raw, usdgDec);
            if (norm > p.tipBudget) norm = p.tipBudget;
            p.tipBudget -= norm;
            tip = norm;
            if (raw > 0 && norm > 0) {
                _debitPoolUsdg(p, norm);
                _claimsTo(usdgC, raw, pend.caller);
            }
        }
        emit PriceUpdated(pend.poolId, price, ethTvl, tip);
        return "";
    }

    function _onBuilder(bytes calldata data) internal returns (bytes memory) {
        (, bytes32 rawId, address caller) = abi.decode(data, (uint8, bytes32, address));
        PoolId id = PoolId.wrap(rawId);
        Pool storage p = pools[id];
        if (caller != builder) revert OnlyBuilder();
        uint256 amt = p.builderAccrued;
        if (amt == 0) return abi.encode(uint256(0));
        uint256 raw = _toRaw(amt, usdgDec);
        uint256 norm = _toNorm(raw, usdgDec);
        p.builderAccrued = amt - norm;
        if (raw == 0) return abi.encode(uint256(0));
        _debitPoolUsdg(p, norm);
        _claimsTo(usdgC, raw, caller);
        _requireReserve(p);
        emit BuilderClaimed(id, caller, norm);
        return abi.encode(raw);
    }

    function _onPoke(bytes calldata data) internal returns (bytes memory) {
        (, bytes32 rawId) = abi.decode(data, (uint8, bytes32));
        PoolId id = PoolId.wrap(rawId);
        Pool storage p = pools[id];
        _persistReference(p);
        _touchMark(p);
        _touchGrad(id, p);
        return "";
    }

    function _readCallData(Pool storage p) internal view returns (bytes memory) {
        uint8 k = p.anchorKind;
        if (k == C.ANCHOR_LZ) {
            return abi.encodeWithSelector(AnchorLens.readV3.selector, p.v3Pool, p.coin, usdg, p.coinDec, usdgDec);
        }
        if (k == C.ANCHOR_LZ_V4_ORACLE) {
            return abi.encodeWithSelector(AnchorLens.readV4Oracle.selector, p.refHook, p.refPoolId);
        }
        if (k == C.ANCHOR_LZ_V4_SLOT) {
            return abi.encodeWithSelector(AnchorLens.readV4Slot.selector, p.refHook, p.refPoolId);
        }
        revert SameChain();
    }
}
