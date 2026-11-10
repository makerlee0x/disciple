// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {console2} from "forge-std/console2.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {LoginGate} from "../../src/LoginGate.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {Constants} from "../../src/libraries/Constants.sol";
import {CurveDeployerV1} from "./legacy/CurveDeployerV1.sol";

/// @notice Gas table for the lp-accrue follow-ups (same file runs on c6762441 and on the follow-up branch).
///         Cold access per measured call (vm.cool on every touched contract), steady state (warm-up trade first).
contract LpAccrueFollowupGasTest is IntegrationBase {
    uint256 internal n_;

    function setUp() public override {
        super.setUp();
        LoginGate g = new LoginGate(owner, makeAddr("attester"));
        vm.prank(owner);
        launchpad.setLoginGate(address(g));
    }

    function _launch(uint8 mode) internal returns (BondingCurve c, Token t) {
        vm.startPrank(creator);
        ILaunchpad.LaunchResult memory r = launchpad.launchWithMode(
            ILaunchpad.LaunchParams({
                name: "G",
                ticker: "G",
                imageURI: "ipfs://img",
                description: "",
                socialsURI: "",
                quote: address(quote),
                creatorTaxBps: 0,
                creatorBuyQuoteIn: 0,
                creatorBuyMinTokensOut: 0,
                deadline: vm.getBlockTimestamp() + 1 days
            }),
            mode
        );
        vm.stopPrank();
        c = BondingCurve(r.curve);
        t = Token(r.token);
    }

    function _w() internal returns (address w) {
        w = makeAddr(string(abi.encodePacked("gw", vm.toString(++n_))));
        quote.mint(w, 10_000_000 ether);
    }

    function _cool(BondingCurve c, Token t) internal {
        address[8] memory a = [
            address(c),
            address(t),
            address(quote),
            address(feeRouter),
            address(lockedLP),
            address(launchpad),
            address(referrals),
            address(feeVault)
        ];
        for (uint256 i; i < a.length; ++i) {
            vm.cool(a[i]);
        }
    }

    function _gBuy(BondingCurve c, Token t, address w, uint256 q) internal returns (uint256 g) {
        vm.startPrank(w);
        quote.approve(address(c), q);
        _cool(c, t);
        g = gasleft();
        c.buy(q, 0, block.timestamp + 1);
        g -= gasleft();
        vm.stopPrank();
    }

    function _gSell(BondingCurve c, Token t, address w) internal returns (uint256 g) {
        uint256 n = t.balanceOf(w) / 10;
        vm.startPrank(w);
        t.approve(address(c), n);
        _cool(c, t);
        g = gasleft();
        c.sell(n, 0, block.timestamp + 1);
        g -= gasleft();
        vm.stopPrank();
    }

    function _log(string memory k, uint256 v) internal pure {
        console2.log(string.concat("GAS ", k), v);
    }

    function test_gas_followups_tradePath() public {
        (BondingCurve c, Token t) = _launch(Constants.MODE_TRENCH);
        (BondingCurve p, Token pt) = _launch(Constants.MODE_PVE);
        _warpPastSnipe();
        address w = _w();
        _gBuy(c, t, w, 50 ether); // warm-up
        _gBuy(p, pt, w, 50 ether);
        vm.roll(block.number + 1);
        _log("buy_pre_timeout", _gBuy(c, t, w, 10 ether));
        _log("sell_pre_timeout", _gSell(c, t, w));
        _log("pve_buy_pre_timeout", _gBuy(p, pt, w, 10 ether));
        _log("pve_sell_pre_timeout", _gSell(p, pt, w));
        _bindReferral(referred, kol, 100 ether);
        quote.mint(referred, 1_000 ether);
        _gBuy(c, t, referred, 20 ether);
        _log("referred_buy_pre_timeout", _gBuy(c, t, referred, 10 ether));
        _log("referred_sell_pre_timeout", _gSell(c, t, referred));

        // past the 12-day timeout (not released yet): first trade after the timeout, then steady state
        vm.warp(c.launchTime() + c.snipeEscrowTimeout() + 1);
        _log("buy_first_after_timeout", _gBuy(c, t, w, 10 ether));
        _log("buy_after_timeout", _gBuy(c, t, w, 10 ether));
        _log("sell_after_timeout", _gSell(c, t, w));
        _log("referred_buy_after_timeout", _gBuy(c, t, referred, 10 ether));

        // release (sniper tax 0 here; LP share only), then trades after the release
        _cool(c, t);
        vm.cool(address(rewardsVault));
        uint256 g = gasleft();
        c.releaseSnipeEscrow();
        _log("release", g - gasleft());
        _log("buy_after_release", _gBuy(c, t, w, 10 ether));
        _log("sell_after_release", _gSell(c, t, w));
        // repeat release: the LP share of the trades since the first release
        _cool(c, t);
        vm.cool(address(rewardsVault));
        g = gasleft();
        c.releaseSnipeEscrow();
        _log("repeat_release", g - gasleft());
    }

    function test_gas_followups_claimAndSettle() public {
        (BondingCurve c, Token t) = _launch(Constants.MODE_TRENCH);
        _warpPastSnipe();
        address w = _w();
        _gBuy(c, t, w, 50 ether);
        _gBuy(c, t, w, 10 ether);
        _cool(c, t);
        vm.prank(creator);
        uint256 g = gasleft();
        feeVault.claimCreatorFees(address(t));
        _log("vault_claimCreatorFees_incl_settle", g - gasleft());
        _gBuy(c, t, w, 10 ether);
        _cool(c, t);
        g = gasleft();
        c.settleFees();
        _log("settleFees_standalone", g - gasleft());
    }

    function _gradGas(BondingCurve c) internal returns (uint256 gradGas) {
        for (uint256 i = 0; i < 80 && !c.graduated(); i++) {
            address w = makeAddr(string(abi.encodePacked("gg", vm.toString(i))));
            quote.mint(w, 50_000 ether);
            uint256[6] memory sizes = [uint256(400 ether), 200 ether, 100 ether, 50 ether, 10 ether, 1 ether];
            for (uint256 j = 0; j < sizes.length && !c.graduated(); j++) {
                vm.startPrank(w);
                quote.approve(address(c), sizes[j]);
                uint256 g = gasleft();
                try c.buy(sizes[j], 0, block.timestamp + 1) {
                    uint256 used = g - gasleft();
                    vm.stopPrank();
                    if (c.graduated()) gradGas = used;
                    break;
                } catch {
                    vm.stopPrank();
                }
            }
        }
    }

    function test_gas_followups_graduatingBuy() public {
        (BondingCurve c,) = _launch(Constants.MODE_TRENCH);
        _warpPastSnipe();
        _log("graduating_buy_pre_timeout", _gradGas(c));
    }

    function test_gas_followups_graduatingBuy_afterTimeoutAndRelease() public {
        (BondingCurve c, Token t) = _launch(Constants.MODE_TRENCH);
        _warpPastSnipe();
        address w = _w();
        _gBuy(c, t, w, 50 ether);
        vm.warp(c.launchTime() + c.snipeEscrowTimeout() + 1);
        c.releaseSnipeEscrow();
        _gBuy(c, t, w, 10 ether); // post-release LP share accrues
        _log("graduating_buy_after_release", _gradGas(c));
    }

    /// @dev Graduating after day 12 with LP fees still escrowed (never released).
    function test_gas_followups_graduatingBuy_afterTimeout_noRelease() public {
        (BondingCurve c, Token t) = _launch(Constants.MODE_TRENCH);
        _warpPastSnipe();
        address w = _w();
        _gBuy(c, t, w, 50 ether);
        vm.warp(c.launchTime() + c.snipeEscrowTimeout() + 1);
        _gBuy(c, t, w, 10 ether);
        _log("graduating_buy_after_timeout_no_release", _gradGas(c));
    }

    /// @dev DiscipleRouter.claimCreatorFeesToUsdg on a pre-lp-accrue (legacy) USDG-paired curve: FeeRouter only.
    function test_gas_followups_routerClaim_legacyCurve() public {
        router.setUsdgRouting(address(quote), address(launchpad)); // V4Deploy: router owner = this test
        address v1 = address(new CurveDeployerV1());
        vm.prank(owner);
        launchpad.setCurveDeployer(v1);
        (BondingCurve c, Token t) = _launch(Constants.MODE_TRENCH);
        _warpPastSnipe();
        address w = _w();
        _gBuy(c, t, w, 50 ether);
        _cool(c, t);
        vm.cool(address(router));
        vm.prank(creator);
        uint256 g = gasleft();
        router.claimCreatorFeesToUsdg(address(t), 1);
        _log("router_claimCreatorFeesToUsdg_legacy_curve", g - gasleft());
    }
}
