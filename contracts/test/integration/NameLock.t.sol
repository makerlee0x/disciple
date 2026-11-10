// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./IntegrationBase.sol";
import {NameRegistry} from "../../src/NameRegistry.sol";

/// @dev Shared helpers: launch with an explicit name/ticker/image.
abstract contract NameLockHelpers is IntegrationBase {
    function _launchNamed(string memory name, string memory ticker, string memory image, uint256 creatorBuy)
        internal
        returns (BondingCurve curve, Token tok)
    {
        vm.startPrank(creator);
        if (creatorBuy > 0) quote.approve(address(launchpad), creatorBuy);
        ILaunchpad.LaunchResult memory r = launchpad.launchCoin(_params(name, ticker, image, creatorBuy));
        vm.stopPrank();
        curve = BondingCurve(r.curve);
        tok = Token(r.token);
    }

    function _params(string memory name, string memory ticker, string memory image, uint256 creatorBuy)
        internal
        view
        returns (ILaunchpad.LaunchParams memory)
    {
        return ILaunchpad.LaunchParams({
            name: name,
            ticker: ticker,
            imageURI: image,
            description: "",
            socialsURI: "",
            quote: address(quote),
            creatorTaxBps: 0,
            creatorBuyQuoteIn: creatorBuy,
            creatorBuyMinTokensOut: 0,
            deadline: vm.getBlockTimestamp() + 1 days
        });
    }

    function _expectLaunchRevert(string memory name, string memory ticker, bytes4 sel) internal {
        ILaunchpad.LaunchParams memory p = _params(name, ticker, "ipfs://x", 0);
        vm.prank(creator);
        vm.expectRevert(sel);
        launchpad.launchCoin(p);
    }

    function _mockMcap(BondingCurve c, uint256 usd) internal {
        vm.mockCall(address(c), abi.encodeWithSelector(BondingCurve.marketCapUsd.selector), abi.encode(usd));
    }
}

