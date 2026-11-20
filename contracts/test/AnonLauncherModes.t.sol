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
        anon = new AnonLauncher(owner, address(launchpad), address(feeRouter), address(quote), address(0));
        feeVault = new CurveFeeVault(address(feeRouter), address(anon));
        address d = address(new CurveDeployer(address(feeVault), address(launchpad)));
        vm.prank(owner);
        vm.store(address(launchpad), bytes32(uint256(5)), bytes32(0)); // test-only: the deployer is write-once
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
        ILaunchpad.LaunchResult memory r = anon.launchAnon(_p(0), stealth, recipient, "", 0x00, 0);
        assertEq(launchpad.modeOf(r.token), Constants.MODE_TRENCH);
    }

    /// @notice maker 2026-11-19: no First BOOST on hidden launches, in any mode or pay path.
    function test_everyMode_firstBoost_blocked() public {
        uint8[3] memory modes = [Constants.MODE_TRENCH, Constants.MODE_PVE, Constants.MODE_PVP];
        for (uint256 i; i < 3; ++i) {
            vm.prank(payer);
            vm.expectRevert(AnonLauncher.NoFirstBoost.selector);
            anon.launchAnonWithMode(_p(10 ether), modes[i], stealth, recipient, "", 0x00, 0);
            vm.prank(payer);
            vm.expectRevert(AnonLauncher.NoFirstBoost.selector);
            anon.launchAnonWithUsdgMode(_p(0), modes[i], stealth, recipient, "", 0x00, 0, 10 ether, 0, address(0));
        }
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

}
