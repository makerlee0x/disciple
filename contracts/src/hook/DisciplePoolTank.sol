// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

interface IWETH9 {
    function withdraw(uint256) external;
    function balanceOf(address) external view returns (uint256);
}

interface IDiscipleTank {
    function fundTank(PoolId id) external payable;
}

/// @title DisciplePoolTank
/// @notice One per pool. The pool's TJAR releaser pays its WETH here by plain transfer (no callback); anyone calls
///         `flush` to unwrap it and top up that pool's refresh tank in the hook. Native ETH sent here is forwarded
///         too. Immutable WETH, hook and pool: funds can only ever go to that one pool's tank.
contract DisciplePoolTank {
    IWETH9 public immutable weth;
    IDiscipleTank public immutable hook;
    PoolId public immutable id;

    event Flushed(uint256 amount);

    constructor(IWETH9 weth_, IDiscipleTank hook_, PoolId id_) {
        weth = weth_;
        hook = hook_;
        id = id_;
    }

    function flush() external returns (uint256 amount) {
        uint256 w = weth.balanceOf(address(this));
        if (w != 0) weth.withdraw(w);
        amount = address(this).balance;
        if (amount != 0) hook.fundTank{value: amount}(id);
        emit Flushed(amount);
    }

    receive() external payable {}
}
