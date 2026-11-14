// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Regression tests for the 2026-11-14 pre-mainnet audit fixes (docs/audit-2026-11-14.md).
// Run with --isolate: the CH-01 test relies on each top-level call being its own transaction (hook swappedInTx).

import {Vm} from "forge-std/Vm.sol";
import {IntegrationBase, MockUSDG} from "../integration/IntegrationBase.sol";
import {CreatorFeeHarvest} from "../../src/addons/CreatorFeeHarvest.sol";
import {AnonLauncher} from "../../src/addons/AnonLauncher.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {Owned2Step} from "../../src/utils/Owned2Step.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolDonateTest} from "@uniswap/v4-core/src/test/PoolDonateTest.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract AuditFixes202611Test is IntegrationBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    bytes32 constant COMPOUNDED = keccak256("LiquidityCompounded(address,uint128,uint256,uint256,uint256,uint256)");

    AnonLauncher internal anon;
    address internal stealth = makeAddr("stealth");

    function setUp() public override {
        super.setUp();
        vm.startPrank(owner);
        harvest.wire(
            address(launchpad), address(feeRouter), address(lockedLP), address(router), address(hook), address(manager)
        );
        launchpad.setTrustedRouter(address(harvest), true);
        launchpad.setTrustedRouter(address(router), true);
        feeRouter.setClaimRouter(address(harvest), true);
        feeRouter.setCreatorFeeHarvest_51(address(harvest));
        harvest.setFeeVault(address(feeVault));
        vm.stopPrank();
        anon = new AnonLauncher(owner, address(launchpad), address(feeRouter), address(quote), treasury, address(0), 0);
        vm.startPrank(owner);
        harvest.setAnonLauncher(address(anon));
        anon.setCreatorFeeHarvest(address(harvest));
        vm.stopPrank();
    }

    function _params(uint256 tax, uint256 buy) internal view returns (ILaunchpad.LaunchParams memory p) {
        p = ILaunchpad.LaunchParams({
            name: "FeeCoin",
            ticker: "FEE",
            imageURI: "ipfs://img",
            description: "fees",
            socialsURI: "",
            quote: address(quote),
            creatorTaxBps: tax,
            creatorBuyQuoteIn: buy,
            creatorBuyMinTokensOut: 0,
            deadline: block.timestamp + 1 days
        });
    }

    function _launchDest(uint8 dest, uint256 tax) internal returns (BondingCurve curve, Token tok) {
        vm.prank(creator);
        ILaunchpad.LaunchResult memory r = harvest.launch(_params(tax, 0), dest);
        curve = BondingCurve(r.curve);
        tok = Token(r.token);
    }

    // ───────────────────────── CreatorFeeHarvest ─────────────────────────

    /// CH-02: a USDG First BOOST through the harvest used to underflow on every call.
    function test_CH02_launchWithUsdg_withFirstBoost_works() public {
        router.setUsdgRouting(address(quote), address(launchpad)); // coin quote == USDG
        uint256 before = quote.balanceOf(creator);
        vm.startPrank(creator);
        quote.approve(address(harvest), 100 ether);
        (ILaunchpad.LaunchResult memory r, uint256 refund) = harvest.launchWithUsdg(_params(0, 0), 0, 100 ether, 1, 1);
        vm.stopPrank();
        assertGt(r.creatorTokensBought, 0, "First BOOST bought tokens");
        assertEq(harvest.creatorFeeDestinationOf(r.token), 1);
        assertEq(before - quote.balanceOf(creator), 100 ether - refund, "only the spent BOOST left the wallet");
        assertEq(quote.balanceOf(address(harvest)), 0, "nothing left on the harvest");
    }

    /// CH-03: launch fee and First BOOST in the same token need one combined approval.
    function test_CH03_launchAnon_feeAndBoostSameToken_works() public {
        uint256 fee = 1 ether;
        uint256 boost = 10 ether;
        vm.prank(owner);
        anon.setLaunchFee(fee);
        vm.startPrank(creator);
        quote.approve(address(harvest), fee + boost);
        ILaunchpad.LaunchResult memory r =
            harvest.launchAnon(_params(0, boost), stealth, stealth, "", bytes1(0), fee, 1);
        vm.stopPrank();
        assertGt(r.creatorTokensBought, 0);
        assertEq(harvest.creatorFeeDestinationOf(r.token), 1);
    }

    /// CH-04: fees of a middle creator (A -> B -> C) can be routed with routeWith.
    function test_CH04_routeWith_reachesMiddleCreator() public {
        (BondingCurve curve, Token tok) = _launchDest(1, 700);
        _warpPastSnipe();
        address b = makeAddr("creatorB");
        address c = makeAddr("creatorC");
        vm.prank(creator);
        launchpad.transferCreator(address(tok), b);
        _buy(curve, trader1, 100 ether, 0);
        curve.settleFees();
        uint256 owedB = feeVault.creatorAccrued(address(tok), b);
        assertGt(owedB, 0);
        vm.prank(b);
        launchpad.transferCreator(address(tok), c);

        vm.expectRevert(CreatorFeeHarvest.NothingToRoute.selector);
        harvest.route(address(tok));

        (uint256 q,,) = harvest.routeWith(address(tok), b);
        assertEq(q, owedB, "B's curve-phase fees routed to the lock");
        assertEq(feeVault.creatorAccrued(address(tok), b), 0);
    }

    /// CH-06: rocket tokens cannot be parked for the lock before orbit (they would be stranded in LockedLP).
    function test_CH06_depositRocketTokens_lockBeforeOrbit_reverts() public {
        (BondingCurve curve, Token tok) = _launchDest(1, 0);
        _warpPastSnipe();
        _buy(curve, creator, 50 ether, 0);
        uint256 bal = tok.balanceOf(creator);
        vm.startPrank(creator);
        tok.approve(address(harvest), bal);
        vm.expectRevert(CreatorFeeHarvest.AwaitingOrbit.selector);
        harvest.depositRocketTokens(address(tok), bal);
        vm.stopPrank();
    }

    /// CH-01: the burn sell is chunked to <= MAX_SELL_IMPACT_BPS; the rest stays parked for later routes.
    function test_CH01_burnSell_isChunked() public {
        (BondingCurve curve, Token tok) = _launchDest(2, 0);
        _warpPastSnipe();
        _buy(curve, creator, 200 ether, 0);
        _graduate(curve);
        _refReady(tok);

        uint256 amt = tok.balanceOf(creator);
        (, uint256 imp,) = router.quoteExactIn(address(tok), false, amt);
        while (imp > 4500 && amt > 1) {
            amt /= 2;
            (, imp,) = router.quoteExactIn(address(tok), false, amt);
        }
        assertGt(imp, 3 * harvest.MAX_DEV_BPS(), "lump is far larger than one allowed chunk");

        vm.startPrank(creator);
        tok.approve(address(harvest), amt);
        harvest.depositRocketTokens(address(tok), amt);
        vm.stopPrank();

        vm.roll(block.number + 1);
        PoolId id = _poolKey(tok).toId();
        (uint160 sp0,,,) = manager.getSlot0(id);
        (, uint256 sold, uint256 bought) = harvest.route(address(tok));
        (uint160 sp1,,,) = manager.getSlot0(id);
        assertGt(sold, 0, "a chunk sold");
        assertGt(bought, 0);
        assertLt(sold, amt, "not the whole lump");
        assertGt(harvest.rocketDeposited(address(tok)), 0, "the rest stays parked");
        uint256 hi = sp0 > sp1 ? sp0 : sp1;
        uint256 lo = sp0 > sp1 ? sp1 : sp0;
        uint256 devBps = (hi * 10_000 / lo) * hi / lo - 10_000;
        assertLe(devBps, 2 * harvest.MAX_SELL_IMPACT_BPS(), "one route moves the price by about one chunk only");
    }

    // ───────────────────────── LockedLP ─────────────────────────

    function _lpLiq(Token tok) internal view returns (uint128 l) {
        (,,,,,, l) = lockedLP.positions(address(tok));
    }

    /// HK-01: a donation to the pool no longer bricks compounding forever.
    function test_HK01_donation_doesNotBrickCompounding() public {
        (BondingCurve c, Token tok) = _launch(0, 0);
        _graduate(c);
        _refReady(tok);

        PoolKey memory key = _poolKey(tok);
        (uint160 sp,,,) = manager.getSlot0(key.toId());
        uint128 L = _lpLiq(tok);
        bool tIs0 = Currency.unwrap(key.currency0) == address(tok);
        uint256 tokRes = tIs0 ? Math.mulDiv(L, 1 << 96, sp) : Math.mulDiv(L, sp, 1 << 96);
        uint256 amt = tokRes / 100;
        address donor = makeAddr("donor");
        deal(address(tok), donor, amt);
        PoolDonateTest d = new PoolDonateTest(manager);
        vm.startPrank(donor);
        tok.approve(address(d), amt);
        d.donate(key, tIs0 ? amt : 0, tIs0 ? 0 : amt, "");
        vm.stopPrank();

        uint128 l0 = _lpLiq(tok);
        uint256 adds;
        uint256 dust = U / 1e6 < 100 ? 100 : U / 1e6;
        for (uint256 i; i < 100; i++) {
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + 31);
            _swapExactInQuoteForToken(tok, makeAddr("obs"), dust);
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + 30);
            vm.recordLogs();
            _swapExactInQuoteForToken(tok, trader1, 25 * U);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 j; j < logs.length; j++) {
                if (logs[j].topics.length != 0 && logs[j].topics[0] == COMPOUNDED) adds++;
            }
        }
        assertGt(adds, 0, "compounding still works after a donation");
        assertGt(_lpLiq(tok), l0, "locked liquidity keeps growing");
        // The LP's token balance covers its buckets: donated fees were taken into the bucket, not lost.
        (uint256 bt,) = lockedLP.compoundBucket(address(tok));
        assertGe(tok.balanceOf(address(lockedLP)), bt);
    }

    /// HK-05: a creator-fee deposit with a different quote than the coin's is refused.
    function test_HK05_depositCreatorFees_wrongQuote_reverts() public {
        (BondingCurve c, Token tok) = _launch(0, 0);
        _graduate(c);
        MockUSDG other = new MockUSDG();
        vm.prank(address(harvest));
        vm.expectRevert(LockedLP.QuoteMismatch.selector);
        lockedLP.depositCreatorFees_57(address(tok), address(other), 0, 1);
    }

    /// HK-04: rocket tokens deposited before orbit are refused at the LockedLP side too.
    function test_HK04_depositCreatorFees_tokensBeforeOrbit_reverts() public {
        (, Token tok) = _launch(0, 0);
        vm.prank(address(harvest));
        vm.expectRevert(LockedLP.NotGraduated.selector);
        lockedLP.depositCreatorFees_57(address(tok), address(quote), 1, 0);
    }

    // ───────────────────────── FeeRouter ─────────────────────────

    /// FR-01 / LB-03: the launchpad pointer is one-shot, so live curves can't be orphaned by a repoint.
    function test_FR01_setLaunchpad_isOneShot() public {
        Launchpad lp2 = new Launchpad(owner, address(feeRouter), address(0), address(migration));
        vm.prank(owner);
        vm.expectRevert(FeeRouter.LaunchpadAlreadySet.selector);
        feeRouter.setLaunchpad(address(lp2));
    }

    /// FR-02: a live token's quote and launch KOL can't be re-registered.
    function test_FR02_registerToken_isWriteOnce() public {
        (, Token tok) = _launch(0, 0);
        MockUSDG other = new MockUSDG();
        vm.startPrank(owner);
        vm.expectRevert(FeeRouter.QuoteAlreadySet.selector);
        feeRouter.registerTokenQuote(address(tok), address(other));
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        feeRouter.registerTokenLaunch(address(tok), address(other), creator);
        vm.stopPrank();
        assertEq(feeRouter.tokenQuote(address(tok)), address(quote));
    }

    /// FR-02: the creator-fee harvest pointer must be a contract (or 0).
    function test_FR02_setCreatorFeeHarvest_rejectsEoa() public {
        vm.startPrank(owner);
        vm.expectRevert(FeeRouter.NotAContract.selector);
        feeRouter.setCreatorFeeHarvest_51(makeAddr("eoa"));
        feeRouter.setCreatorFeeHarvest_51(address(0));
        feeRouter.setCreatorFeeHarvest_51(address(harvest));
        vm.stopPrank();
    }

    // ───────────────────────── DiscipleRouter ─────────────────────────

    /// RT-02: a zero minimum on the claim-to-USDG swap is refused.
    function test_RT02_claimCreatorFeesToUsdg_zeroMin_reverts() public {
        (, Token tok) = _launch(0, 0);
        vm.prank(creator);
        vm.expectRevert(DiscipleRouter.ZeroMinOut.selector);
        router.claimCreatorFeesToUsdg(address(tok), 0);
    }
}
