// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {Vm} from "forge-std/Vm.sol";
import {IntegrationBase, MockUSDG} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";

/// @notice Consistent swap gas benchmark. Run with `forge test --mc GasBench --isolate -vv` so every measured call is
///         its own transaction (cold storage/accounts, EIP-2929 accurate). Numbers are `lastCallGas().gasTotalUsed`
///         (execution gas, excludes the 21k intrinsic + calldata). "cold" = trader's first ever trade (fresh wallet);
///         "warm" = the same trader's second trade (balances already non-zero). Uses only the pre-existing API so the
///         same file runs on the BEFORE and AFTER commits.
contract GasBench is IntegrationBase {
    BondingCurve sCurve; // STRATEGY-quoted coin (USDG route = 2 hops)
    Token sTok;
    BondingCurve uCurve; // USDG-quoted coin (USDG route = 1 hop)
    Token uTok;

    function setUp() public override {
        super.setUp();
        router.setUsdgRouting(address(quote), address(launchpad));
        router.setUsdgPool(address(strategy), strategyUsdgKey);
        (sCurve, sTok) = _launchWithQuote(address(strategy), 100, 0); // 1% creator tax (typical)
        (uCurve, uTok) = _launchWithQuote(address(quote), 100, 0);
        _warpPastSnipe();
        // seed some depth / other holders
        _seed(sCurve, strategy);
        _seed(uCurve, quote);
    }

    function _seed(BondingCurve c, MockUSDG q) internal {
        address w = makeAddr(string(abi.encodePacked("seed", address(c))));
        q.mint(w, 1000 ether);
        vm.startPrank(w);
        q.approve(address(c), 1000 ether);
        c.buy(500 ether, 0, block.timestamp + 1);
        vm.stopPrank();
    }

    function _wallet(string memory n) internal returns (address w) {
        w = makeAddr(n);
        quote.mint(w, 100_000 ether);
        strategy.mint(w, 100_000 ether);
        vm.startPrank(w);
        quote.approve(address(router), type(uint256).max);
        strategy.approve(address(router), type(uint256).max);
        quote.approve(address(uCurve), type(uint256).max);
        sTok.approve(address(router), type(uint256).max);
        uTok.approve(address(router), type(uint256).max);
        uTok.approve(address(uCurve), type(uint256).max);
        vm.stopPrank();
    }

    function _g() internal view returns (uint256) {
        return vm.lastCallGas().gasTotalUsed;
    }

    function _log(string memory k, uint256 g) internal pure {
        console2.log(string(abi.encodePacked("BENCH ", k)), g);
    }

    function _dl() internal view returns (uint256) {
        return block.timestamp + 1 hours;
    }

    // ── curve (pre-graduation) ──
    function test_bench_curve() public {
        address a = _wallet("benchA");
        // direct curve
        vm.prank(a);
        uCurve.buy(20 ether, 1, _dl(), a);
        _log("curve.direct.buy.cold", _g());
        vm.prank(a);
        uCurve.buy(20 ether, 1, _dl(), a);
        _log("curve.direct.buy.warm", _g());
        uint256 half = uTok.balanceOf(a) / 4;
        vm.prank(a);
        uCurve.sell(half, 1, _dl(), a);
        _log("curve.direct.sell.warm", _g());

        // USDG 1-hop (USDG-quoted coin)
        address b = _wallet("benchB");
        vm.prank(b);
        router.buyWithUsdg(address(uTok), 20 ether, 1, _dl());
        _log("curve.usdg1.buy.cold", _g());
        vm.prank(b);
        router.buyWithUsdg(address(uTok), 20 ether, 1, _dl());
        _log("curve.usdg1.buy.warm", _g());
        uint256 bt = uTok.balanceOf(b) / 4;
        vm.prank(b);
        router.sellToUsdg(address(uTok), bt, 1, _dl());
        _log("curve.usdg1.sell.warm", _g());

        // USDG 2-hop (STRATEGY-quoted coin)
        address c = _wallet("benchC");
        vm.prank(c);
        router.buyWithUsdg(address(sTok), 20 ether, 1, _dl());
        _log("curve.usdg2.buy.cold", _g());
        vm.prank(c);
        router.buyWithUsdg(address(sTok), 20 ether, 1, _dl());
        _log("curve.usdg2.buy.warm", _g());
        uint256 ct = sTok.balanceOf(c) / 4;
        vm.prank(c);
        router.sellToUsdg(address(sTok), ct, 1, _dl());
        _log("curve.usdg2.sell.warm", _g());
    }

    // ── graduated v4 pool ──
    function test_bench_v4() public {
        _graduateWith(uCurve, quote);
        _graduateWith(sCurve, strategy);
        address a = _wallet("benchD");
        vm.prank(a);
        router.buyExactIn(address(uTok), 20 ether, 1, a, _dl());
        _log("v4.direct.buy.cold", _g());
        vm.prank(a);
        router.buyExactIn(address(uTok), 20 ether, 1, a, _dl());
        _log("v4.direct.buy.warm", _g());
        uint256 at = uTok.balanceOf(a) / 4;
        vm.prank(a);
        router.sellExactIn(address(uTok), at, 1, a, _dl());
        _log("v4.direct.sell.warm", _g());

        address b = _wallet("benchE");
        vm.prank(b);
        router.buyWithUsdg(address(uTok), 20 ether, 1, _dl());
        _log("v4.usdg1.buy.cold", _g());
        vm.prank(b);
        router.buyWithUsdg(address(uTok), 20 ether, 1, _dl());
        _log("v4.usdg1.buy.warm", _g());
        uint256 bt = uTok.balanceOf(b) / 4;
        vm.prank(b);
        router.sellToUsdg(address(uTok), bt, 1, _dl());
        _log("v4.usdg1.sell.warm", _g());

        address c = _wallet("benchF");
        vm.prank(c);
        router.buyWithUsdg(address(sTok), 20 ether, 1, _dl());
        _log("v4.usdg2.buy.cold", _g());
        vm.prank(c);
        router.buyWithUsdg(address(sTok), 20 ether, 1, _dl());
        _log("v4.usdg2.buy.warm", _g());
        uint256 ct = sTok.balanceOf(c) / 4;
        vm.prank(c);
        router.sellToUsdg(address(sTok), ct, 1, _dl());
        _log("v4.usdg2.sell.warm", _g());
    }
}

