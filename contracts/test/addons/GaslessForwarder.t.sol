// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GaslessForwarder, IPermit2Witness} from "../../src/addons/GaslessForwarder.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {Permit2Code} from "../helpers/Permit2Code.sol";

contract FwdUsdg is ERC20 {
    constructor() ERC20("USDG", "USDG") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// @dev Stands in for AnonLauncher / CreatorFeeHarvest: pulls maxFee + usdgIn, keeps `spend`, refunds the rest to refundTo.
contract MockLauncher {
    IERC20 immutable usdg;
    uint256 public spend;
    uint8 public lastDest = 255;
    bool public leaveDust;

    constructor(IERC20 u) {
        usdg = u;
    }

    function setSpend(uint256 s, bool dust) external {
        spend = s;
        leaveDust = dust;
    }

    function _go(uint256 maxFee, uint256 usdgIn, address refundTo) internal returns (ILaunchpad.LaunchResult memory r, uint256 refund) {
        uint256 total = maxFee + usdgIn;
        usdg.transferFrom(msg.sender, address(this), total);
        refund = total - spend;
        if (leaveDust) {
            // pretend the launcher pushed a 1-unit leftover back to its caller instead of refundTo
            usdg.transfer(msg.sender, 1);
            refund -= 1;
        }
        if (refund != 0) usdg.transfer(refundTo, refund);
        r.token = address(0x7070);
    }

    function launchAnonWithUsdg(
        ILaunchpad.LaunchParams calldata,
        address,
        address,
        bytes calldata,
        bytes1,
        uint256 maxFee,
        uint256 usdgIn,
        uint256,
        address refundTo
    ) external returns (ILaunchpad.LaunchResult memory r, uint256 refund) {
        lastDest = 0;
        return _go(maxFee, usdgIn, refundTo);
    }

    function launchAnonWithUsdg(
        ILaunchpad.LaunchParams calldata,
        address,
        address,
        bytes calldata,
        bytes1,
        uint256 maxFee,
        uint256 usdgIn,
        uint256,
        address refundTo,
        uint8 dest
    ) external returns (ILaunchpad.LaunchResult memory r, uint256 refund) {
        lastDest = dest;
        return _go(maxFee, usdgIn, refundTo);
    }
}

/// @dev A permissionless action target (stands in for TrampWall.pull / claimManyBySig).
contract MockAction {
    uint256 public pulled;

    function pull(uint256 n) external {
        pulled += n;
    }

    function boom() external pure {
        revert("boom");
    }
}

contract GaslessForwarderTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

    GaslessForwarder fwd;
    FwdUsdg usdg;
    MockLauncher launcher;
    MockAction action;
    uint256 aliceKey = 0xA11CE;
    address alice;
    address dest = makeAddr("dest");
    address relayer = makeAddr("relayer");
    address mallory = makeAddr("mallory");

    function setUp() public {
        vm.etch(PERMIT2, Permit2Code.RUNTIME);
        fwd = new GaslessForwarder();
        usdg = new FwdUsdg();
        launcher = new MockLauncher(IERC20(address(usdg)));
        action = new MockAction();
        alice = vm.addr(aliceKey);
        usdg.mint(alice, 1_000e6);
        vm.prank(alice);
        usdg.approve(PERMIT2, type(uint256).max);
    }

    // ───────── signing ─────────

    function _domain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"), keccak256("Permit2"), block.chainid, PERMIT2
            )
        );
    }

    function _permit(uint256 amount, uint256 nonce) internal view returns (IPermit2Witness.PermitTransferFrom memory p) {
        p.permitted = IPermit2Witness.TokenPermissions({token: address(usdg), amount: amount});
        p.nonce = nonce;
        p.deadline = block.timestamp + 10 minutes;
    }

    function _sign(uint256 key, IPermit2Witness.PermitTransferFrom memory p, address spender, string memory witnessType, bytes32 witness)
        internal
        view
        returns (bytes memory)
    {
        bytes32 typeHash = keccak256(
            abi.encodePacked("PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,", witnessType)
        );
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash,
                keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, p.permitted.token, p.permitted.amount)),
                spender,
                p.nonce,
                p.deadline,
                witness
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", _domain(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _w(address to, uint256 amount, uint256 fee) internal view returns (GaslessForwarder.Withdraw memory) {
        return GaslessForwarder.Withdraw({to: to, amount: amount, fee: fee, feeTo: relayer});
    }

    function _signW(IPermit2Witness.PermitTransferFrom memory p, GaslessForwarder.Withdraw memory w) internal view returns (bytes memory) {
        return _sign(aliceKey, p, address(fwd), fwd.WITHDRAW_WITNESS_TYPE(), fwd.hashWithdraw(w));
    }

    // ───────── withdraw ─────────

    function test_withdraw_paysSignedDestinationAndFee() public {
        GaslessForwarder.Withdraw memory w = _w(dest, 100e6, 2e6);
        IPermit2Witness.PermitTransferFrom memory p = _permit(102e6, 1);
        bytes memory sig = _signW(p, w);
        vm.prank(relayer);
        fwd.withdraw(p, alice, w, sig);
        assertEq(usdg.balanceOf(dest), 100e6);
        assertEq(usdg.balanceOf(relayer), 2e6);
        assertEq(usdg.balanceOf(alice), 898e6);
        assertEq(usdg.balanceOf(address(fwd)), 0, "forwarder holds nothing");
    }

    function test_withdraw_anyoneCanSubmit_fundsStillGoToSignedAddresses() public {
        GaslessForwarder.Withdraw memory w = _w(dest, 100e6, 2e6);
        IPermit2Witness.PermitTransferFrom memory p = _permit(102e6, 1);
        bytes memory sig = _signW(p, w);
        vm.prank(mallory);
        fwd.withdraw(p, alice, w, sig);
        assertEq(usdg.balanceOf(dest), 100e6);
        assertEq(usdg.balanceOf(relayer), 2e6);
        assertEq(usdg.balanceOf(mallory), 0);
    }

    /// @notice The finding: an observer with the signature tries to send the money to themselves.
    function test_revert_withdraw_redirectedDestination() public {
        GaslessForwarder.Withdraw memory w = _w(dest, 100e6, 2e6);
        IPermit2Witness.PermitTransferFrom memory p = _permit(102e6, 1);
        bytes memory sig = _signW(p, w);
        w.to = mallory;
        vm.prank(mallory);
        vm.expectRevert();
        fwd.withdraw(p, alice, w, sig);
    }

    function test_revert_withdraw_changedFeeOrFeeTo() public {
        GaslessForwarder.Withdraw memory w = _w(dest, 100e6, 2e6);
        IPermit2Witness.PermitTransferFrom memory p = _permit(102e6, 1);
        bytes memory sig = _signW(p, w);
        GaslessForwarder.Withdraw memory a = _w(dest, 99e6, 3e6);
        vm.expectRevert();
        fwd.withdraw(p, alice, a, sig);
        GaslessForwarder.Withdraw memory b = _w(dest, 100e6, 2e6);
        b.feeTo = mallory;
        vm.expectRevert();
        fwd.withdraw(p, alice, b, sig);
    }

    function test_revert_withdraw_permitAmountMismatch() public {
        GaslessForwarder.Withdraw memory w = _w(dest, 100e6, 2e6);
        IPermit2Witness.PermitTransferFrom memory p = _permit(200e6, 1);
        bytes memory sig = _signW(p, w);
        vm.expectRevert(GaslessForwarder.AmountMismatch.selector);
        fwd.withdraw(p, alice, w, sig);
    }

    function test_revert_withdraw_replay() public {
        GaslessForwarder.Withdraw memory w = _w(dest, 100e6, 2e6);
        IPermit2Witness.PermitTransferFrom memory p = _permit(102e6, 1);
        bytes memory sig = _signW(p, w);
        fwd.withdraw(p, alice, w, sig);
        vm.expectRevert();
        fwd.withdraw(p, alice, w, sig);
    }

    function test_revert_withdraw_expired() public {
        GaslessForwarder.Withdraw memory w = _w(dest, 100e6, 2e6);
        IPermit2Witness.PermitTransferFrom memory p = _permit(102e6, 1);
        bytes memory sig = _signW(p, w);
        vm.warp(p.deadline + 1);
        vm.expectRevert();
        fwd.withdraw(p, alice, w, sig);
    }

    function test_revert_withdraw_wrongSigner() public {
        GaslessForwarder.Withdraw memory w = _w(dest, 100e6, 2e6);
        IPermit2Witness.PermitTransferFrom memory p = _permit(102e6, 1);
        bytes memory sig = _sign(0xBAD, p, address(fwd), fwd.WITHDRAW_WITNESS_TYPE(), fwd.hashWithdraw(w));
        vm.expectRevert();
        fwd.withdraw(p, alice, w, sig);
    }

    /// @notice A signature made for another spender (e.g. the old Multicall3 flow) cannot be used here.
    function test_revert_withdraw_signatureForAnotherSpender() public {
        GaslessForwarder.Withdraw memory w = _w(dest, 100e6, 2e6);
        IPermit2Witness.PermitTransferFrom memory p = _permit(102e6, 1);
        bytes memory sig = _sign(aliceKey, p, MULTICALL3, fwd.WITHDRAW_WITNESS_TYPE(), fwd.hashWithdraw(w));
        vm.expectRevert();
        fwd.withdraw(p, alice, w, sig);
    }

    function test_withdraw_zeroFee() public {
        GaslessForwarder.Withdraw memory w = _w(dest, 5e6, 0);
        IPermit2Witness.PermitTransferFrom memory p = _permit(5e6, 9);
        fwd.withdraw(p, alice, w, _signW(p, w));
        assertEq(usdg.balanceOf(dest), 5e6);
        assertEq(usdg.balanceOf(relayer), 0);
    }

    function test_revert_withdraw_zeroDestination() public {
        GaslessForwarder.Withdraw memory w = _w(address(0), 5e6, 1);
        IPermit2Witness.PermitTransferFrom memory p = _permit(5e6 + 1, 9);
        bytes memory sig = _signW(p, w);
        vm.expectRevert(GaslessForwarder.ZeroAddress.selector);
        fwd.withdraw(p, alice, w, sig);
    }

    // ───────── action fee ─────────

    function _calls(uint256 n) internal view returns (GaslessForwarder.Call[] memory c) {
        c = new GaslessForwarder.Call[](1);
        c[0] = GaslessForwarder.Call({target: address(action), data: abi.encodeCall(MockAction.pull, (n))});
    }

    function _fee(GaslessForwarder.Call[] memory c, uint256 fee) internal view returns (GaslessForwarder.ActionFee memory) {
        return GaslessForwarder.ActionFee({fee: fee, feeTo: relayer, callsHash: keccak256(abi.encode(c))});
    }

    function _signF(IPermit2Witness.PermitTransferFrom memory p, GaslessForwarder.ActionFee memory f) internal view returns (bytes memory) {
        return _sign(aliceKey, p, address(fwd), fwd.ACTION_FEE_WITNESS_TYPE(), fwd.hashActionFee(f));
    }

    function test_action_paysFeeThenRunsCalls() public {
        GaslessForwarder.Call[] memory c = _calls(7);
        GaslessForwarder.ActionFee memory f = _fee(c, 1e6);
        IPermit2Witness.PermitTransferFrom memory p = _permit(1e6, 2);
        fwd.payFeeAndCall(p, alice, f, c, _signF(p, f));
        assertEq(usdg.balanceOf(relayer), 1e6);
        assertEq(action.pulled(), 7);
        assertEq(usdg.balanceOf(address(fwd)), 0);
        assertEq(fwd.hashCalls(c), f.callsHash, "hashCalls matches abi.encode(calls)");
    }

    function test_revert_action_feeSignatureReusedForOtherCalls() public {
        GaslessForwarder.Call[] memory c = _calls(7);
        GaslessForwarder.ActionFee memory f = _fee(c, 1e6);
        IPermit2Witness.PermitTransferFrom memory p = _permit(1e6, 2);
        bytes memory sig = _signF(p, f);
        vm.expectRevert(GaslessForwarder.CallsMismatch.selector);
        fwd.payFeeAndCall(p, alice, f, _calls(8), sig);
    }

    function test_revert_action_redirectedFee() public {
        GaslessForwarder.Call[] memory c = _calls(7);
        GaslessForwarder.ActionFee memory f = _fee(c, 1e6);
        IPermit2Witness.PermitTransferFrom memory p = _permit(1e6, 2);
        bytes memory sig = _signF(p, f);
        f.feeTo = mallory;
        vm.expectRevert();
        fwd.payFeeAndCall(p, alice, f, c, sig);
    }

    function test_revert_action_failedCallRevertsFee() public {
        GaslessForwarder.Call[] memory c = new GaslessForwarder.Call[](1);
        c[0] = GaslessForwarder.Call({target: address(action), data: abi.encodeCall(MockAction.boom, ())});
        GaslessForwarder.ActionFee memory f = _fee(c, 1e6);
        IPermit2Witness.PermitTransferFrom memory p = _permit(1e6, 2);
        bytes memory sig = _signF(p, f);
        vm.expectRevert(bytes("boom"));
        fwd.payFeeAndCall(p, alice, f, c, sig);
        assertEq(usdg.balanceOf(relayer), 0);
    }

    /// @notice Even a signed call cannot reach Permit2 through the forwarder (it would let the call spend another
    ///         player's signature that names the forwarder as spender).
    function test_revert_action_callToPermit2OrSelf() public {
        // bob signed a withdrawal; mallory signs her own fee for a call that tries to redeem bob's permit to herself
        GaslessForwarder.Call[] memory c = new GaslessForwarder.Call[](1);
        c[0] = GaslessForwarder.Call({target: PERMIT2, data: hex"deadbeef"});
        GaslessForwarder.ActionFee memory f = _fee(c, 1e6);
        IPermit2Witness.PermitTransferFrom memory p = _permit(1e6, 3);
        bytes memory sig = _signF(p, f);
        vm.expectRevert(abi.encodeWithSelector(GaslessForwarder.ForbiddenTarget.selector, PERMIT2));
        fwd.payFeeAndCall(p, alice, f, c, sig);

        c[0] = GaslessForwarder.Call({target: address(fwd), data: hex"deadbeef"});
        f = _fee(c, 1e6);
        p = _permit(1e6, 4);
        sig = _signF(p, f);
        vm.expectRevert(abi.encodeWithSelector(GaslessForwarder.ForbiddenTarget.selector, address(fwd)));
        fwd.payFeeAndCall(p, alice, f, c, sig);
    }

    // ───────── private launch ─────────

    function _launch(uint8 d) internal view returns (GaslessForwarder.AnonLaunch memory l) {
        l.p = ILaunchpad.LaunchParams({
            name: "Halo Runner",
            ticker: "HALO",
            imageURI: "ipfs://img",
            description: "to the moon",
            socialsURI: "",
            quote: address(usdg),
            creatorTaxBps: 100,
            creatorBuyQuoteIn: 10e6,
            creatorBuyMinTokensOut: 1,
            deadline: block.timestamp + 10 minutes
        });
        l.stealthOwner = address(0x57EA17);
        l.buyRecipient = address(0x57EA17);
        l.ephemeralPubKey = hex"02aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
        l.viewTag = 0x5a;
        l.maxFee = 5e6;
        l.usdgIn = 10e6;
        l.minQuoteIn = 1;
        l.refundTo = alice;
        l.launcher = address(launcher);
        l.creatorFeeDestination = d;
    }

    function _signL(IPermit2Witness.PermitTransferFrom memory p, GaslessForwarder.AnonLaunch memory l) internal view returns (bytes memory) {
        return _sign(aliceKey, p, address(fwd), fwd.ANON_LAUNCH_WITNESS_TYPE(), fwd.hashAnonLaunch(l));
    }

    function test_anon_launchesAndRefundsLeftoverToSignedRefundTo() public {
        launcher.setSpend(13e6, true);
        GaslessForwarder.AnonLaunch memory l = _launch(0);
        IPermit2Witness.PermitTransferFrom memory p = _permit(15e6, 5);
        GaslessForwarder.AnonLaunch memory l2 = l;
        ILaunchpad.LaunchResult memory r = fwd.launchAnon(p, alice, l2, _signL(p, l));
        assertEq(r.token, address(0x7070));
        assertEq(launcher.lastDest(), 0);
        assertEq(usdg.balanceOf(address(launcher)), 13e6);
        assertEq(usdg.balanceOf(alice), 1_000e6 - 13e6, "refund + dust back to the player");
        assertEq(usdg.balanceOf(address(fwd)), 0);
        assertEq(usdg.allowance(address(fwd), address(launcher)), 0, "approval cleared");
    }

    function test_anon_harvestDestination() public {
        launcher.setSpend(15e6, false);
        GaslessForwarder.AnonLaunch memory l = _launch(2);
        IPermit2Witness.PermitTransferFrom memory p = _permit(15e6, 6);
        fwd.launchAnon(p, alice, l, _signL(p, l));
        assertEq(launcher.lastDest(), 2);
    }

    function test_revert_anon_changedRefundLauncherOrDestination() public {
        GaslessForwarder.AnonLaunch memory l = _launch(0);
        IPermit2Witness.PermitTransferFrom memory p = _permit(15e6, 7);
        bytes memory sig = _signL(p, l);
        l.refundTo = mallory;
        vm.expectRevert();
        fwd.launchAnon(p, alice, l, sig);
        l = _launch(0);
        l.launcher = address(new MockLauncher(IERC20(address(usdg))));
        vm.expectRevert();
        fwd.launchAnon(p, alice, l, sig);
        l = _launch(1);
        vm.expectRevert();
        fwd.launchAnon(p, alice, l, sig);
        l = _launch(0);
        l.p.name = "Other";
        vm.expectRevert();
        fwd.launchAnon(p, alice, l, sig);
    }

    /// @notice Cross-check with the app (web/tests/gasless-forwarder.test.ts computes the same digest with viem).
    function test_anon_witnessVector() public view {
        GaslessForwarder.AnonLaunch memory l;
        l.p = ILaunchpad.LaunchParams({
            name: "Halo Runner",
            ticker: "HALO",
            imageURI: "ipfs://img",
            description: "to the moon",
            socialsURI: "",
            quote: address(0x1111111111111111111111111111111111111111),
            creatorTaxBps: 100,
            creatorBuyQuoteIn: 10e6,
            creatorBuyMinTokensOut: 1,
            deadline: 1_800_000_000
        });
        l.stealthOwner = address(0x2222222222222222222222222222222222222222);
        l.buyRecipient = address(0x3333333333333333333333333333333333333333);
        l.ephemeralPubKey = hex"02aabbcc";
        l.viewTag = 0x5a;
        l.maxFee = 5e6;
        l.usdgIn = 10e6;
        l.minQuoteIn = 1;
        l.refundTo = address(0x4444444444444444444444444444444444444444);
        l.launcher = address(0x5555555555555555555555555555555555555555);
        l.creatorFeeDestination = 1;
        assertEq(fwd.hashAnonLaunch(l), 0xc2b015644abfc80c1f8e371463b2a85316074d72eb8b710ac8f9f8e44a4da7b2, "same as anonLaunchWitnessHash in the app");
    }

    /// @notice Same vector as web/tests/gasless-forwarder.test.ts (viem encodeAbiParameters of tuple[]).
    function test_callsHashVector() public view {
        GaslessForwarder.Call[] memory c = new GaslessForwarder.Call[](2);
        c[0] = GaslessForwarder.Call({target: address(0x6666666666666666666666666666666666666666), data: hex"deadbeef"});
        c[1] = GaslessForwarder.Call({target: address(0x7777777777777777777777777777777777777777), data: ""});
        assertEq(fwd.hashCalls(c), 0x07802ca57152fb6f0eee85843f0cf19f36dc4973e7086db14ab50fad49fd57d0);
    }
}
