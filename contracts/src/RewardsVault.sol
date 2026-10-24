// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Community rewards vault (mode rules v2: receives sniper escrows of coins not graduated within
///        snipeEscrowTimeout, via BondingCurve.releaseSnipeEscrow; also 70% of any legacy FeeRouter.routeSnipeFee)
/// @notice Accrues sniper tax (any quote asset) for later USDG/rewards distribution.
///         v0: owner (multisig) distributes; per-token accounting is event-based (`RewardAccrued`).
contract RewardsVault {
    using SafeERC20 for IERC20;

    address public owner;
    address public feeRouter;
    /// @notice Total accrued per asset (lifetime, for indexers / dashboards).
    mapping(address => uint256) public totalAccrued;

    error OnlyOwner();
    error ZeroAddress();
    error LengthMismatch();

    event RewardAccrued(address indexed token, address indexed asset, uint256 amount);
    event Distributed(address indexed asset, address indexed to, uint256 amount);
    event OwnerTransferred(address indexed owner);

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    function setFeeRouter(address r) external onlyOwner {
        feeRouter = r;
    }

    function transferOwnership(address o) external onlyOwner {
        if (o == address(0)) revert ZeroAddress();
        owner = o;
        emit OwnerTransferred(o);
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
