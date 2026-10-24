// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Owned2Step} from "./utils/Owned2Step.sol";

/// @title Community rewards vault (LOCKED #9 rev. 2026-10-15: 70% of anti-snipe tax)
/// @notice Accrues anti-snipe tax (any quote asset) for later USDG/rewards distribution.
///         v0: owner (multisig) distributes; per-token accounting is event-based (`RewardAccrued`).
///         Ownership is two-step (Owned2Step, as FeeRouter / LockedLP / Migration): the vault also receives released
///         sniper escrows, so a typo'd owner must never be able to strand it. The nominee calls acceptOwnership().
contract RewardsVault is Owned2Step {
    using SafeERC20 for IERC20;

    address public feeRouter;
    /// @notice Total accrued per asset (lifetime, for indexers / dashboards).
    mapping(address => uint256) public totalAccrued;

    error ZeroAddress();
    error LengthMismatch();

    event RewardAccrued(address indexed token, address indexed asset, uint256 amount);
    event Distributed(address indexed asset, address indexed to, uint256 amount);

    constructor(address owner_) Owned2Step(owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
    }

    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    function setFeeRouter(address r) external onlyOwner {
        feeRouter = r;
    }

    /// @notice Bookkeeping hook called by FeeRouter after transferring `amount` of `asset` here.
    function notifyReward(address token, address asset, uint256 amount) external {
        if (msg.sender != feeRouter) return; // ignore spoofed notifications (funds still land as plain balance)
        totalAccrued[asset] += amount;
        emit RewardAccrued(token, asset, amount);
    }

    function distribute(address asset, address[] calldata to, uint256[] calldata amounts) external onlyOwner {
        if (to.length != amounts.length) revert LengthMismatch();
        for (uint256 i; i < to.length; ++i) {
            IERC20(asset).safeTransfer(to[i], amounts[i]);
            emit Distributed(asset, to[i], amounts[i]);
        }
    }
}
