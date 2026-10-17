// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CurveDeployer} from "../src/CurveDeployer.sol";
import {QuotePricer} from "../src/QuotePricer.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Constants} from "../src/libraries/Constants.sol";
import {FeeMath} from "../src/libraries/FeeMath.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {AntiSnipe} from "../src/AntiSnipe.sol";
import {ReferralRegistry} from "../src/ReferralRegistry.sol";
import {LockedLP} from "../src/LockedLP.sol";
import {Migration} from "../src/Migration.sol";
import {ILaunchpad} from "../src/interfaces/ILaunchpad.sol";
import {Token} from "../src/Token.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {V4Deploy} from "./helpers/V4Deploy.sol";
import {DiscipleHook} from "../src/DiscipleHook.sol";

import {RewardsVault} from "../src/RewardsVault.sol";

contract MockQuote is ERC20 {
    constructor() ERC20("USD Mock", "USDG") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }
}

/// @notice Pure-math + integration tests for Pump-style CPAMM curve ($7K→$33K @ 72%).
contract CurveTest is Test {
    RewardsVault internal rewardsVault;
    address internal treasury = makeAddr("treasury");
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MockQuote internal quote;
    ReferralRegistry internal referrals;
    LockedLP internal lockedLP;
    FeeRouter internal feeRouter;
    AntiSnipe internal antiSnipe;
    Migration internal migration;
    Launchpad internal launchpad;

    CurveMath.Params internal params;

    // Worked-table bands (USDG @$1)
    uint256 internal constant MCAP_0 = 7_000 ether;
    uint256 internal constant MCAP_10_MIN = 7_800 ether;
    uint256 internal constant MCAP_10_MAX = 8_600 ether;
    uint256 internal constant MCAP_25_MIN = 10_000 ether;
    uint256 internal constant MCAP_25_MAX = 11_200 ether;
    uint256 internal constant MCAP_50_MIN = 17_000 ether;
    uint256 internal constant MCAP_50_MAX = 19_000 ether;
    uint256 internal constant MCAP_72 = 33_000 ether;

    DiscipleHook internal hook;

    function setUp() public {
        quote = new MockQuote();
        referrals = new ReferralRegistry(owner);
        lockedLP = new LockedLP(owner, treasury);
        feeRouter = new FeeRouter(owner, treasury, address(referrals));

        // PoolManager + mined hook + Migration (3 CREATE/CREATE2)
        V4Deploy.Stack memory stack = V4Deploy.deploy(owner, lockedLP, feeRouter);
        migration = stack.migration;
        vm.startPrank(owner);
        lockedLP.setMigration(address(migration));
        lockedLP.setFeeRouter(address(feeRouter));
        lockedLP.setPoolManager(address(stack.manager));
        vm.stopPrank();
        hook = stack.hook;

        uint64 n = uint64(vm.getNonce(address(this)));
        address launchpadAddr = vm.computeCreateAddress(address(this), n + 1); // antiSnipe then launchpad
        antiSnipe = new AntiSnipe(launchpadAddr);
        launchpad = new Launchpad(owner, address(feeRouter), address(antiSnipe), address(migration));
        require(address(launchpad) == launchpadAddr, "predict");
        QuotePricer pricer_ = new QuotePricer(owner, IPoolManager(address(0)), address(quote));
        vm.prank(owner);
        launchpad.setPricer(address(pricer_));
        CurveDeployer cd_ = new CurveDeployer();
        vm.prank(owner);
        launchpad.setCurveDeployer(address(cd_));

        vm.startPrank(owner);
        feeRouter.setLaunchpad(address(launchpad));
        migration.setLaunchpad(address(launchpad));
        feeRouter.setLockedLP(address(lockedLP));
        feeRouter.setAuthorized(address(hook), true);
        rewardsVault = new RewardsVault(owner);
        rewardsVault.setFeeRouter(address(feeRouter));
        feeRouter.setRewardsVault(address(rewardsVault));
        vm.stopPrank();

        quote.mint(alice, 10_000_000 ether);
        quote.mint(bob, 10_000_000 ether);

        params = CurveMath.makeParams(1e18);
    }

    function _launch() internal returns (BondingCurve curve, Token tok) {
        uint256 ts = vm.getBlockTimestamp();
        vm.startPrank(alice);
        ILaunchpad.LaunchParams memory p = ILaunchpad.LaunchParams({
            name: "PumpCurve",
            ticker: "PUMP",
            imageURI: "ipfs://img",
            description: "",
            socialsURI: "",
            quote: address(quote),
            creatorTaxBps: 0,
            creatorBuyQuoteIn: 0,
            creatorBuyMinTokensOut: 0,
            deadline: ts + 1 hours
        });
        ILaunchpad.LaunchResult memory r = launchpad.launch(p);
        vm.stopPrank();
        curve = BondingCurve(r.curve);
        tok = Token(r.token);
        vm.warp(ts + 10); // past anti-snipe window
    }

    // ── Geometry ─────────────────────────────────────────────────────────────

    function test_params_geometry() public view {
        assertEq(params.sCurve, FeeMath.curveSoldSupply());
        assertTrue(params.y0 > params.sCurve);
        assertTrue(params.x0 > 0);
    }

    function test_mcap_at_zero_is_7k() public view {
        uint256 m = CurveMath.marketCapUsd(params, 0);
        assertApproxEqRel(m, MCAP_0, 0.01e18);
    }

    function test_mcap_at_graduation_is_33k() public view {
        uint256 m = CurveMath.marketCapUsd(params, params.sCurve);
        assertApproxEqRel(m, MCAP_72, 0.01e18);
    }

    function test_worked_table_0_10_25_50_72() public view {
        uint256 s10 = (Constants.TOTAL_SUPPLY * 10) / 100;
        uint256 s25 = (Constants.TOTAL_SUPPLY * 25) / 100;
        uint256 s50 = (Constants.TOTAL_SUPPLY * 50) / 100;

        uint256 m0 = CurveMath.marketCapUsd(params, 0);
        uint256 m10 = CurveMath.marketCapUsd(params, s10);
        uint256 m25 = CurveMath.marketCapUsd(params, s25);
        uint256 m50 = CurveMath.marketCapUsd(params, s50);
        uint256 m72 = CurveMath.marketCapUsd(params, params.sCurve);

        assertApproxEqRel(m0, MCAP_0, 0.01e18);
        assertGe(m10, MCAP_10_MIN);
        assertLe(m10, MCAP_10_MAX);
        assertGe(m25, MCAP_25_MIN);
        assertLe(m25, MCAP_25_MAX);
        assertGe(m50, MCAP_50_MIN);
        assertLe(m50, MCAP_50_MAX);
        assertApproxEqRel(m72, MCAP_72, 0.01e18);

        // Total quote raised at graduation ≈ $10,943
        uint256 raise = CurveMath.quoteInForTokens(params, 0, params.sCurve);
        assertApproxEqRel(raise, 10_943 ether, 0.02e18);
    }

    function test_price_monotonic_across_curve() public view {
        uint256 prev = 0;
        uint256 steps = 20;
        for (uint256 i = 0; i <= steps; i++) {
            uint256 s = (params.sCurve * i) / steps;
            uint256 px = CurveMath.spotPriceWad(params, s);
            assertGe(px, prev);
            prev = px;
        }
    }

    // ── Round-trip ───────────────────────────────────────────────────────────

    function test_roundTrip_smallBuySell_noProfit() public view {
        uint256 quoteIn = 100 ether;
        uint256 tOut = CurveMath.tokensOutForQuote(params, 0, quoteIn);
        assertGt(tOut, 0);
        uint256 qBack = CurveMath.quoteOutForTokens(params, tOut, tOut);
        assertLe(qBack, quoteIn);
    }

    function testFuzz_roundTrip_noProfit(uint256 soldSeed, uint256 quoteSeed) public view {
        uint256 sold = bound(soldSeed, 0, params.sCurve * 8 / 10);
        uint256 quoteIn = bound(quoteSeed, 0.01 ether, 5_000 ether);
        uint256 remaining = params.sCurve - sold;
        uint256 tOut = CurveMath.tokensOutForQuote(params, sold, quoteIn);
        if (tOut == 0) return;
        if (tOut > remaining) tOut = remaining;
        uint256 qBack = CurveMath.quoteOutForTokens(params, sold + tOut, tOut);
        assertLe(qBack, quoteIn);
    }

    function testFuzz_roundTrip_sellThenBuy_noProfit(uint256 soldSeed, uint256 tokenSeed) public view {
        uint256 sold = bound(soldSeed, 1e18, params.sCurve * 8 / 10);
        uint256 tokensIn = bound(tokenSeed, 1e15, sold);
        uint256 qOut = CurveMath.quoteOutForTokens(params, sold, tokensIn);
        if (qOut == 0) return;
        uint256 tBack = CurveMath.tokensOutForQuote(params, sold - tokensIn, qOut);
        assertLe(tBack, tokensIn);
    }

    function testFuzz_price_monotonic(uint256 aSeed, uint256 bSeed) public view {
        uint256 a = bound(aSeed, 0, params.sCurve);
        uint256 b = bound(bSeed, 0, params.sCurve);
        if (a > b) (a, b) = (b, a);
        assertLe(CurveMath.spotPriceWad(params, a), CurveMath.spotPriceWad(params, b));
    }

    // ── Integration ──────────────────────────────────────────────────────────

    function test_buy_increases_mcap_and_sold() public {
        (BondingCurve curve,) = _launch();
        uint256 m0 = curve.marketCapUsd();

        vm.startPrank(alice);
        quote.approve(address(curve), type(uint256).max);
        curve.buy(50 ether, 0, vm.getBlockTimestamp() + 1);
        vm.stopPrank();

        assertGt(curve.tokensSold(), 0);
        assertGt(curve.marketCapUsd(), m0);
        assertFalse(curve.graduated());
    }

    function test_buy_then_sell_user_does_not_profit() public {
        (BondingCurve curve, Token tok) = _launch();

        vm.startPrank(alice);
        quote.approve(address(curve), type(uint256).max);
        uint256 qIn = 200 ether;
        uint256 balQ0 = quote.balanceOf(alice);
        uint256 tOut = curve.buy(qIn, 0, vm.getBlockTimestamp() + 1);
        tok.approve(address(curve), tOut);
        uint256 qOut = curve.sell(tOut, 0, vm.getBlockTimestamp() + 1);
        vm.stopPrank();

        assertLe(qOut, qIn);
        assertLe(quote.balanceOf(alice), balQ0);
    }

    function test_walletCap_7pct() public {
        vm.prank(owner);
        launchpad.setWalletCapBps(700);
        (BondingCurve curve,) = _launch();
        assertEq(curve.walletCapBps(), 700);
        assertEq(FeeMath.walletCap(), (Constants.TOTAL_SUPPLY * 700) / 10_000);

        vm.startPrank(alice);
        quote.approve(address(curve), type(uint256).max);
        vm.expectRevert(BondingCurve.WalletCap.selector);
        curve.buy(100_000 ether, 0, vm.getBlockTimestamp() + 1);
        vm.stopPrank();
    }

    function test_graduation_at_curve_sold() public {
        (BondingCurve curve,) = _launch();

        // Early curve is steep: ~$400 quote can fill 7% wallet cap near launch.
        // Use many wallets with small buys until tokensSold hits sCurve.
        for (uint256 i = 0; i < 40 && !curve.graduated(); i++) {
            address w = makeAddr(string(abi.encodePacked("grad", vm.toString(i))));
            quote.mint(w, 5_000 ether);
            vm.startPrank(w);
            quote.approve(address(curve), type(uint256).max);
            // Try decreasing sizes so wallet cap / remaining curve don't revert the loop
            uint256[4] memory sizes = [uint256(300 ether), 100 ether, 50 ether, 10 ether];
            for (uint256 j = 0; j < sizes.length && !curve.graduated(); j++) {
                try curve.buy(sizes[j], 0, vm.getBlockTimestamp() + 1) {
                    break;
                } catch {}
            }
            vm.stopPrank();
        }

        assertTrue(curve.graduated(), "should graduate");
        assertGe(curve.tokensSold(), params.sCurve * 99 / 100);

        vm.startPrank(alice);
        quote.approve(address(curve), type(uint256).max);
        vm.expectRevert(BondingCurve.Graduated.selector);
        curve.buy(1 ether, 0, vm.getBlockTimestamp() + 1);
        vm.stopPrank();
    }

    function test_quotePriceUsd_scales_reserves() public view {
        CurveMath.Params memory pEth = CurveMath.makeParams(3_000e18);
        assertApproxEqRel(CurveMath.marketCapUsd(pEth, 0), MCAP_0, 0.01e18);
        assertApproxEqRel(CurveMath.marketCapUsd(pEth, pEth.sCurve), MCAP_72, 0.01e18);
        assertApproxEqRel(params.x0 / pEth.x0, 3_000, 0.02e18);
    }

    function test_fee_taken_on_buy() public {
        (BondingCurve curve,) = _launch();
        uint256 tre0 = (quote.balanceOf(treasury) + feeRouter.treasuryAccrued(address(quote)));

        vm.startPrank(alice);
        quote.approve(address(curve), type(uint256).max);
        curve.buy(50 ether, 0, vm.getBlockTimestamp() + 1);
        vm.stopPrank();

        assertGt((quote.balanceOf(treasury) + feeRouter.treasuryAccrued(address(quote))), tre0);
    }

    function testFuzz_integration_buySell_noProfit(uint256 qSeed) public {
        (BondingCurve curve, Token tok) = _launch();
        // Steep early curve: keep under wallet cap (~$90–150 depending on state)
        uint256 qIn = bound(qSeed, 1 ether, 80 ether);

        vm.startPrank(bob);
        quote.approve(address(curve), type(uint256).max);
        uint256 tOut = curve.buy(qIn, 0, vm.getBlockTimestamp() + 1);
        if (tOut == 0 || curve.graduated()) {
            vm.stopPrank();
            return;
        }
        tok.approve(address(curve), tOut);
        uint256 qOut = curve.sell(tOut, 0, vm.getBlockTimestamp() + 1);
        vm.stopPrank();
        assertLe(qOut, qIn);
    }

    function test_antiSnipe_decays_to_zero() public {
        (BondingCurve curve, Token tok) = _launch();
        // _launch warps +10s past window — fee should be 0
        uint256 bps = antiSnipe.currentFeeBps(address(tok));
        assertEq(bps, 0);
        // At t0 would be 7770 — register a fresh mental check via Constants
        assertEq(Constants.ANTI_SNIPE_END_BPS, 0);
        assertEq(Constants.ANTI_SNIPE_START_BPS, 7770);
        curve; // silence
    }

    function test_snipeFee_splits_70_rewards_30_treasury() public {
        // Launch WITHOUT warping past anti-snipe — buy in window so snipeFee > 0
        uint256 ts = vm.getBlockTimestamp();
        vm.startPrank(alice);
        ILaunchpad.LaunchParams memory p = ILaunchpad.LaunchParams({
            name: "Snipe",
            ticker: "SNP",
            imageURI: "ipfs://i",
            description: "",
            socialsURI: "",
            quote: address(quote),
            creatorTaxBps: 0,
            creatorBuyQuoteIn: 0,
            creatorBuyMinTokensOut: 0,
            deadline: ts + 1 hours
        });
        ILaunchpad.LaunchResult memory r = launchpad.launch(p);
        vm.stopPrank();

        BondingCurve curve = BondingCurve(r.curve);
        address tok = r.token;

        // At t=0, snipe bps = 7770 (77.7%)
        assertEq(antiSnipe.currentFeeBps(tok), 7770);

        uint256 quoteIn = 100 ether;
        uint256 expectedSnipe = (quoteIn * 7770) / 10_000; // 77.7 ether

        // Snapshot LockedLP escrow + treasury + creator accrued + rewards vault
        (,,,, uint256 escrowBefore,,) = lockedLP.positions(tok);
        uint256 treBefore = (quote.balanceOf(treasury) + feeRouter.treasuryAccrued(address(quote)));
        uint256 creatorBefore = feeRouter.creatorAccrued(tok, alice);

        vm.startPrank(alice);
        quote.approve(address(curve), type(uint256).max);
        curve.buy(quoteIn, 0, ts + 1 hours);
        vm.stopPrank();

        (,,,, uint256 escrowAfter,,) = lockedLP.positions(tok);

        uint256 afterSnipe = quoteIn - expectedSnipe;
        uint256 protoFee = (afterSnipe * 100) / 10_000;
        (uint256 cs, uint256 lps, uint256 ts_, uint256 rs) = FeeMath.splitTradeFee(protoFee);
        uint256 toRewards = (expectedSnipe * 7000) / 10_000;

        // LOCKED #9 rev.: snipe 70% → RewardsVault, 30% → treasury; LP only gets proto LP share
        assertEq(quote.balanceOf(address(rewardsVault)), toRewards, "70% rewards");
        assertEq(rewardsVault.totalAccrued(address(quote)), toRewards);
        assertEq(escrowAfter - escrowBefore, lps, "no snipe to LP");
        assertEq((quote.balanceOf(treasury) + feeRouter.treasuryAccrued(address(quote))) - treBefore, expectedSnipe - toRewards + ts_ + rs, "30% + proto treasury");
        assertEq(feeRouter.creatorAccrued(tok, alice) - creatorBefore, cs);
    }

    function test_afterSnipeWindow_noSnipeFee_onlyProtocol1pct() public {
        (BondingCurve curve, Token tok) = _launch(); // warps +10s
        assertEq(antiSnipe.currentFeeBps(address(tok)), 0);

        (,,,, uint256 escrowBefore,,) = lockedLP.positions(address(tok));
        uint256 treBefore = (quote.balanceOf(treasury) + feeRouter.treasuryAccrued(address(quote)));

        vm.startPrank(alice);
        quote.approve(address(curve), type(uint256).max);
        curve.buy(50 ether, 0, vm.getBlockTimestamp() + 1);
        vm.stopPrank();

        (,,,, uint256 escrowAfter,,) = lockedLP.positions(address(tok));
        // Only LP share of protocol 1% (33% of 1% of 50e18) goes to escrow — not a snipe dump
        uint256 protoFee = (50 ether * 100) / 10_000;
        uint256 lpShare = (protoFee * 33) / 100;
        assertEq(escrowAfter - escrowBefore, lpShare);
        assertGt((quote.balanceOf(treasury) + feeRouter.treasuryAccrued(address(quote))), treBefore);
    }
}