/// @notice Name/ticker lock with nameLock = true (the MAINNET Deploy.s.sol configuration).
contract NameLockTest is NameLockHelpers {
    uint256 constant BELOW = Constants.OUTER_SPACE_MCAP_USD - 1;
    uint256 constant AT = Constants.OUTER_SPACE_MCAP_USD;

    function _nameLock() internal pure override returns (bool) {
        return true;
    }

    function _ascendedHolder() internal returns (BondingCurve c, Token t) {
        (c, t) = _launchNamed("Pepe Coin", "PEPE", "ipfs://a", 0);
        _graduate(c);
        assertTrue(nameRegistry.claimName(address(t)));
    }

    function test_wired() public view {
        assertEq(NameRegistry.checkLaunch.selector, bytes4(0xc64f7389), "Launchpad inline selector");
        assertEq(nameRegistry.launchpad(), address(launchpad));
    }

    function test_setLaunchpad_once_deployer_only() public {
        vm.expectRevert(NameRegistry.LaunchpadAlreadySet.selector);
        nameRegistry.setLaunchpad(makeAddr("x"));
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(NameRegistry.OnlyDeployer.selector);
        nameRegistry.setLaunchpad(makeAddr("x"));
    }

    function test_normalization_case_and_whitespace() public view {
        bytes32 k = nameRegistry.nameKey("pepe coin", "pepe");
        assertEq(nameRegistry.nameKey("  Pepe Coin\t", "PEPE "), k, "case + outer whitespace");
        assertEq(nameRegistry.nameKey("\n\r\x0b\x0cPEPE COIN ", " PePe"), k, "all ASCII whitespace trimmed");
        assertTrue(nameRegistry.nameKey("pepe  coin", "pepe") != k, "inner whitespace kept");
        assertTrue(nameRegistry.nameKey("pepe coin", "pepe2") != k);
        // non-ASCII is not folded ("exact"): Cyrillic 'е' differs from ASCII 'e'
        assertTrue(nameRegistry.nameKey(unicode"pеpe coin", "pepe") != k);
        // the pair is abi.encoded: moving bytes between name and ticker is a different key
        assertTrue(nameRegistry.nameKey("pepe coinp", "epe") != k);
        assertEq(nameRegistry.nameKey("   ", " "), nameRegistry.nameKey("", ""));
    }

    function test_launch_reverts_when_locked() public {
        (, Token t) = _ascendedHolder();
        assertEq(nameRegistry.nameHolder(nameRegistry.nameKey("pepe coin", "pepe")), address(t));
        _expectLaunchRevert("Pepe Coin", "PEPE", NameRegistry.NameLocked.selector);
        _expectLaunchRevert(" pepe coin ", "pepe", NameRegistry.NameLocked.selector);
        _expectLaunchRevert("PEPE COIN", "\tPePe\n", NameRegistry.NameLocked.selector);
    }

    function test_share_name_only_or_ticker_only_allowed() public {
        _ascendedHolder();
        _launchNamed("Pepe Coin", "PEPE2", "ipfs://a", 0); // same name + same image, other ticker
        _launchNamed("Pepe Coin 2", "PEPE", "ipfs://a", 0); // same ticker + same image, other name
        _launchNamed("Frog", "FROG", "ipfs://a", 0); // same image only
    }

    function test_claim_only_after_graduation() public {
        (, Token t) = _launchNamed("Pepe Coin", "PEPE", "ipfs://a", 0);
        vm.expectRevert(NameRegistry.NotAscended.selector);
        nameRegistry.claimName(address(t));
        vm.expectRevert(NameRegistry.UnknownCoin.selector);
        nameRegistry.claimName(makeAddr("notACoin"));
        // a not-yet-ascended coin locks nothing: a copy can launch
        _launchNamed("pepe coin", "pepe", "ipfs://b", 0);
    }

    function test_claim_idempotent_and_permissionless() public {
        (, Token t) = _ascendedHolder();
        vm.prank(makeAddr("anyone"));
        assertTrue(nameRegistry.claimName(address(t)));
        vm.recordLogs();
        assertTrue(nameRegistry.claimName(address(t)));
        assertEq(vm.getRecordedLogs().length, 0, "no second NameClaimed");
    }

    /// lee 2026-11-10 (2): copies live before the original ascends may ascend with no lock; their claim no-ops.
    function test_preexisting_copy_cannot_claim_and_still_ascends_and_trades() public {
        (BondingCurve a, Token ta) = _launchNamed("Pepe Coin", "PEPE", "ipfs://a", 0);
        (BondingCurve b, Token tb) = _launchNamed("pepe coin ", "pepe", "ipfs://b", 0);
        _graduate(a);
        assertTrue(nameRegistry.claimName(address(ta)));
        _graduate(b); // B's graduation is untouched by the lock
        assertTrue(b.graduated());
        assertFalse(nameRegistry.claimName(address(tb)), "held by A: no-op");
        bytes32 k = nameRegistry.nameKey("pepe coin", "pepe");
        assertEq(nameRegistry.nameHolder(k), address(ta));
        // B trades post-ascend as usual
        _swapExactInQuoteForToken(tb, trader1, 10 ether);
        assertGt(tb.balanceOf(trader1), 0);
        vm.expectRevert(NameRegistry.NotNameHolder.selector);
        nameRegistry.markBelow(address(tb));
        vm.expectRevert(NameRegistry.NotNameHolder.selector);
        nameRegistry.releaseName(address(tb));
    }

    function test_release_24h_with_reset() public {
        (BondingCurve c, Token t) = _ascendedHolder();
        bytes32 k = nameRegistry.nameKey("pepe coin", "pepe");
        vm.expectRevert(NameRegistry.ReleaseTooEarly.selector);
        nameRegistry.releaseName(address(t)); // never marked

        _mockMcap(c, AT);
        assertEq(nameRegistry.markBelow(address(t)), 0, "at the threshold is not below");

        _mockMcap(c, BELOW);
        uint256 t0 = vm.getBlockTimestamp();
        vm.expectEmit(true, true, false, true, address(nameRegistry));
        emit NameRegistry.NameReleaseMarked(k, address(t), t0);
        assertEq(nameRegistry.markBelow(address(t)), t0);
        vm.warp(t0 + 1 hours);
        assertEq(nameRegistry.markBelow(address(t)), t0, "re-mark keeps the first time");

        vm.warp(t0 + 24 hours - 1);
        vm.expectRevert(NameRegistry.ReleaseTooEarly.selector);
        nameRegistry.releaseName(address(t));

        // back above → the mark resets (anyone)
        _mockMcap(c, AT);
        vm.expectEmit(true, true, false, true, address(nameRegistry));
        emit NameRegistry.NameReleaseMarked(k, address(t), 0);
        vm.prank(makeAddr("defender"));
        assertEq(nameRegistry.markBelow(address(t)), 0);
        vm.warp(t0 + 25 hours);
        vm.expectRevert(NameRegistry.ReleaseTooEarly.selector);
        nameRegistry.releaseName(address(t));

        // below again: a fresh 24h; at release time back above → no release, mark reset
        _mockMcap(c, BELOW);
        uint256 t1 = vm.getBlockTimestamp();
        nameRegistry.markBelow(address(t));
        vm.warp(t1 + 24 hours);
        _mockMcap(c, AT);
        assertFalse(nameRegistry.releaseName(address(t)), "final check above");
        assertEq(nameRegistry.nameBelowSince(address(t)), 0);
        assertEq(nameRegistry.nameHolder(k), address(t));

        // below for a full 24h and still below at the final check → freed
        _mockMcap(c, BELOW);
        uint256 t2 = vm.getBlockTimestamp();
        nameRegistry.markBelow(address(t));
        vm.warp(t2 + 24 hours);
        vm.expectEmit(true, true, false, false, address(nameRegistry));
        emit NameRegistry.NameReleased(k, address(t));
        vm.prank(makeAddr("anyone"));
        assertTrue(nameRegistry.releaseName(address(t)));
        assertEq(nameRegistry.nameHolder(k), address(0));
        assertEq(nameRegistry.nameBelowSince(address(t)), 0);
    }

    function test_relaunch_allowed_after_release_and_reclaim_rules() public {
        (BondingCurve c, Token t) = _ascendedHolder();
        _mockMcap(c, BELOW);
        nameRegistry.markBelow(address(t));
        vm.warp(block.timestamp + 24 hours);
        assertTrue(nameRegistry.releaseName(address(t)));
        vm.clearMockedCalls();
        (, Token t2) = _launchNamed("PEPE COIN", "Pepe", "ipfs://new", 0);
        assertTrue(address(t2) != address(0));
        // the original can re-claim (it is still ascended); first claim wins the free slot
        assertTrue(nameRegistry.claimName(address(t)));
        _expectLaunchRevert("Pepe Coin", "PEPE", NameRegistry.NameLocked.selector);
    }

    function test_real_drop_back_marks_without_mocks() public {
        (BondingCurve c, Token t) = _launchNamed("Pepe Coin", "PEPE", "ipfs://a", 1_000 ether);
        _graduate(c);
        assertTrue(nameRegistry.claimName(address(t)));
        uint256 bal = t.balanceOf(creator);
        assertGt(bal, 0);
        _swapExactInTokenForQuote(t, creator, bal); // TRENCH First BOOST is free to sell
        assertLt(c.marketCapUsd(), Constants.OUTER_SPACE_MCAP_USD, "dumped below Outer Space");
        uint256 g = gasleft();
        uint256 since = nameRegistry.markBelow(address(t));
        emit log_named_uint("MARK_BELOW_GAS(real v4 mcap)", g - gasleft());
        assertEq(since, vm.getBlockTimestamp());
    }

    function test_image_edit_after_claim_allowed() public {
        (, Token t) = _ascendedHolder();
        vm.prank(creator);
        launchpad.updateMetadata(address(t), "ipfs://new-image", "d", "s");
        (,, string memory img,,,,,) = launchpad.metaOf(address(t));
        assertEq(img, "ipfs://new-image");
        assertEq(nameRegistry.nameHolder(nameRegistry.nameKey("pepe coin", "pepe")), address(t), "lock unchanged");
        _expectLaunchRevert("Pepe Coin", "PEPE", NameRegistry.NameLocked.selector);
    }

    function test_launchpad_size_under_eip170() public {
        uint256 sz = address(launchpad).code.length;
        emit log_named_uint("LAUNCHPAD_RUNTIME_BYTES", sz);
        emit log_named_uint("NAMEREGISTRY_RUNTIME_BYTES", address(nameRegistry).code.length);
        assertLe(sz, 24_576, "EIP-170");
        assertLe(address(nameRegistry).code.length, 24_576, "EIP-170");
    }

    /// @dev Gas numbers for the report (logged; -vv).
    function test_gas_name_lock_calls() public {
        _launchNamed("Warm", "WARM", "ipfs://w", 0); // warm shared slots, same as the base temp test
        ILaunchpad.LaunchParams memory p = _params("Pepe Coin", "PEPE", "ipfs://a", 0);
        vm.prank(creator);
        uint256 g0 = gasleft();
        ILaunchpad.LaunchResult memory lr = launchpad.launchCoin(p);
        emit log_named_uint("LAUNCH_GAS_LOCK_ON_NO_COLLISION", g0 - gasleft());
        BondingCurve c = BondingCurve(lr.curve);
        Token t = Token(lr.token);
        _graduate(c);
        uint256 g = gasleft();
        nameRegistry.claimName(address(t));
        emit log_named_uint("CLAIM_GAS", g - gasleft());
        _mockMcap(c, BELOW);
        g = gasleft();
        nameRegistry.markBelow(address(t));
        emit log_named_uint("MARK_BELOW_GAS(mocked mcap)", g - gasleft());
        vm.warp(block.timestamp + 24 hours);
        g = gasleft();
        nameRegistry.releaseName(address(t));
        emit log_named_uint("RELEASE_GAS(mocked mcap)", g - gasleft());
        vm.clearMockedCalls();
        // real-mcap view cost (post-grad marketCapUsd reads v4 slot0 + pricer)
        g = gasleft();
        c.marketCapUsd();
        emit log_named_uint("MCAP_VIEW_GAS", g - gasleft());
    }
}

/// @notice nameLock = false (testnet/local Deploy.s.sol): behaves exactly as before the lock.
contract NameLockOffTest is NameLockHelpers {
    function test_flag_off_is_a_noop() public {
        (BondingCurve c,) = _launchNamed("Pepe Coin", "PEPE", "ipfs://a", 0);
        _graduate(c);
        // exact duplicate (name, ticker and image) of an ascended coin still launches
        (, Token t2) = _launchNamed("Pepe Coin", "PEPE", "ipfs://a", 0);
        assertTrue(address(t2) != address(0));
    }
}
