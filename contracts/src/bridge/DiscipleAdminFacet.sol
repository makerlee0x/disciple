// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeConstants as C} from "./libraries/BridgeConstants.sol";
import {BridgeCurve} from "./libraries/BridgeCurve.sol";
import {BridgeFee} from "./libraries/BridgeFee.sol";
import {BridgeEngine} from "./BridgeEngine.sol";
import {ILzRead} from "./interfaces/ILzRead.sol";
import {IEthAnchor} from "./interfaces/IEthAnchor.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BridgeFacetBase} from "./BridgeFacetBase.sol";

/// @title Disciple vault facet
/// @notice Price updates, the Morpho cap, the loss pull, and the narrow vault admin for Disciple
///         (`BridgeLaunchHook`). Called through the hook. `pullShortfall` and `afterTrade` are how a
///         swap reaches the vault without copying this code into the swap facet.
contract BridgeAdminFacet is BridgeFacetBase {
    using SafeERC20 for IERC20;

    constructor(
        IPoolManager manager_,
        address usdg_,
        address vault_,
        address lz_,
        uint8 usdgDecimals_,
        BridgeEngine engine_
    ) BridgeFacetBase(manager_, usdg_, vault_, lz_, usdgDecimals_, engine_) {}

    /// @notice Ask LayerZero to read `IEthAnchor.latest` on the pool's remote oracle.
    ///         The caller pays the native lzRead fee and never submits a price.
    ///         A tip is escrowed only when the stored quote is stale (or missing). Spam of a fresh quote reverts.
    function updatePrice(PoolId id) external payable {
        _onlyDelegate();
        if (_locked) revert Reentrancy();
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        if (p.anchorKind != C.ANCHOR_LZ) revert SameChain();
        bool stale = p.curve.anchor == 0 || block.timestamp >= p.updatedAt + C.STALE_AFTER;
        if (!stale) revert Fresh();

        _locked = true;
        ILzRead.EvmRead memory read = ILzRead.EvmRead({
            targetEid: p.remoteEid,
            target: p.remoteOracle,
            callData: abi.encodeWithSelector(IEthAnchor.latest.selector),
            minConfirmations: 1
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

    /// @notice Push idle USDG (above the floor, the trading buffer, and the Morpho cap) into the vault.
    function rebalance(PoolId id) external {
        _onlyDelegate();
        if (_locked) revert Reentrancy();
        _locked = true;
        poolManager.unlock(abi.encode(OP_REBALANCE, PoolId.unwrap(id)));
        _locked = false;
    }

    /// @notice Pull the whole vault position back into the pool when the share price has dropped.
    function pullVaultOnLoss(PoolId id) external {
        _onlyDelegate();
        if (_locked) revert Reentrancy();
        _locked = true;
        poolManager.unlock(abi.encode(OP_LOSS, PoolId.unwrap(id)));
        _locked = false;
    }

    /// @notice Vault admin: queue a replacement ERC-4626 for the same USDG. Restarts the 48h clock.
    function proposeVault(PoolId id, address next) external {
        _onlyDelegate();
        if (_locked) revert Reentrancy();
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        if (p.vaultAdmin == address(0) || msg.sender != p.vaultAdmin) revert OnlyVaultAdmin();
        if (next == address(0) || next == p.poolVault) revert BadCreate();
        _locked = true;
        if (IERC4626(next).asset() != usdg) revert VaultAsset();
        _locked = false;
        p.pendingVault = next;
        p.vaultEta = block.timestamp + C.VAULT_TIMELOCK;
        emit VaultProposed(id, next, p.vaultEta);
    }

    /// @notice Anyone, once the 48h timelock has passed. Empties the current vault, then switches.
    function executeVault(PoolId id) external {
        _onlyDelegate();
        if (_locked) revert Reentrancy();
        _locked = true;
        poolManager.unlock(abi.encode(OP_EXEC, PoolId.unwrap(id)));
        _locked = false;
    }

    /// @notice Vault admin: pull every vault share back into the pool now. Does not freeze deposits.
    function pullAllFromVault(PoolId id) external {
        _onlyDelegate();
        if (_locked) revert Reentrancy();
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        if (p.vaultAdmin == address(0) || msg.sender != p.vaultAdmin) revert OnlyVaultAdmin();
        _locked = true;
        poolManager.unlock(abi.encode(OP_PULL, PoolId.unwrap(id)));
        _locked = false;
    }

    /// @notice Vault admin: burn the key. Pending proposals die with it.
    function renounceVaultAdmin(PoolId id) external {
        _onlyDelegate();
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        if (p.vaultAdmin == address(0) || msg.sender != p.vaultAdmin) revert OnlyVaultAdmin();
        p.vaultAdmin = address(0);
        p.pendingVault = address(0);
        p.vaultEta = 0;
        emit VaultAdminRenounced(id);
    }

    /// @dev Swap path. `msg.sender` stays the pool manager across the nested delegatecall.
    function pullShortfall(PoolId id, uint256 shortNorm) external returns (bool) {
        _onlyDelegate();
        return _withdrawVault(pools[id], shortNorm);
    }

    /// @dev Swap path. Graduates, then deposits idle USDG up to the cap.
    function afterTrade(PoolId id) external {
        _onlyDelegate();
        Pool storage p = pools[id];
        _maybeGraduate(id, p);
        _rebalance(id, p);
    }

    function handle(bytes calldata data) external returns (bytes memory) {
        _onlyDelegate();
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        uint8 op = abi.decode(data, (uint8));
        if (op == OP_REBALANCE) return _onRebalance(data);
        if (op == OP_LOSS) return _onLoss(data);
        if (op == OP_PULL) return _onPull(data);
        if (op == OP_EXEC) return _onExec(data);
        revert HookNotImplemented();
    }

    function _onRebalance(bytes calldata data) internal returns (bytes memory) {
        (, bytes32 rawId) = abi.decode(data, (uint8, bytes32));
        PoolId id = PoolId.wrap(rawId);
        _persistReference(pools[id]);
        _rollBlock(pools[id], id);
        _maybeGraduate(id, pools[id]);
        _rebalance(id, pools[id]);
        return "";
    }

    function _onLoss(bytes calldata data) internal returns (bytes memory) {
        (, bytes32 rawId) = abi.decode(data, (uint8, bytes32));
        PoolId id = PoolId.wrap(rawId);
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        if (p.vaultShares == 0) revert NoLoss();
        uint256 preview = _toNorm(IERC4626(p.poolVault).previewRedeem(p.vaultShares), usdgDec);
        if (preview >= p.vaultAssets) revert NoLoss();
        uint256 accounted = p.vaultAssets;
        uint256 got = _exitAll(p);
        uint256 loss = accounted > got ? accounted - got : 0;
        p.vaultFrozen = true;
        emit VaultLossPulled(id, got, loss);
        return "";
    }

    function _onPull(bytes calldata data) internal returns (bytes memory) {
        (, bytes32 rawId) = abi.decode(data, (uint8, bytes32));
        Pool storage p = pools[PoolId.wrap(rawId)];
        _exitAll(p);
        return "";
    }

    function _onExec(bytes calldata data) internal returns (bytes memory) {
        (, bytes32 rawId) = abi.decode(data, (uint8, bytes32));
        PoolId id = PoolId.wrap(rawId);
        Pool storage p = pools[id];
        if (!p.exists) revert UnknownPool();
        if (p.pendingVault == address(0) || block.timestamp < p.vaultEta) revert Timelock();
        address next = p.pendingVault;
        if (IERC4626(next).asset() != usdg) revert VaultAsset();
        _exitAll(p);
        p.poolVault = next;
        p.pendingVault = address(0);
        p.vaultEta = 0;
        p.vaultFrozen = false;
        emit VaultSet(id, next);
        return "";
    }

    function _rebalance(PoolId id, Pool storage p) internal {
        if (!p.graduated || p.poolVault == address(0)) return;
        _syncVault(p);
        uint256 principal = p.curve.protoY + p.curve.lpY;
        uint256 floorAmt = (principal * p.floorBps) / C.BPS;
        uint256 buf = BridgeFee.buffer(BridgeCurve.tvl(p.curve));
        uint256 keep = floorAmt + buf;
        if (keep > principal) keep = principal;
        uint256 cap = Math.mulDiv(principal, p.morphoCapBps, C.BPS);
        uint256 maxInVault = principal > keep ? principal - keep : 0;
        if (maxInVault > cap) maxInVault = cap;

        if (p.vaultAssets > maxInVault) {
            // Best-effort. A dead vault must not brick the swap that called rebalance.
            _withdrawVault(p, p.vaultAssets - maxInVault);
            return;
        }
        if (p.vaultFrozen) return;
        uint256 investNorm = maxInVault > p.vaultAssets ? maxInVault - p.vaultAssets : 0;
        uint256 liquid = principal > p.vaultAssets ? principal - p.vaultAssets : 0;
        uint256 room = liquid > keep ? liquid - keep : 0;
        if (investNorm > room) investNorm = room;
        uint256 raw = _toRaw(investNorm, usdgDec);
        if (raw == 0) return;
        uint256 norm = _toNorm(raw, usdgDec);
        _claimsTo(usdgC, raw, address(this));
        usdgClaimsNorm -= norm;
        IERC20(usdg).forceApprove(p.poolVault, raw);
        uint256 sh = IERC4626(p.poolVault).deposit(raw, address(this));
        p.vaultShares += sh;
        p.vaultAssets += norm;
        emit VaultDeposit(id, norm);
    }

    function _syncVault(Pool storage p) internal {
        if (p.vaultShares == 0 || p.poolVault == address(0)) return;
        uint256 assetsRaw = IERC4626(p.poolVault).previewRedeem(p.vaultShares);
        uint256 assets = _toNorm(assetsRaw, usdgDec);
        if (assets == p.vaultAssets) return;
        if (assets > p.vaultAssets) {
            uint256 yld = assets - p.vaultAssets;
            p.vaultAssets = assets;
            // Yield stays in the vault and accrues to protocol inventory (not boosted principal).
            p.curve.y += yld;
            p.curve.protoY += yld;
        } else {
            uint256 loss = p.vaultAssets - assets;
            p.vaultAssets = assets;
            _socializeLoss(p, loss);
        }
    }

    /// @dev Withdraw `shortNorm` of accounted vault assets. Burns the shares the vault reports.
    ///      Returns false if the vault refuses. Accounting mismatches revert.
    function _withdrawVault(Pool storage p, uint256 shortNorm) internal returns (bool) {
        uint256 raw = _toRawUp(shortNorm, usdgDec);
        if (raw == 0 || p.vaultShares == 0 || p.poolVault == address(0)) return false;
        bool ok;
        uint256 burned;
        try IERC4626(p.poolVault).withdraw(raw, address(this), address(this)) returns (uint256 sharesBurned) {
            ok = true;
            burned = sharesBurned;
        } catch {
            return false;
        }
        if (burned > p.vaultShares) revert Invariant();
        p.vaultShares -= burned;
        uint256 gotNorm = _toNorm(raw, usdgDec);
        if (gotNorm < shortNorm || p.vaultAssets < gotNorm) revert Invariant();
        p.vaultAssets -= gotNorm;
        _walletToClaims(usdgC, raw);
        usdgClaimsNorm += gotNorm;
        emit VaultWithdraw(_id(p), gotNorm);
        return ok;
    }

    /// @dev Redeem every share this pool holds. Yield accrues to protocol inventory. A shortfall is a loss.
    function _exitAll(Pool storage p) internal returns (uint256 gotNorm) {
        uint256 sh = p.vaultShares;
        if (sh == 0 || p.poolVault == address(0)) return 0;
        uint256 beforeBal = IERC20(usdg).balanceOf(address(this));
        IERC4626(p.poolVault).redeem(sh, address(this), address(this));
        uint256 gotRaw = IERC20(usdg).balanceOf(address(this)) - beforeBal;
        gotNorm = _toNorm(gotRaw, usdgDec);
        if (gotNorm >= p.vaultAssets) {
            uint256 yld = gotNorm - p.vaultAssets;
            p.curve.y += yld;
            p.curve.protoY += yld;
        } else {
            _socializeLoss(p, p.vaultAssets - gotNorm);
        }
        p.vaultShares = 0;
        p.vaultAssets = 0;
        if (gotRaw > 0) {
            _walletToClaims(usdgC, gotRaw);
            usdgClaimsNorm += gotNorm;
        }
        emit VaultWithdraw(_id(p), gotNorm);
    }

    function _socializeLoss(Pool storage p, uint256 loss) internal {
        if (loss == 0) return;
        if (p.curve.protoY >= loss) {
            p.curve.protoY -= loss;
            p.curve.y -= loss;
            return;
        }
        uint256 rest = loss - p.curve.protoY;
        p.curve.y -= p.curve.protoY;
        p.curve.protoY = 0;
        if (p.curve.lpY >= rest) {
            p.curve.lpY -= rest;
            p.curve.y -= rest;
        } else {
            p.curve.y -= p.curve.lpY;
            p.curve.lpY = 0;
        }
    }
}
