// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC6909Claims} from "@uniswap/v4-core/src/interfaces/external/IERC6909Claims.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";
import {BridgeFixture} from "./BridgeFixture.sol";

/// @dev Foundry does not call setUp on a handler constructed with `new`, so setup lives in the constructor.
contract BridgeHandler is BridgeFixture {
    using CurrencyLibrary for Currency;

    constructor() {
        _deployStack(18);
        coin = _newCoin("JESUS", 18);
        (key, id) = _create(coin, 77e18, 1e18, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(id, 1e18, 725_000e18);
        usdg.mint(address(this), 1_000_000e18);
        coin.mint(address(this), 1_000_000e18);
    }

    function buy(uint256 amt) external {
        amt = bound(amt, 1e15, 4e18);
        try this.execBuy(amt) {} catch {}
    }

    function sell(uint256 amt) external {
        amt = bound(amt, 1e15, 4e18);
        try this.execSell(amt) {} catch {}
    }

    function depositAndRedeem(uint256 amt) external {
        amt = bound(amt, 1e15, 20e18);
        try this.execDepositRedeem(amt) {} catch {}
    }

    function execBuy(uint256 amt) external {
        _buy(key, address(coin), amt);
    }

    function execSell(uint256 amt) external {
        _sell(key, address(coin), amt);
    }

    function execDepositRedeem(uint256 amt) external {
        uint256 sh = hook.deposit(id, 0, amt);
        hook.redeem(id, sh);
    }
}

contract BridgeInvariantTest is Test {
    using CurrencyLibrary for Currency;

    BridgeHandler internal h;

    function setUp() public {
        h = new BridgeHandler();
        bytes4[] memory sel = new bytes4[](3);
        sel[0] = BridgeHandler.buy.selector;
        sel[1] = BridgeHandler.sell.selector;
        sel[2] = BridgeHandler.depositAndRedeem.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
        targetContract(address(h));
    }

    /// forge-config: default.invariant.runs = 20
    /// forge-config: default.invariant.depth = 10
    /// forge-config: default.invariant.fail_on_revert = false
    function invariant_reservesAndClaims() public view {
        assertTrue(h.hook().reserveOk(h.id()));
        assertGt(h.hook().spotPrice(h.id()), 0);
        assertEq(
            IERC6909Claims(address(h.manager())).balanceOf(address(h.hook()), Currency.wrap(address(h.usdg())).toId()),
            h.hook().usdgClaimsNorm()
        );
        assertEq(
            IERC6909Claims(address(h.manager())).balanceOf(address(h.hook()), Currency.wrap(address(h.coin())).toId()),
            h.hook().curve(h.id()).x
        );
    }
}
