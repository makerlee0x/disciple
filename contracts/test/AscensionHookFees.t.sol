// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IntegrationBase} from "./integration/IntegrationBase.sol";
import {Token} from "../src/Token.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {AscensionHook} from "../src/AscensionHook.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @notice Post-graduation 1% is taken onto AscensionHook during the swap and booked later via collectFees.
contract AscensionHookFeesTest is IntegrationBase {
    using PoolIdLibrary for PoolKey;

    function test_afterSwap_takesFeeOntoHook_andCollectBooksSplit() public {
        autoCollectHookFees = false;
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _graduate(curve);

        PoolKey memory key = _poolKey(tok);
        PoolId id = key.toId();
        uint256 hookTok0 = tok.balanceOf(address(hook));
        uint256 routerTok0 = tok.balanceOf(address(feeRouter));
        uint256 creatorTok0 = feeRouter.creatorTokenAccrued(address(tok), creator);

        _swapExactInQuoteForToken(tok, trader1, 20 * U);

        // Buy fee is on the launch token (output). The swapper is the v4 test router.
        uint256 pending = hook.pendingFee(id, address(tok), address(swapRouter));
        assertGt(pending, 0, "the 1% sits on the hook");
        assertEq(tok.balanceOf(address(hook)) - hookTok0, pending);
        assertEq(tok.balanceOf(address(feeRouter)), routerTok0, "FeeRouter is not called during the swap");
        assertEq(feeRouter.creatorTokenAccrued(address(tok), creator), creatorTok0);

        // A failing payout must not stop a later trade.
        vm.mockCallRevert(address(feeRouter), abi.encodeWithSelector(FeeRouter.routeHookFee.selector), "fail");
        address[] memory traders = new address[](1);
        traders[0] = address(swapRouter);
        vm.expectRevert();
        hook.collectFees(key, traders);
        assertEq(hook.pendingFee(id, address(tok), address(swapRouter)), pending);

        _swapExactInQuoteForToken(tok, trader1, 20 * U);
        uint256 pending2 = hook.pendingFee(id, address(tok), address(swapRouter));
        assertGt(pending2, pending, "a later swap still takes its fee onto the hook");

        vm.clearMockedCalls();
        (uint256 tokenAmount,) = hook.collectFees(key, traders);
        assertEq(tokenAmount, pending2);
        assertEq(hook.pendingFee(id, address(tok), address(swapRouter)), 0);
        assertEq(tok.balanceOf(address(hook)), hookTok0);
        assertGt(
            feeRouter.creatorTokenAccrued(address(tok), creator),
            creatorTok0,
            "collect books the official creator share"
        );
    }
}
