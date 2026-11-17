// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./integration/IntegrationBase.sol";
import {AnonLauncher} from "../src/addons/AnonLauncher.sol";

/// @notice Private launches on every difficulty (maker 2026-11-16): Trench (Expert), Easy, Hard. Easy locks the
///         First BOOST on the creator until orbit, and AnonLauncher is the creator, so the boost is held there and
///         `releaseBoost` sends it to the buy recipient after graduation.
contract AnonLauncherModesTest is IntegrationBase {
    AnonLauncher internal anon;
    address internal payer = makeAddr("payer");
    address internal stealth = makeAddr("stealth");
    address internal recipient = makeAddr("boostTo");
    uint256 internal walletNonce;

    function setUp() public override {
        super.setUp();
        anon = new AnonLauncher(owner, address(launchpad), address(feeRouter), address(quote), treasury, address(0), 0);
        feeVault = new CurveFeeVault(address(feeRouter), address(anon));
        address d = address(new CurveDeployer(address(feeVault)));
        vm.prank(owner);
        launchpad.setCurveDeployer(d);
        quote.mint(payer, 10_000_000 ether);
        vm.prank(payer);
        quote.approve(address(anon), type(uint256).max);
        router.setUsdgRouting(address(quote), address(launchpad));
    }

    function _p(uint256 buy) internal view returns (ILaunchpad.LaunchParams memory) {
        return ILaunchpad.LaunchParams({
            name: "Anon",
            ticker: "ANON",
            imageURI: "ipfs://x",
            description: "",
            socialsURI: "",
            quote: address(quote),
            creatorTaxBps: 0,
            creatorBuyQuoteIn: buy,
            creatorBuyMinTokensOut: 0,
            deadline: block.timestamp + 1 hours
        });
    }

    function _anon(uint8 mode, uint256 buy) internal returns (ILaunchpad.LaunchResult memory r) {
        vm.prank(payer);
        r = anon.launchAnonWithMode(_p(buy), mode, stealth, recipient, "", 0x00, 0);
    }

    function _launchUsdg(uint8 mode, uint256 usdgIn) internal returns (ILaunchpad.LaunchResult memory r) {
        vm.prank(payer);
        (r,) = anon.launchAnonWithUsdgMode(_p(0), mode, stealth, recipient, "", 0x00, 0, usdgIn, usdgIn, address(0));
    }

    function _grad(BondingCurve c) internal {
        _warpPastSnipe();
        for (uint256 i; i < 200 && !c.graduated(); ++i) {
            address w = makeAddr(string(abi.encodePacked("mw", vm.toString(++walletNonce))));
            quote.mint(w, 1_000_000 ether);
            vm.startPrank(w);
            quote.approve(address(c), 1_000_000 ether);
            c.buy(1_000_000 ether, 0, block.timestamp + 1 hours);
            vm.stopPrank();
        }
        assertTrue(c.graduated(), "graduated");
    }

    // ───────── Trench / Hard: boost goes straight to the recipient ─────────

    function test_legacyLaunchAnon_staysTrench() public {
        vm.prank(payer);
        ILaunchpad.LaunchResult memory r = anon.launchAnon(_p(10 ether), stealth, recipient, "", 0x00, 0);
        assertEq(launchpad.modeOf(r.token), Constants.MODE_TRENCH);
        assertEq(Token(r.token).balanceOf(recipient), r.creatorTokensBought);
    }

    function test_hard_sendsBoostNow() public {
        ILaunchpad.LaunchResult memory r = _anon(Constants.MODE_PVP, 10 ether);
        assertEq(launchpad.modeOf(r.token), Constants.MODE_PVP);
        assertEq(launchpad.creatorOf(r.token), address(anon));
        assertEq(anon.stealthOwnerOf(r.token), stealth);
        assertGt(r.creatorTokensBought, 0);
        assertEq(Token(r.token).balanceOf(recipient), r.creatorTokensBought);
        assertEq(Token(r.token).balanceOf(address(anon)), 0);
        (address held,,) = anon.heldBoost(r.token);
        assertEq(held, address(0));
    }

    function test_trenchWithMode_sendsBoostNow() public {
        ILaunchpad.LaunchResult memory r = _anon(Constants.MODE_TRENCH, 10 ether);
        assertEq(launchpad.modeOf(r.token), Constants.MODE_TRENCH);
        assertEq(Token(r.token).balanceOf(recipient), r.creatorTokensBought);
    }

    function test_hard_usdg_sendsBoostNow() public {
        ILaunchpad.LaunchResult memory r = _launchUsdg(Constants.MODE_PVP, 10 ether);
        assertEq(launchpad.modeOf(r.token), Constants.MODE_PVP);
        assertEq(launchpad.creatorOf(r.token), address(anon));
        assertEq(Token(r.token).balanceOf(recipient), r.creatorTokensBought);
    }

    function test_badMode_reverts() public {
        vm.prank(payer);
        vm.expectRevert();
        anon.launchAnonWithMode(_p(0), 3, stealth, recipient, "", 0x00, 0);
    }

    function test_noBoost_easy_holdsNothing() public {
        ILaunchpad.LaunchResult memory r = _anon(Constants.MODE_PVE, 0);
        assertEq(launchpad.modeOf(r.token), Constants.MODE_PVE);
        (address held,,) = anon.heldBoost(r.token);
        assertEq(held, address(0));
        vm.expectRevert(AnonLauncher.NothingHeld.selector);
        anon.releaseBoost(r.token);
    }

    // ───────── Easy: boost held until orbit ─────────

    function _checkEasyHeld(ILaunchpad.LaunchResult memory r) internal view {
        assertEq(launchpad.modeOf(r.token), Constants.MODE_PVE);
        assertTrue(Token(r.token).creatorLockActive(), "Easy creator lock is on");
        assertGt(r.creatorTokensBought, 0);
        assertEq(Token(r.token).balanceOf(address(anon)), r.creatorTokensBought, "held on the launcher");
        assertEq(Token(r.token).balanceOf(recipient), 0);
        (address to, uint96 amt, address curve) = anon.heldBoost(r.token);
        assertEq(to, recipient);
        assertEq(amt, r.creatorTokensBought);
        assertEq(curve, r.curve);
        (,, uint256 tokenAmt) = anon.pending(r.token);
        assertEq(tokenAmt, 0, "the held boost is not creator fees");
    }

    function _checkRelease(ILaunchpad.LaunchResult memory r) internal {
        _grad(BondingCurve(r.curve));
        assertFalse(Token(r.token).creatorLockActive(), "lock off after orbit");
        anon.releaseBoost(r.token); // anyone
        assertEq(Token(r.token).balanceOf(recipient), r.creatorTokensBought);
        (address to,,) = anon.heldBoost(r.token);
        assertEq(to, address(0), "cleared");
        vm.expectRevert(AnonLauncher.NothingHeld.selector);
        anon.releaseBoost(r.token);
    }

    function test_easy_holdsBoost_thenReleasesAfterOrbit() public {
        ILaunchpad.LaunchResult memory r = _anon(Constants.MODE_PVE, 10 ether);
        _checkEasyHeld(r);
        // before orbit: nothing to pay out yet
        vm.expectRevert(AnonLauncher.NothingToClaim.selector);
        anon.releaseBoost(r.token);
        // the stealth owner cannot sweep the held boost as "creator fees"
        address[] memory ts = new address[](1);
        ts[0] = r.token;
        vm.prank(stealth);
        vm.expectRevert(AnonLauncher.NothingToClaim.selector);
        anon.claimMany(ts, stealth);
        _checkRelease(r);
    }

    function test_easy_usdg_holdsBoost_thenReleasesAfterOrbit() public {
        ILaunchpad.LaunchResult memory r = _launchUsdg(Constants.MODE_PVE, 10 ether);
        _checkEasyHeld(r);
        _checkRelease(r);
    }

    function test_easy_heldBoostEarnsCrewTips_paidToRecipient() public {
        ILaunchpad.LaunchResult memory r = _anon(Constants.MODE_PVE, 10 ether);
        BondingCurve c = BondingCurve(r.curve);
        _warpPastSnipe();
        // a big early buyer sells at a profit after a pump: the Easy crew tip goes to holders, the held boost included
        address alice = makeAddr("alice");
        quote.mint(alice, 10_000_000 ether);
        vm.startPrank(alice);
        quote.approve(address(c), type(uint256).max);
        c.buy(1_000 ether, 0, block.timestamp + 1 hours);
        vm.stopPrank();
        // pump the mcap like ModeRulesV2.test_crewTip_thresholdEdges so alice's whole-position sale pays the tip
        for (uint256 i; i < 200 && !c.graduated() && c.marketCapUsd() < 25_000e18; ++i) {
            address w = makeAddr(string(abi.encodePacked("pump", vm.toString(i))));
            quote.mint(w, 1_000 ether);
            vm.startPrank(w);
            quote.approve(address(c), 200 ether);
            c.buy(200 ether, 0, block.timestamp + 1 hours);
            vm.stopPrank();
        }
        uint256 bal = Token(r.token).balanceOf(alice);
        vm.startPrank(alice);
        Token(r.token).approve(address(c), bal);
        c.sell(bal, 0, block.timestamp + 1 hours);
        vm.stopPrank();
        uint256 owed = c.pendingRewards(address(anon));
        assertGt(owed, 0, "the held boost earned crew tips");
        uint256 q0 = quote.balanceOf(recipient);
        anon.releaseBoost(r.token); // pre-orbit: pays rewards only, keeps holding the boost
        assertEq(quote.balanceOf(recipient) - q0, owed, "crew tips to the boost recipient");
        (address to,,) = anon.heldBoost(r.token);
        assertEq(to, recipient, "still held until orbit");
        assertEq(Token(r.token).balanceOf(recipient), 0);
    }
}
