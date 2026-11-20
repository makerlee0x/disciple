// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {DiscipleHook} from "../../src/DiscipleHook.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";

/// @notice Robinhood mainnet (4663) fork, maker 2026-11-19: run the real Deploy.s.sol (mainnet mode) on a fork, launch a
///         USDG coin, graduate it, buy and sell through the new hook, then claim each of the four shares and check they
///         land with the fixed recipients. No broadcast leaves the fork.
///         Run: forge test --match-path test/fork/HookClaimsFork.t.sol -vv   (needs the public RH mainnet RPC)
contract HookClaimsForkTest is Test {
    string internal constant MAINNET_RPC = "https://rpc.mainnet.chain.robinhood.com";
    address internal constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant STRATEGY = 0x168661C52E5922288dFb2b3f323b6Cf90eb21e18;

    address internal treasury = makeAddr("treasurySafe");
    address internal community = makeAddr("communitySafe");
    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");
    address internal bot = makeAddr("bot");

    Deploy.Out internal o;

    function setUp() public {
        vm.createSelectFork(MAINNET_RPC);
        vm.etch(community, hex"00"); // a Safe is a contract; Deploy refuses an EOA community Safe on 4663
        vm.setEnv("DISCIPLE_NETWORK", "mainnet");
        vm.setEnv("DISCIPLE_CHAIN_ID", "4663");
        vm.setEnv("POOL_MANAGER", vm.toString(PM));
        vm.setEnv("V4_QUOTER", vm.toString(QUOTER));
        vm.setEnv("USDG", vm.toString(USDG));
        vm.setEnv("EXPECT_USDG_DECIMALS", "6");
        vm.setEnv("DEFAULT_QUOTE", vm.toString(STRATEGY));
        vm.setEnv("MIN_LIQUIDITY", "10000000000000000");
        vm.setEnv("PROBE_USDG", "1000000");
        vm.setEnv("ERC5564_ANNOUNCER", "0x55649E01B5Df198D18D95b5cc5051630cfD45564");
        vm.setEnv("TREASURY", vm.toString(treasury));
        vm.setEnv("COMMUNITY_SAFE", vm.toString(community));
        vm.setEnv("PRICER_POKER", vm.toString(address(this)));
        vm.setEnv("SAFE", vm.toString(address(0)));
        vm.setEnv("DEPLOY_TEST_STRATEGY", "false");
        o = new Deploy().run();
    }

    function _launchUsdgCoin() internal returns (address token, BondingCurve curve) {
        vm.prank(creator);
        ILaunchpad.LaunchResult memory r = Launchpad(o.launchpad).launchCoin(
            ILaunchpad.LaunchParams({
                name: "Fork",
                ticker: "FORK",
                imageURI: "ipfs://x",
                description: "",
                socialsURI: "",
                quote: USDG,
                creatorTaxBps: 0,
                creatorBuyQuoteIn: 0,
                creatorBuyMinTokensOut: 0,
                deadline: block.timestamp + 1 hours
            })
        );
        token = r.token;
        curve = BondingCurve(r.curve);
    }

    function _graduate(BondingCurve curve) internal {
        vm.warp(block.timestamp + 1 hours);
        vm.roll(block.number + 10);
        for (uint256 i; i < 120 && !curve.graduated(); ++i) {
            address w = address(uint160(0xF0000 + i));
            deal(USDG, w, 5_000e6);
            vm.startPrank(w);
            IERC20(USDG).approve(address(curve), type(uint256).max);
            try curve.buy(2_000e6, 0, block.timestamp + 1) {} catch {
                try curve.buy(200e6, 0, block.timestamp + 1) {} catch {}
            }
            vm.stopPrank();
        }
        require(curve.graduated(), "fork: not graduated");
    }

    function test_fork_deployLaunchTradeClaim() public {
        DiscipleHook hook = DiscipleHook(o.hook);
        assertEq(hook.treasury(), treasury);
        assertEq(hook.communitySafe(), community);
        assertEq(hook.admin(), address(0), "admin renounced");
        assertEq(FeeRouter(o.feeRouter).referralSink(), community, "curve 1% to community");
        assertFalse(FeeRouter(o.feeRouter).authorizedCallers(o.hook));

        (address token, BondingCurve curve) = _launchUsdgCoin();
        _graduate(curve);

        DiscipleRouter router = DiscipleRouter(o.router);
        deal(USDG, trader, 1_000e6);
        vm.startPrank(trader);
        IERC20(USDG).approve(o.router, type(uint256).max);
        IERC20(token).approve(o.router, type(uint256).max);
        router.buyExactIn(token, 500e6, 1, trader, block.timestamp + 60);
        router.sellExactIn(token, IERC20(token).balanceOf(trader) / 2, 1, trader, block.timestamp + 60);
        vm.stopPrank();

        (uint256 cq, uint256 ct) = hook.claimable(token, 0);
        (uint256 lq, uint256 lt) = hook.claimable(token, 1);
        (uint256 tq, uint256 tt) = hook.claimable(token, 2);
        (uint256 kq, uint256 kt) = hook.claimable(token, 3);
        assertGt(cq + ct, 0, "creator owed");
        assertGt(kq + kt, 0, "community owed");

        uint256 c0 = IERC20(USDG).balanceOf(creator);
        uint256 t0 = IERC20(USDG).balanceOf(treasury);
        uint256 k0 = IERC20(USDG).balanceOf(community);
        (uint256 bT, uint256 bQ) = LockedLP(o.lockedLP).compoundBucket(token);
        vm.startPrank(bot); // anyone may claim; the bot receives nothing
        hook.claimCreatorFees(token);
        hook.claimLockedLiquidityFees(token);
        hook.claimTreasuryFees(token);
        hook.claimCommunityFees(token);
        vm.stopPrank();
        assertEq(IERC20(USDG).balanceOf(creator) - c0, cq);
        assertEq(IERC20(token).balanceOf(creator), ct);
        assertEq(IERC20(USDG).balanceOf(treasury) - t0, tq);
        assertEq(IERC20(token).balanceOf(treasury), tt);
        assertEq(IERC20(USDG).balanceOf(community) - k0, kq);
        assertEq(IERC20(token).balanceOf(community), kt);
        (uint256 bT2, uint256 bQ2) = LockedLP(o.lockedLP).compoundBucket(token);
        assertEq(bT2 - bT, lt);
        assertEq(bQ2 - bQ, lq);
        assertEq(IERC20(USDG).balanceOf(bot) + IERC20(token).balanceOf(bot), 0);
    }
}
