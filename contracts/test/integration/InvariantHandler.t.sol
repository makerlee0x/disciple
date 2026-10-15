// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IntegrationBase, MockUSDG} from "./IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {Constants} from "../../src/libraries/Constants.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// @dev Handler for stateful fuzz: buys/sells under caps; never burns LockedLP after grad.
contract CurveHandler is Test {
    BondingCurve public curve;
    Token public tok;
    MockUSDG public quote;
    address[] public actors;
    uint256 public ghostQuoteIn;
    uint256 public ghostBuys;
    uint256 public ghostSells;

    constructor(BondingCurve curve_, Token tok_, MockUSDG quote_, address[] memory actors_) {
        curve = curve_;
        tok = tok_;
        quote = quote_;
        actors = actors_;
    }

    function buy(uint256 actorSeed, uint256 amountSeed) public {
        if (curve.graduated()) return;
        address a = actors[actorSeed % actors.length];
        uint256 amt = bound(amountSeed, 0.1 ether, 80 ether);
        quote.mint(a, amt);
        vm.startPrank(a);
        quote.approve(address(curve), amt);
        try curve.buy(amt, 0, block.timestamp + 1 hours) returns (uint256) {
            ghostQuoteIn += amt;
            ghostBuys++;
        } catch {}
        vm.stopPrank();
    }

    function sell(uint256 actorSeed, uint256 fracSeed) public {
        if (curve.graduated()) return;
        address a = actors[actorSeed % actors.length];
        uint256 bal = tok.balanceOf(a);
        if (bal < 1e15) return;
        uint256 amt = bal * bound(fracSeed, 1, 50) / 100;
        if (amt == 0) return;
        vm.startPrank(a);
        tok.approve(address(curve), amt);
        try curve.sell(amt, 0, block.timestamp + 1 hours) {
            ghostSells++;
        } catch {}
        vm.stopPrank();
    }
}

contract InvariantIntegrationTest is IntegrationBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    CurveHandler internal handler;
    BondingCurve internal invCurve;
    Token internal invTok;

    function setUp() public override {
        super.setUp();
        (invCurve, invTok) = _launch(0, 0);
        _warpPastSnipe();
        address[] memory acts = new address[](4);
        acts[0] = trader1;
        acts[1] = trader2;
        acts[2] = sniper;
        acts[3] = referred;
        handler = new CurveHandler(invCurve, invTok, quote, acts);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = CurveHandler.buy.selector;
        selectors[1] = CurveHandler.sell.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_noRoundTripProfit_sample() public {
        // Spot-check: small buy then sell from a funded actor never profits
        if (invCurve.graduated()) return;
        address a = trader1;
        uint256 qIn = 5 ether;
        quote.mint(a, qIn);
        vm.startPrank(a);
        quote.approve(address(invCurve), qIn);
        try invCurve.buy(qIn, 0, block.timestamp + 1) returns (uint256 tOut) {
            if (tOut > 0 && !invCurve.graduated()) {
                invTok.approve(address(invCurve), tOut);
                uint256 qOut = invCurve.sell(tOut, 0, block.timestamp + 1);
                assertLe(qOut, qIn, "invariant: round-trip no profit");
            }
        } catch {}
        vm.stopPrank();
    }

    function invariant_priceMonotonicWithSold() public view {
        if (invCurve.tokensSold() == 0) return;
        // market cap should be >= start
        assertGe(invCurve.marketCapUsd(), Constants.START_MCAP_USD * 99 / 100);
    }

    function invariant_walletCapNeverExceeded() public view {
        address[4] memory acts = [trader1, trader2, sniper, referred];
        uint256 cap = FeeMath.walletCap();
        for (uint256 i = 0; i < acts.length; i++) {
            assertLe(invCurve.balanceOnCurve(acts[i]), cap);
        }
    }

    function invariant_ifGraduated_LPNotBurned() public view {
        if (!invCurve.graduated()) return;
        (,,,,, bool g, uint128 liq) = lockedLP.positions(address(invTok));
        assertTrue(g);
        assertGt(liq, 0, "invariant: LockedLP liquidity not burned");
        (int24 tl, int24 tu, bytes32 salt) = lockedLP.positionTicks(address(invTok));
        PoolKey memory key = lockedLP.getPoolKey(address(invTok));
        (uint128 posLiq,,) = manager.getPositionInfo(key.toId(), address(lockedLP), tl, tu, salt);
        assertGt(posLiq, 0, "invariant: v4 position owned by LockedLP not burned");
    }
}
