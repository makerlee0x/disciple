// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./integration/IntegrationBase.sol";
import {Vm} from "forge-std/Vm.sol";
import {AnonLauncher} from "../src/addons/AnonLauncher.sol";
import {AnonLaunchPool} from "../src/addons/AnonLaunchPool.sol";
import {Owned2Step} from "../src/utils/Owned2Step.sol";

/// @notice maker 2026-11-19: an anon launch must not put the player's wallet in the launch transaction, with or without
///         a paid First BOOST, on every difficulty. The pool pays; the player's wallet only ever appears in an earlier,
///         separate deposit.
contract AnonLaunchPoolTest is IntegrationBase {
    AnonLauncher internal anon;
    AnonLaunchPool internal pool;
    address internal player = makeAddr("player"); // the wallet that must never show up in the launch tx
    address internal relayer = makeAddr("relayer");
    address internal stealth = makeAddr("stealth");
    address internal signer;
    uint256 internal signerKey;
    uint256 internal walletNonce;
    uint256 internal constant LIMIT = 10_000 ether;

    function setUp() public override {
        super.setUp();
        anon = new AnonLauncher(owner, address(launchpad), address(feeRouter), address(quote), address(0));
        feeVault = new CurveFeeVault(address(feeRouter), address(anon));
        address d = address(new CurveDeployer(address(feeVault)));
        vm.store(address(launchpad), bytes32(uint256(5)), bytes32(0)); // test-only: the deployer is write-once
        vm.prank(owner);
        launchpad.setCurveDeployer(d);
        router.setUsdgRouting(address(quote), address(launchpad));

        vm.startPrank(owner);
        harvest.wire(address(launchpad), address(feeRouter), address(lockedLP), address(router), address(manager));
        launchpad.setTrustedRouter(address(harvest), true);
        launchpad.setTrustedRouter(address(router), true); // curveRouter back to DiscipleRouter for USDG launches
        feeRouter.setClaimRouter(address(harvest), true);
        feeRouter.setCreatorFeeHarvest_51(address(harvest));
        harvest.setFeeVault(address(feeVault));
        harvest.setAnonLauncher(address(anon));
        anon.setCreatorFeeHarvest(address(harvest));
        vm.stopPrank();

        (signer, signerKey) = makeAddrAndKey("spendSigner");
        pool = new AnonLaunchPool(owner, address(quote), address(anon), address(harvest), signer, LIMIT);

        quote.mint(player, 1_000 ether);
        vm.startPrank(player);
        quote.approve(address(pool), type(uint256).max);
        pool.deposit(500 ether);
        vm.stopPrank();
    }

    function _args(uint8 mode, uint8 dest) internal view returns (AnonLaunchPool.LaunchArgs memory a) {
        a.p = ILaunchpad.LaunchParams({
            name: "Anon",
            ticker: "ANON",
            imageURI: "ipfs://x",
            description: "",
            socialsURI: "",
            quote: address(quote),
            creatorTaxBps: 0,
            creatorBuyQuoteIn: 0,
            creatorBuyMinTokensOut: 0,
            deadline: block.timestamp + 1 hours
        });
        a.mode = mode;
        a.stealthOwner = stealth;
        a.buyRecipient = stealth;
        a.ephemeralPubKey = hex"02aa";
        a.viewTag = 0x11;
        a.creatorFeeDestination = dest;
    }

    function _sigLaunch(AnonLaunchPool.LaunchArgs memory a, uint256 usdgIn, uint256 nonce, uint256 dl)
        internal
        view
        returns (bytes memory)
    {
        bytes32 lh = this.launchHashOf(a);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, pool.launchDigest(lh, usdgIn, nonce, dl));
        return abi.encodePacked(r, s, v);
    }

    /// @dev calldata hop so the memory struct can be hashed by the pool's calldata helper
    function launchHashOf(AnonLaunchPool.LaunchArgs calldata a) external view returns (bytes32) {
        return pool.launchHash(a);
    }

    function _launch(uint8 mode, uint8 dest, uint256 usdgIn, uint256 nonce)
        internal
        returns (ILaunchpad.LaunchResult memory r, uint256 spent)
    {
        AnonLaunchPool.LaunchArgs memory a = _args(mode, dest);
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory sig = _sigLaunch(a, usdgIn, nonce, dl);
        vm.prank(relayer);
        (r, spent) = pool.launch(a, usdgIn, nonce, dl, sig);
    }

    /// @dev No log topic or data word in the launch tx may hold the player's address.
    function _assertPlayerNotInLogs(Vm.Log[] memory logs) internal view {
        bytes32 w = bytes32(uint256(uint160(player)));
        for (uint256 i; i < logs.length; ++i) {
            for (uint256 j; j < logs[i].topics.length; ++j) {
                assertTrue(logs[i].topics[j] != w, "player in a topic");
            }
            bytes memory d = logs[i].data;
            for (uint256 k; k + 32 <= d.length; k += 32) {
                bytes32 word;
                assembly {
                    word := mload(add(add(d, 32), k))
                }
                assertTrue(word != w, "player in log data");
            }
        }
    }

    // ───────── every difficulty, paid and free, keep / pool / burn ─────────

    function _check(uint8 mode, uint8 dest, uint256 usdgIn, uint256 nonce) internal {
        uint256 p0 = quote.balanceOf(player);
        uint256 pool0 = quote.balanceOf(address(pool));
        vm.recordLogs();
        (ILaunchpad.LaunchResult memory r, uint256 spent) = _launch(mode, dest, usdgIn, nonce);
        _assertPlayerNotInLogs(vm.getRecordedLogs());
        assertEq(launchpad.modeOf(r.token), mode, "difficulty");
        assertEq(launchpad.creatorOf(r.token), address(anon), "creator = launcher");
        assertEq(anon.stealthOwnerOf(r.token), stealth, "stealth owner");
        assertEq(quote.balanceOf(player), p0, "player wallet untouched");
        assertEq(pool0 - quote.balanceOf(address(pool)), spent, "spent from pool only");
        assertLe(spent, usdgIn);
        if (usdgIn > 0) assertGt(r.creatorTokensBought, 0);
        if (dest != 0) assertEq(harvest.creatorFeeDestinationOf(r.token), dest);
        assertEq(quote.allowance(address(pool), address(anon)), 0);
        assertEq(quote.allowance(address(pool), address(harvest)), 0);
    }

    function test_trench_paid() public {
        _check(Constants.MODE_TRENCH, 0, 10 ether, 1);
    }

    function test_hard_paid() public {
        _check(Constants.MODE_PVP, 0, 10 ether, 2);
    }

    function test_easy_paid_boostHeldForStealth() public {
        _check(Constants.MODE_PVE, 0, 10 ether, 3);
    }

    function test_free_everyMode() public {
        _check(Constants.MODE_TRENCH, 0, 0, 4);
        _check(Constants.MODE_PVE, 0, 0, 5);
        _check(Constants.MODE_PVP, 0, 0, 6);
    }

    function test_harvest_lockedPool_and_burn_paid() public {
        _check(Constants.MODE_PVP, 1, 10 ether, 7);
        _check(Constants.MODE_TRENCH, 2, 10 ether, 8);
    }

    function test_easy_free_withDailyLimitZero() public {
        vm.prank(owner);
        pool.setDailyLimit(0);
        _check(Constants.MODE_PVE, 0, 0, 9);
    }

    function test_partialFill_refundStaysInPool() public {
        // far above the Trench cap: the Launchpad fills to the cap and the rest comes back to the pool, not a player
        (, uint256 spent) = _launch(Constants.MODE_TRENCH, 0, 400 ether, 10);
        assertLt(spent, 400 ether);
        assertEq(quote.balanceOf(address(pool)), 500 ether - spent);
    }

    // ───────── auth ─────────

    function test_relayerCannotChangeAnyField() public {
        AnonLaunchPool.LaunchArgs memory a = _args(Constants.MODE_TRENCH, 0);
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory sig = _sigLaunch(a, 10 ether, 1, dl);
        a.buyRecipient = relayer;
        vm.expectRevert(AnonLaunchPool.BadSignature.selector);
        pool.launch(a, 10 ether, 1, dl, sig);
        a.buyRecipient = stealth;
        vm.expectRevert(AnonLaunchPool.BadSignature.selector);
        pool.launch(a, 20 ether, 1, dl, sig);
        a.mode = Constants.MODE_PVP;
        vm.expectRevert(AnonLaunchPool.BadSignature.selector);
        pool.launch(a, 10 ether, 1, dl, sig);
    }

    function test_nonceSingleUse_and_deadline_and_pause() public {
        _launch(Constants.MODE_TRENCH, 0, 0, 42);
        AnonLaunchPool.LaunchArgs memory a = _args(Constants.MODE_TRENCH, 0);
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory sig = _sigLaunch(a, 0, 42, dl);
        vm.expectRevert(AnonLaunchPool.NonceUsed.selector);
        pool.launch(a, 0, 42, dl, sig);

        sig = _sigLaunch(a, 0, 43, block.timestamp - 1);
        vm.expectRevert(AnonLaunchPool.Expired.selector);
        pool.launch(a, 0, 43, block.timestamp - 1, sig);

        vm.prank(owner);
        pool.setPaused(true);
        sig = _sigLaunch(a, 0, 44, dl);
        vm.expectRevert(AnonLaunchPool.Paused.selector);
        pool.launch(a, 0, 44, dl, sig);
    }

    function test_badDestination() public {
        AnonLaunchPool.LaunchArgs memory a = _args(Constants.MODE_TRENCH, 3);
        vm.expectRevert(AnonLaunchPool.BadDestination.selector);
        pool.launch(a, 0, 1, block.timestamp + 1, "");
        AnonLaunchPool noHarvest = new AnonLaunchPool(owner, address(quote), address(anon), address(0), signer, LIMIT);
        a.creatorFeeDestination = 1;
        vm.expectRevert(AnonLaunchPool.BadDestination.selector);
        noHarvest.launch(a, 0, 1, block.timestamp + 1, "");
    }

    // ───────── payout + daily limit ─────────

    function _sigPayout(address to, uint256 amt, uint256 nonce, uint256 dl) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, pool.payoutDigest(to, amt, nonce, dl));
        return abi.encodePacked(r, s, v);
    }

    function test_payout_signed_only() public {
        address to = makeAddr("cashOut");
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory sig = _sigPayout(to, 100 ether, 77, dl);
        vm.expectRevert(AnonLaunchPool.BadSignature.selector);
        pool.payout(relayer, 100 ether, 77, dl, sig);
        pool.payout(to, 100 ether, 77, dl, sig);
        assertEq(quote.balanceOf(to), 100 ether);
        vm.expectRevert(AnonLaunchPool.NonceUsed.selector);
        pool.payout(to, 100 ether, 77, dl, sig);
    }

    function test_dailyLimit_capsOutflow_resetsNextDay() public {
        vm.prank(owner);
        pool.setDailyLimit(150 ether);
        address to = makeAddr("cashOut");
        uint256 dl = block.timestamp + 2 days;
        pool.payout(to, 100 ether, 1, dl, _sigPayout(to, 100 ether, 1, dl));
        bytes memory sig = _sigPayout(to, 60 ether, 2, dl);
        vm.expectRevert(AnonLaunchPool.OverDailyLimit.selector);
        pool.payout(to, 60 ether, 2, dl, sig);
        vm.warp(block.timestamp + 1 days);
        pool.payout(to, 60 ether, 2, dl, sig);
        assertEq(quote.balanceOf(to), 160 ether);
    }

    function test_admin_ownerOnly_and_noOwnerSweep() public {
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        pool.setSpendSigner(relayer);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        pool.setPaused(true);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        pool.setDailyLimit(1);
        vm.prank(owner);
        vm.expectRevert(AnonLaunchPool.ZeroAddress.selector);
        pool.setSpendSigner(address(0));
        // a rotated signer voids the old key at once
        vm.prank(owner);
        pool.setSpendSigner(relayer);
        address to = makeAddr("cashOut");
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory sig = _sigPayout(to, 1 ether, 5, dl);
        vm.expectRevert(AnonLaunchPool.BadSignature.selector);
        pool.payout(to, 1 ether, 5, dl, sig);
    }

    function test_deposit_event() public {
        vm.expectEmit(true, false, false, true, address(pool));
        emit AnonLaunchPool.Deposited(player, 1 ether);
        vm.prank(player);
        pool.deposit(1 ether);
    }

    /// @dev Same fixed args as web/tests/gasless-anon-pool.test.ts: the site's launch hash and EIP-712 digests match.
    function test_vector_matchesSite() public {
        AnonLaunchPool.LaunchArgs memory a;
        a.p = ILaunchpad.LaunchParams({
            name: "Anon",
            ticker: "ANON",
            imageURI: "ipfs://x",
            description: "d",
            socialsURI: "s",
            quote: 0x1111111111111111111111111111111111111111,
            creatorTaxBps: 100,
            creatorBuyQuoteIn: 0,
            creatorBuyMinTokensOut: 5,
            deadline: 1_000_000
        });
        a.mode = 1;
        a.stealthOwner = 0x2222222222222222222222222222222222222222;
        a.buyRecipient = 0x3333333333333333333333333333333333333333;
        a.ephemeralPubKey = hex"02aa";
        a.viewTag = 0x11;
        a.minQuoteIn = 7;
        a.creatorFeeDestination = 2;
        bytes32 lh = this.launchHashOf(a);
        assertEq(lh, 0x5c3176a1c2e679876562e34d6563021d47babd48ba75cae994a85bc3a27af651, "launchHash");

        vm.chainId(4663);
        address at = 0x4444444444444444444444444444444444444444;
        deployCodeTo(
            "AnonLaunchPool.sol:AnonLaunchPool",
            abi.encode(owner, address(quote), address(anon), address(harvest), signer, LIMIT),
            at
        );
        AnonLaunchPool v = AnonLaunchPool(at);
        assertEq(v.launchDigest(lh, 10, 9, 99), 0x630029e57489cadfab66cd4e87c0bf481c2c0de2963344b94ff3222e1e22f818);
        assertEq(
            v.payoutDigest(a.buyRecipient, 10, 9, 99),
            0x303235c33178b4a5874ad72e0f485ba768ef16f7cb94092484a2263ee927f41e
        );
    }
}