import {LoginGate} from "../../src/LoginGate.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";

/// @notice Mode overhead (AFTER only): same trades on TRENCH / PVP / PVE USDG-quoted coins. `--isolate`.
contract GasBenchModes is IntegrationBase {
    uint256 constant PK = 0xA77E57;
    LoginGate gate;

    function setUp() public override {
        super.setUp();
        router.setUsdgRouting(address(quote), address(launchpad));
        gate = new LoginGate(owner, vm.addr(PK));
        vm.prank(owner);
        launchpad.setLoginGate(address(gate));
    }

    function _coin(uint8 m) internal returns (BondingCurve c, Token t) {
        vm.prank(creator);
        ILaunchpad.LaunchResult memory r = launchpad.launchWithMode(
            ILaunchpad.LaunchParams({
                name: "M",
                ticker: "M",
                imageURI: "i",
                description: "",
                socialsURI: "",
                quote: address(quote),
                creatorTaxBps: 100,
                creatorBuyQuoteIn: 0,
                creatorBuyMinTokensOut: 0,
                deadline: block.timestamp + 1 days
            }),
            m
        );
        c = BondingCurve(r.curve);
        t = Token(r.token);
    }

    function _w(string memory n, BondingCurve c, Token t) internal returns (address w) {
        w = makeAddr(n);
        quote.mint(w, 100_000 ether);
        uint64 exp = uint64(block.timestamp + 30 days);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, gate.digest(w, exp, address(0)));
        gate.attest(w, exp, address(0), abi.encodePacked(r, s, v));
        vm.startPrank(w);
        quote.approve(address(c), type(uint256).max);
        quote.approve(address(router), type(uint256).max);
        t.approve(address(c), type(uint256).max);
        t.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _run(uint8 m, string memory tag) internal {
        (BondingCurve c, Token t) = _coin(m);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 8 minutes);
        address s = _w(string(abi.encodePacked("seed", tag)), c, t);
        vm.prank(s);
        c.buy(20 ether, 1, block.timestamp + 1 hours, s);
        address a = _w(string(abi.encodePacked("a", tag)), c, t);
        vm.prank(a);
        c.buy(5 ether, 1, block.timestamp + 1 hours, a);
        console2.log(string(abi.encodePacked("BENCH ", tag, ".direct.buy.cold")), vm.lastCallGas().gasTotalUsed);
        vm.prank(a);
        c.buy(5 ether, 1, block.timestamp + 1 hours, a);
        console2.log(string(abi.encodePacked("BENCH ", tag, ".direct.buy.warm")), vm.lastCallGas().gasTotalUsed);
        uint256 y = t.balanceOf(a) / 4;
        vm.prank(a);
        c.sell(y, 1, block.timestamp + 1 hours, a);
        console2.log(string(abi.encodePacked("BENCH ", tag, ".direct.sell.warm")), vm.lastCallGas().gasTotalUsed);
        vm.prank(a);
        router.buyWithUsdg(address(t), 5 ether, 1, block.timestamp + 1 hours);
        console2.log(string(abi.encodePacked("BENCH ", tag, ".usdg1.buy.warm")), vm.lastCallGas().gasTotalUsed);
        uint256 x = t.balanceOf(a) / 4;
        vm.prank(a);
        router.sellToUsdg(address(t), x, 1, block.timestamp + 1 hours);
        console2.log(string(abi.encodePacked("BENCH ", tag, ".usdg1.sell.warm")), vm.lastCallGas().gasTotalUsed);
    }

    function test_bench_modes_trench() public {
        _run(0, "trench");
    }

    function test_bench_modes_pve() public {
        _run(1, "pve");
    }

    function test_bench_modes_pvp() public {
        _run(2, "pvp");
    }
}
