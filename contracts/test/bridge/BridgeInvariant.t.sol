// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IERC6909Claims} from "@uniswap/v4-core/src/interfaces/external/IERC6909Claims.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";
import {BridgeFixture} from "./BridgeFixture.sol";
import {MockERC20} from "./mocks/BridgeMocks.sol";

/// @dev Foundry does not call setUp on a handler constructed with `new`, so setup lives in the constructor.
contract BridgeHandler is BridgeFixture {
    using CurrencyLibrary for Currency;

    constructor() {
        _deployStack(18);
        coin = _newCoin("JESUS", 18);
        (key, id) = _create(coin, 77e18, 1e18, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(id, 1e18, 725_000e18);
        other = _newCoin("OTHER", 18);
        (key2, id2) = _create(other, 77e18, 1e18, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(id2, 1e18, 50_000e18);
        usdg.mint(address(this), 1_000_000e18);
        coin.mint(address(this), 1_000_000e18);
        other.mint(address(this), 1_000_000e18);
    }

    MockERC20 public other;
    PoolKey public key2;
    PoolId public id2;

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

    function warp(uint256 dt) external {
        dt = bound(dt, 1, 3 hours);
        vm.warp(block.timestamp + dt);
        try hook.poke(id) {} catch {}
    }

    function moveAnchor(uint256 bps) external {
        bps = bound(bps, 1, 1_500);
        uint256 px = hook.curve(id).anchor;
        if (px == 0) return;
        vm.warp(block.timestamp + 31 minutes);
        try this.execPrice(px + (px * bps) / C.BPS) {} catch {}
    }

    function pokeGrad() external {
        try hook.poke(id) {} catch {}
        try hook.poke(id2) {} catch {}
    }

    function execPrice(uint256 px) external {
        _price(id, px, hook.referenceTvl(id));
    }
}

contract BridgeInvariantTest is Test {
    using CurrencyLibrary for Currency;

    BridgeHandler internal h;

    function setUp() public {
        h = new BridgeHandler();
        bytes4[] memory sel = new bytes4[](6);
        sel[0] = BridgeHandler.buy.selector;
        sel[1] = BridgeHandler.sell.selector;
        sel[2] = BridgeHandler.depositAndRedeem.selector;
        sel[3] = BridgeHandler.warp.selector;
        sel[4] = BridgeHandler.moveAnchor.selector;
        sel[5] = BridgeHandler.pokeGrad.selector;
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
        assertTrue(h.hook().reserveOk(h.id2()));
        assertEq(h.hook().usdgClaimsNorm(), h.hook().usdgHeld(h.id()) + h.hook().usdgHeld(h.id2()));
        (uint256 mark, uint256 principal) = h.hook().floorState(h.id());
        if (mark > 0) assertGe(principal, (mark * C.FLOOR_BPS) / C.BPS);
        assertLe(h.hook().feeCredit(h.id(), address(h)), h.hook().curve(h.id()).feePot);
        assertLe(h.hook().feeCredit(h.id2(), address(h)), h.hook().curve(h.id2()).feePot);
    }
}
