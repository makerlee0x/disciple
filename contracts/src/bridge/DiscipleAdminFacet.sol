// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BridgeConstants as C} from "./libraries/BridgeConstants.sol";
import {DiscipleEngine} from "./DiscipleEngine.sol";
import {ILzRead} from "./interfaces/ILzRead.sol";
import {IEthAnchor} from "./interfaces/IEthAnchor.sol";
import {IV4OracleHook} from "./interfaces/IV4OracleHook.sol";
import {V4SlotReader} from "./V4SlotReader.sol";
import {DiscipleFacetBase} from "./DiscipleFacetBase.sol";

/// @title Disciple admin facet
/// @notice Cross-chain price requests, the permissionless graduation poke, and the hook builder's
///         fee claim for Disciple (`DiscipleHook`). Called through the hook. There is no vault.
///         The builder address is global. Pool creators cannot change it.
contract DiscipleAdminFacet is DiscipleFacetBase {
    constructor(IPoolManager manager_, address usdg_, address lz_, uint8 usdgDecimals_, DiscipleEngine engine_)
        DiscipleFacetBase(manager_, usdg_, lz_, usdgDecimals_, engine_)
    {}

    /// @notice Ask LayerZero to read the pool's remote anchor. The caller pays the native lzRead fee
    ///         and never submits a price. Same-chain pools revert. A fresh quote reverts.
    ///         Calldata is `latest`, `consult`, or `V4SlotReader.read`, chosen by the anchor kind.
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
        pendingReads[guid] = PendingRead({poolId: id, caller: msg.sender});
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
        revert HookNotImplemented();
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
        _touchGrad(id, p);
        return "";
    }

    function _readCallData(Pool storage p) internal view returns (bytes memory) {
        uint8 k = p.anchorKind;
        if (k == C.ANCHOR_LZ) return abi.encodeWithSelector(IEthAnchor.latest.selector);
        if (k == C.ANCHOR_LZ_V4_ORACLE) {
            return abi.encodeWithSelector(IV4OracleHook.consult.selector, p.refPoolId, uint32(C.TWAP_WINDOW));
        }
        if (k == C.ANCHOR_LZ_V4_SLOT) return abi.encodeWithSelector(V4SlotReader.read.selector, p.refPoolId);
        revert SameChain();
    }
}
