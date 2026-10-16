// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Rocket721} from "../../src/rockets/Rocket721.sol";
import {RocketPool} from "../../src/rockets/RocketPool.sol";
import {RocketAuctionHouse, RocketFeeFeed} from "../../src/rockets/RocketAuctionHouse.sol";
import {IRocketFeeFeed} from "../../src/rockets/IRocketFeeSink.sol";
import {RocketMath} from "../../src/rockets/RocketMath.sol";

contract MockUSDG is ERC20 {
    constructor() ERC20("USDG", "USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

contract RocketsTest is Test {
    uint256 constant U = 1e6;
    uint256 GEN; // 00:00 ET (04:00 UTC, EDT) fixed
    MockUSDG usdg;
    Rocket721 rocket;
    RocketPool pool;
    RocketAuctionHouse ah;
    RocketFeeFeed feed;
    address owner = address(0xA11CE);
    address treasury = address(0x7EA5);
    address keeper = address(0xBEEF);
    address alice = address(0xA1);
    address bob = address(0xB0);
    address carol = address(0xC0);

    function setUp() public {
        GEN = 1_800_000_000 - (1_800_000_000 % 1 days) + 4 hours;
        vm.warp(GEN - 1);
        usdg = new MockUSDG();
        vm.startPrank(owner);
        rocket = new Rocket721(owner);
        ah = new RocketAuctionHouse(owner, IERC20(address(usdg)), rocket, treasury, GEN, U);
        pool = new RocketPool(owner, IERC20(address(usdg)), rocket, treasury, GEN, U);
        feed = new RocketFeeFeed(owner);
        rocket.setMinter(address(ah));
        rocket.setPool(address(pool));
        ah.setPool(address(pool));
        ah.setFeed(feed);
        pool.setDepositor(keeper, true);
        pool.setReporter(keeper, true);
        feed.setKeeper(keeper, true);
        vm.stopPrank();
        address[4] memory ppl = [alice, bob, carol, keeper];
        for (uint256 i; i < 4; ++i) {
            usdg.mint(ppl[i], 100_000_000 * U);
            vm.startPrank(ppl[i]);
            usdg.approve(address(ah), type(uint256).max);
            usdg.approve(address(pool), type(uint256).max);
            vm.stopPrank();
        }
        vm.warp(GEN);
    }

    // ---------------- helpers ----------------
    function _buy(address who) internal returns (uint256 id) {
        vm.prank(who);
        id = ah.buy(type(uint256).max);
    }

    function _nextDay() internal {
        vm.warp(block.timestamp + 1 days);
    }

    function _act(address w) internal {
        vm.prank(keeper);
        pool.reportActivity(w, 33 * U);
    }

    /// @dev operator does a qualifying $33 action today, then anyone ignites.
    function _ignite(uint256 id) internal {
        (address op,,) = rocket.operatorOf(id);
        _act(op);
        pool.ignite(id);
    }

    function _deposit(uint256 a) internal {
        vm.prank(keeper);
        pool.depositFees(a);
    }

    function _claim(address w) internal returns (uint256) {
        vm.prank(w);
        return pool.claim();
    }

    // ================= auction pricing =================
    function test_defaultSchedule() public view {
        assertEq(ah.fixedStartPrice(), 77_000 * U);
        assertEq(ah.reservePrice(), 77 * U);
        assertEq(ah.decayDuration(), 22 hours - 10);
        assertEq(ah.closeOffset(), 1 days - 10);
        assertEq(uint8(ah.decay()), uint8(RocketAuctionHouse.Decay.Exponential));
        assertEq(ah.currentPrice(), 77_000 * U);
    }

    function test_expDecayCurve() public {
        uint256 T = ah.decayDuration();
        // midpoint of exponential = geometric mean sqrt(77000*77) ~= 2434.95
        vm.warp(GEN + T / 2);
        assertApproxEqRel(ah.currentPrice(), 2434_953_798, 1e14);
        // quarter: 77000 * 1000^-0.25 = 13692.8
        vm.warp(GEN + T / 4);
        assertApproxEqRel(ah.currentPrice(), 13_692_723_000, 1e14);
        // reaches reserve by 21:59:50
        vm.warp(GEN + T);
        assertEq(ah.currentPrice(), 77 * U);
        vm.warp(GEN + T - 1);
        assertGe(ah.currentPrice(), 77 * U);
        // holds >= 2h at reserve
        vm.warp(GEN + T + 2 hours);
        assertEq(ah.currentPrice(), 77 * U);
    }

    function test_expDecayMonotonic() public {
        uint256 last = type(uint256).max;
        for (uint256 t; t <= 22 hours; t += 600) {
            vm.warp(GEN + t);
            uint256 p = ah.currentPrice();
            assertLe(p, last);
            assertGe(p, 77 * U);
            last = p;
        }
    }

    function test_linearDecay() public {
        vm.prank(owner);
        ah.setDecay(RocketAuctionHouse.Decay.Linear, 20 hours, 23 hours);
        vm.warp(GEN + 10 hours);
        assertEq(ah.currentPrice(), 77_000 * U - (77_000 * U - 77 * U) / 2);
        vm.warp(GEN + 20 hours);
        assertEq(ah.currentPrice(), 77 * U);
    }

    function test_setDecayEnforcesReserveHold() public {
        vm.startPrank(owner);
        vm.expectRevert(RocketAuctionHouse.BadParam.selector);
        ah.setDecay(RocketAuctionHouse.Decay.Exponential, 22 hours, 23 hours); // only 1h hold
        vm.expectRevert(RocketAuctionHouse.BadParam.selector);
        ah.setDecay(RocketAuctionHouse.Decay.Exponential, 22 hours, 1 days + 1); // close beyond day
        ah.setDecay(RocketAuctionHouse.Decay.Exponential, 21 hours, 23 hours); // exactly 2h ok
        vm.stopPrank();
    }

    function test_ownerSettable() public {
        vm.expectRevert();
        ah.setFixedStart(true, 1);
        vm.startPrank(owner);
        ah.setFixedStart(true, 1_000 * U);
        ah.setPricing(20_000, 5_000, 10 * U, 1_000, 2 days);
        vm.stopPrank();
        assertEq(ah.currentPrice(), 1_000 * U);
        vm.warp(GEN + 1 days - 11);
        assertEq(ah.currentPrice(), 10 * U);
    }

    function test_buyAtPriceToTreasury() public {
        vm.warp(GEN + 3 hours);
        uint256 p = ah.currentPrice();
        uint256 id = _buy(alice);
        assertEq(id, 1);
        assertEq(rocket.ownerOf(1), alice);
        assertEq(usdg.balanceOf(treasury), p);
        vm.prank(bob);
        vm.expectRevert(RocketAuctionHouse.AlreadySold.selector);
        ah.buy(type(uint256).max);
    }

    function test_maxPriceSlippage() public {
        vm.prank(alice);
        vm.expectRevert(RocketAuctionHouse.PriceTooHigh.selector);
        ah.buy(1_000 * U);
    }

    function test_closeAt235950() public {
        vm.warp(GEN + 1 days - 11);
        assertEq(ah.currentPrice(), 77 * U);
        vm.warp(GEN + 1 days - 10);
        vm.prank(alice);
        vm.expectRevert(RocketAuctionHouse.AuctionClosed.selector);
        ah.buy(type(uint256).max);
    }

    function test_notStarted() public {
        vm.warp(GEN - 1);
        vm.expectRevert(RocketAuctionHouse.NotStarted.selector);
        ah.currentPrice();
    }

    function test_feedModePricing() public {
        vm.prank(keeper);
        feed.post(70_000 * U); // 10k/day fees -> 1k/day pool
        vm.prank(owner);
        ah.setFixedStart(false, 1);
        // projection for #1: 1000 * sum_{k<1825} 1/min(1+k,777)
        uint256 h;
        for (uint256 k; k < 1825; ++k) {
            h += 1e18 / (1 + k < 777 ? 1 + k : 777);
        }
        uint256 proj = 1_000 * U * h / 1e18;
        assertApproxEqAbs(ah.projected5y(), proj, 1e3);
        (uint256 s, uint256 f) = ah.startAndFloor();
        assertEq(s, proj * 2);
        assertEq(f, proj / 2);
        assertEq(ah.currentPrice(), s);
    }

    function test_feedModeReserveFloorAndStale() public {
        vm.prank(keeper);
        feed.post(7 * U); // tiny volume
        vm.prank(owner);
        ah.setFixedStart(false, 1);
        (uint256 s, uint256 f) = ah.startAndFloor();
        assertEq(f, 77 * U);
        assertEq(s, 77 * U);
        vm.warp(GEN + 3 days);
        vm.expectRevert(RocketAuctionHouse.StaleFeed.selector);
        ah.currentPrice();
    }

    function test_feedChangeBound() public {
        vm.startPrank(keeper);
        feed.post(100 * U);
        vm.expectRevert(RocketFeeFeed.ChangeTooLarge.selector);
        feed.post(151 * U);
        feed.post(150 * U);
        vm.stopPrank();
    }

    function test_proceedsSeedPool() public {
        vm.prank(owner);
        ah.setProceeds(2_000, 10);
        vm.warp(GEN + 22 hours);
        _buy(alice); // 77
        assertEq(usdg.balanceOf(treasury), 77 * U * 8 / 10);
        assertEq(pool.dayRewards(0), 77 * U * 2 / 10 / 10);
    }

    // ================= burn & cap =================
    function test_unsoldBurnSkipsIndex() public {
        vm.prank(alice);
        vm.expectRevert(RocketAuctionHouse.DayNotOver.selector);
        ah.burnUnsold(0);
        vm.warp(GEN + 1 days - 10); // 23:59:50 -> burnable
        ah.burnUnsold(0);
        assertTrue(rocket.skipped(1));
        assertEq(rocket.liveCap(), 776);
        vm.warp(GEN + 1 days); // 00:00:00 next day
        assertEq(ah.currentPrice(), 77_000 * U);
        uint256 id = _buy(alice);
        assertEq(id, 2);
        vm.expectRevert(RocketAuctionHouse.AlreadySold.selector);
        ah.burnUnsold(0);
        vm.expectRevert(RocketAuctionHouse.AlreadySold.selector);
        ah.burnUnsold(1);
    }

    function test_burnedIdNeverMintable() public {
        vm.warp(GEN + 1 days);
        ah.burnUnsold(0);
        vm.prank(address(ah));
        vm.expectRevert(Rocket721.BadId.selector);
        rocket.mint(alice, 1);
        vm.expectRevert(Rocket721.NotMinter.selector);
        rocket.mint(alice, 5);
    }

    function test_hardCap777() public {
        vm.prank(owner);
        ah.setFixedStart(true, 1 * U);
        vm.prank(owner);
        ah.setPricing(20_000, 5_000, 1 * U, 1_000, 2 days);
        for (uint256 i; i < 777; ++i) {
            vm.warp(GEN + i * 1 days);
            if (i % 2 == 0) {
                _buy(alice);
            } else if (i > 0) {}
        }
        vm.warp(GEN + 777 days);
        vm.expectRevert(RocketAuctionHouse.AuctionOver.selector);
        _buy(alice);
        for (uint256 i = 1; i < 777; i += 2) {
            ah.burnUnsold(i);
        }
        assertEq(rocket.totalMinted(), 389);
        assertEq(rocket.totalBurned(), 388);
        assertEq(rocket.liveCap(), 389);
        vm.expectRevert(RocketAuctionHouse.AuctionOver.selector);
        ah.burnUnsold(777);
    }

    function test_projectionUsesLiveCap() public {
        vm.prank(keeper);
        feed.post(70_000 * U);
        vm.prank(owner);
        ah.setFixedStart(false, 1);
        uint256 before = ah.projected5y();
        vm.warp(GEN + 1 days);
        vm.prank(keeper);
        feed.post(70_000 * U);
        ah.burnUnsold(0);
        // supply still 0 -> same n; cap smaller -> tail days share more
        assertGt(ah.projected5y(), before);
    }

    // ================= accrual / dilution =================
    function _mintTo(address who, uint256 day) internal returns (uint256 id) {
        vm.warp(GEN + day * 1 days + 22 hours);
        id = _buy(who);
    }

    function test_accrualSingle() public {
        uint256 id = _mintTo(alice, 0);
        _nextDay(); // day 1
        _ignite(id);
        _deposit(1_000 * U);
        _nextDay();
        pool.settle(_arr(id));
        assertEq(_claim(alice), 1_000 * U);
    }

    function test_dilutionByWeight() public {
        uint256 a = _mintTo(alice, 0);
        uint256 b = _mintTo(bob, 1);
        // level bob to 10 (2x)
        for (uint256 i; i < 10; ++i) {
            vm.prank(bob);
            pool.levelUp(b);
        }
        _nextDay(); // day 2
        uint256 d = pool.today();
        _ignite(a);
        _ignite(b);
        _deposit(3_000 * U);
        uint256 tot = pool.dayRewards(d); // deposit + leveling stream + rolled-over day 1
        assertGt(tot, 3_000 * U);
        _nextDay();
        pool.settle(_arr2(a, b));
        assertApproxEqAbs(_claim(alice), tot / 3, 2);
        assertApproxEqAbs(_claim(bob), tot * 2 / 3, 2);
    }

    function test_settleOnReignite_noDoubleCount() public {
        uint256 a = _mintTo(alice, 0);
        for (uint256 i; i < 3; ++i) {
            _nextDay();
            _ignite(a);
            _deposit(100 * U);
        }
        assertEq(pool.claimable(alice), 200 * U);
        vm.expectRevert(RocketPool.AlreadyIgnited.selector);
        pool.ignite(a);
        _nextDay();
        pool.settle(_arr(a));
        pool.settle(_arr(a));
        assertEq(_claim(alice), 300 * U);
        assertEq(usdg.balanceOf(address(pool)), 0);
    }

    function test_rolloverEmptyDays() public {
        uint256 a = _mintTo(alice, 0);
        _nextDay();
        _deposit(500 * U); // nobody ignited day 1
        _nextDay();
        _nextDay(); // day 3
        _ignite(a); // triggers rollover into day 3
        assertEq(pool.dayRewards(pool.today()), 500 * U);
        _nextDay();
        pool.settle(_arr(a));
        assertEq(_claim(alice), 500 * U);
    }

    // ================= leveling =================
    function test_levelCostsAndSplit() public {
        uint256 a = _mintTo(alice, 0);
        uint256 t0 = usdg.balanceOf(treasury);
        uint256 b0 = usdg.balanceOf(alice);
        for (uint256 i; i < 10; ++i) {
            vm.prank(alice);
            pool.levelUp(a);
        }
        assertEq(rocket.levelOf(a), 10);
        assertEq(b0 - usdg.balanceOf(alice), 7_700 * U); // 77 * 10^2
        assertEq(usdg.balanceOf(treasury) - t0, 3_850 * U);
        uint256 streamed;
        uint256 d = pool.today();
        for (uint256 i; i < 30; ++i) {
            streamed += pool.dayRewards(d + i);
        }
        assertEq(streamed, 3_850 * U);
        assertEq(pool.weightOf(a, alice), 20_000);
        vm.prank(alice);
        vm.expectRevert(RocketPool.MaxLevel.selector);
        pool.levelUp(a);
    }

    function test_levelCostCurve() public view {
        uint256 cum;
        for (uint8 l; l < 10; ++l) {
            cum += pool.levelCost(l);
            assertEq(cum, 77 * U * uint256(l + 1) ** 2);
        }
    }

    function test_onlyPoolSetsLevel() public {
        uint256 a = _mintTo(alice, 0);
        vm.expectRevert(Rocket721.NotPool.selector);
        rocket.setLevel(a, 10);
    }

    function test_referralWeightCap() public {
        uint256 a = _mintTo(alice, 0);
        for (uint256 i; i < 10; ++i) {
            vm.prank(alice);
            pool.levelUp(a);
        }
        vm.prank(keeper);
        pool.setReferralBps(alice, 2_500);
        assertEq(pool.weightOf(a, alice), 25_000);
        vm.prank(keeper);
        vm.expectRevert(RocketPool.BadParam.selector);
        pool.setReferralBps(alice, 2_501);
        vm.prank(bob);
        vm.expectRevert(RocketPool.NotReporter.selector);
        pool.setReferralBps(bob, 100);
    }

    // ================= energy =================
    function test_energyFlatMinimum33() public {
        uint256 a = _mintTo(alice, 0);
        _nextDay();
        vm.prank(keeper);
        pool.reportActivity(alice, 33 * U - 1); // below minimum: not energized
        assertFalse(pool.isEnergized(alice));
        vm.prank(keeper);
        pool.reportAction(alice, RocketPool.Activity.TierHold, 33 * U);
        assertTrue(pool.isEnergized(alice));
        pool.ignite(a);
        assertTrue(pool.graceAvailable(a)); // grace not consumed
        _nextDay();
        assertFalse(pool.isEnergized(alice)); // energy is per UTC-epoch day
    }

    function test_minQualifyingOwnerSettable() public {
        vm.prank(owner);
        pool.setMinQualifying(100 * U);
        vm.prank(keeper);
        pool.reportAction(alice, RocketPool.Activity.TrampWall, 99 * U);
        assertFalse(pool.isEnergized(alice));
        vm.prank(alice);
        vm.expectRevert();
        pool.setMinQualifying(1);
    }

    function test_oneActionCoversAllRockets() public {
        uint256 a = _mintTo(alice, 0);
        uint256 b = _mintTo(alice, 1);
        _nextDay();
        _act(alice);
        pool.ignite(a);
        pool.ignite(b);
        assertTrue(pool.graceAvailable(a) && pool.graceAvailable(b));
    }

    function test_graceOnePer7Days() public {
        uint256 a = _mintTo(alice, 0);
        vm.warp(GEN + 7 days); // window 1 (days 7..13)
        pool.ignite(a); // grace
        assertFalse(pool.graceAvailable(a));
        vm.warp(GEN + 8 days);
        vm.expectRevert(RocketPool.NoEnergy.selector);
        pool.ignite(a);
        vm.warp(GEN + 14 days); // new window
        pool.ignite(a);
        // grace day still earns
        _deposit(50 * U);
        _nextDay();
        pool.settle(_arr(a));
        assertEq(_claim(alice), 50 * U);
    }

    function test_missedDaysNoPenalty() public {
        uint256 a = _mintTo(alice, 0);
        vm.warp(GEN + 30 days);
        assertEq(pool.weightOf(a, alice), 10_000);
        _ignite(a);
        _deposit(10 * U);
        _nextDay();
        pool.settle(_arr(a));
        assertEq(_claim(alice), 10 * U);
    }

    function test_idleShareRedistributes() public {
        uint256 a = _mintTo(alice, 0);
        uint256 b = _mintTo(bob, 1);
        uint256 c = _mintTo(carol, 2);
        _nextDay();
        _ignite(a);
        _ignite(b);
        _deposit(900 * U);
        _nextDay();
        pool.settle(_arr2(a, b));
        assertEq(_claim(alice), 450 * U);
        assertEq(_claim(bob), 450 * U);
        assertEq(pool.claimable(carol), 0);
        _ignite(c);
        assertEq(pool.weightOf(c, carol), 10_000);
    }

    function test_onlyReporter() public {
        vm.prank(alice);
        vm.expectRevert(RocketPool.NotReporter.selector);
        pool.reportActivity(alice, 1e12);
        vm.prank(alice);
        vm.expectRevert(RocketPool.NotDepositor.selector);
        pool.depositFees(1);
    }

    function test_agentCanIgnite() public {
        uint256 a = _mintTo(alice, 0);
        _nextDay();
        _act(alice);
        vm.prank(address(0xA6E7)); // automation
        pool.ignite(a);
        _deposit(10 * U);
        _nextDay();
        pool.settle(_arr(a));
        assertEq(pool.claimable(alice), 10 * U);
        assertEq(pool.claimable(address(0xA6E7)), 0);
    }

    // ================= rentals =================
    function test_rentalSplitAndEnergyFromRenter() public {
        uint256 a = _mintTo(alice, 0);
        vm.prank(alice);
        rocket.setRental(a, bob, uint64(block.timestamp + 10 days), 7_000, false);
        assertEq(rocket.userOf(a), bob);
        _nextDay();
        _act(alice); // owner activity irrelevant while rented
        pool.ignite(a); // uses rocket's grace day
        vm.warp(block.timestamp + 1 days);
        _act(alice);
        vm.expectRevert(RocketPool.NoEnergy.selector);
        pool.ignite(a); // still same 7d window, owner energy doesn't count
        _act(bob);
        pool.ignite(a);
        vm.prank(keeper);
        pool.pokeRollover(64);
        _deposit(1_000 * U);
        pool.settle(_arr(a)); // settle grace day (no rewards that day)
        assertEq(pool.claimable(bob), 0);
        _nextDay();
        pool.settle(_arr(a));
        assertEq(_claim(bob), 700 * U);
        assertEq(_claim(alice), 300 * U);
    }

    function test_rentalExpiry() public {
        uint256 a = _mintTo(alice, 0);
        vm.prank(alice);
        rocket.setRental(a, bob, uint64(block.timestamp + 1 days), 5_000, false);
        vm.warp(block.timestamp + 1 days + 1);
        assertEq(rocket.userOf(a), address(0));
        (address op,, uint16 bps) = rocket.operatorOf(a);
        assertEq(op, alice);
        assertEq(bps, 0);
    }

    function test_transferClearsUnlockedRental() public {
        uint256 a = _mintTo(alice, 0);
        vm.prank(alice);
        rocket.setUser(a, bob, uint64(block.timestamp + 10 days));
        vm.prank(alice);
        rocket.transferFrom(alice, carol, a);
        assertEq(rocket.userOf(a), address(0));
    }

    function test_lockedRentalBlocksTransferAndOverride() public {
        uint256 a = _mintTo(alice, 0);
        vm.prank(alice);
        rocket.setRental(a, bob, uint64(block.timestamp + 10 days), 8_000, true);
        vm.prank(alice);
        vm.expectRevert(Rocket721.RentalLocked.selector);
        rocket.transferFrom(alice, carol, a);
        vm.prank(alice);
        vm.expectRevert(Rocket721.RentalLocked.selector);
        rocket.setRental(a, carol, uint64(block.timestamp + 10 days), 0, false);
        vm.warp(block.timestamp + 11 days);
        vm.prank(alice);
        rocket.transferFrom(alice, carol, a);
        assertEq(rocket.ownerOf(a), carol);
    }

    function test_rentalAuth() public {
        uint256 a = _mintTo(alice, 0);
        vm.prank(bob);
        vm.expectRevert(Rocket721.NotAuthorized.selector);
        rocket.setRental(a, bob, uint64(block.timestamp + 1 days), 10_000, false);
        vm.prank(alice);
        vm.expectRevert(Rocket721.BadBps.selector);
        rocket.setRental(a, bob, uint64(block.timestamp + 1 days), 10_001, false);
    }

    function test_rewardsToOwnerAtIgnite_afterTransfer() public {
        uint256 a = _mintTo(alice, 0);
        _nextDay();
        _ignite(a);
        _deposit(100 * U);
        vm.prank(alice);
        rocket.transferFrom(alice, carol, a);
        _nextDay();
        pool.settle(_arr(a));
        assertEq(pool.claimable(alice), 100 * U);
    }

    function test_interfaces() public view {
        assertTrue(rocket.supportsInterface(0xad092b5c)); // IERC4907
        assertTrue(rocket.supportsInterface(0x80ac58cd)); // ERC721
    }

    // ================= math =================
    function testFuzz_divPow2(uint256 y) public pure {
        y = bound(y, 0, 20e18);
        uint256 a = 77_000e6;
        uint256 r = RocketMath.divPow2(a, y);
        assertLe(r, a);
        if (y % 1e18 == 0) assertApproxEqAbs(r, a >> (y / 1e18), 1);
    }

    function test_log2() public pure {
        assertEq(RocketMath.log2(1e18), 0);
        assertApproxEqAbs(RocketMath.log2(8e18), 3e18, 1e3);
        assertApproxEqRel(RocketMath.log2(1000e18), 9965784284662087043, 1e12);
    }

    function _arr(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _arr2(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }
}
