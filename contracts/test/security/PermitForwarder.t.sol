// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {DisciplePermitForwarder, IPermit2SignatureTransfer} from "../../src/addons/DisciplePermitForwarder.sol";
import {Permit2Code} from "../helpers/Permit2Code.sol";

contract USDG is ERC20Permit {
    constructor() ERC20("USDG", "USDG") ERC20Permit("USDG") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// Pays its caller a cut (like CurveFeeVault's relayerFeeBps / TrampWallManager's keeper tip) and records the call.
contract TipTarget {
    IERC20 public immutable tok;
    uint256 public hits;

    constructor(IERC20 t) {
        tok = t;
    }

    function claim(uint256 tip) external {
        hits++;
        if (tip > 0) tok.transfer(msg.sender, tip);
    }

    function boom() external pure {
        revert("nope");
    }
}

/// AnonLauncher-shaped: pulls fee + usdgIn from the caller, keeps the fee, refunds `refundPart` of usdgIn to refundTo.
contract MockLauncher {
    IERC20 public immutable tok;
    uint256 public fee;
    uint256 public refundPart;
    address public lastRefundTo;
    string public lastName;
    uint8 public lastDest;

    constructor(IERC20 t, uint256 f) {
        tok = t;
        fee = f;
    }

    function setRefund(uint256 r) external {
        refundPart = r;
    }

    function _run(ILaunchpad.LaunchParams calldata p, uint256 maxFee, uint256 usdgIn, address refundTo)
        internal
        returns (ILaunchpad.LaunchResult memory r, uint256 refunded)
    {
        require(fee <= maxFee, "fee");
        tok.transferFrom(msg.sender, address(this), fee + usdgIn);
        if (refundPart > 0) tok.transfer(refundTo, refundPart);
        lastRefundTo = refundTo;
        lastName = p.name;
        r = ILaunchpad.LaunchResult({token: address(0xC01), curve: address(0xC0FE), creatorTokensBought: 1});
        refunded = refundPart;
    }

    function launchAnonWithUsdg(
        ILaunchpad.LaunchParams calldata p,
        address,
        address,
        bytes calldata,
        bytes1,
        uint256 maxFee,
        uint256 usdgIn,
        uint256,
        address refundTo
    ) external returns (ILaunchpad.LaunchResult memory r, uint256 usdgRefund) {
        lastDest = 0;
        return _run(p, maxFee, usdgIn, refundTo);
    }

    function launchAnonWithUsdg(
        ILaunchpad.LaunchParams calldata p,
        address,
        address,
        bytes calldata,
        bytes1,
        uint256 maxFee,
        uint256 usdgIn,
        uint256,
        address refundTo,
        uint8 dest
    ) external returns (ILaunchpad.LaunchResult memory r, uint256 usdgRefund) {
        lastDest = dest;
        return _run(p, maxFee, usdgIn, refundTo);
    }
}

/// @notice DisciplePermitForwarder against the canonical Permit2 runtime (etched, as DiscipleRouterPermit2.t.sol does).
///         The point of the contract: a signature can only do what the player signed, whoever submits it.
contract PermitForwarderTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 constant EIP2612_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    DisciplePermitForwarder fwd;
    USDG usdg;
    TipTarget target;
    MockLauncher launcher;
    uint256 aliceKey = 0xA11CE;
    address alice;
    address bob = makeAddr("bob");
    address relayer = makeAddr("relayer");
    address mallory = makeAddr("mallory");

    function setUp() public {
        vm.etch(PERMIT2, Permit2Code.RUNTIME);
        alice = vm.addr(aliceKey);
        fwd = new DisciplePermitForwarder();
        usdg = new USDG();
        target = new TipTarget(usdg);
        launcher = new MockLauncher(usdg, 2e18);
        usdg.mint(alice, 1_000e18);
        usdg.mint(address(target), 100e18);
        vm.prank(alice);
        usdg.approve(PERMIT2, type(uint256).max);
    }

    // ───────── helpers ─────────

    function _domain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                keccak256("Permit2"),
                block.chainid,
                PERMIT2
            )
        );
    }

    function _permit(uint256 amount, uint256 nonce) internal view returns (IPermit2SignatureTransfer.PermitTransferFrom memory p) {
        p.permitted = IPermit2SignatureTransfer.TokenPermissions({token: address(usdg), amount: amount});
        p.nonce = nonce;
        p.deadline = block.timestamp + 10 minutes;
    }

    function _sign(IPermit2SignatureTransfer.PermitTransferFrom memory p, string memory witnessType, bytes32 witness, address spender)
        internal
        view
        returns (bytes memory)
    {
        bytes32 typeHash = keccak256(
            abi.encodePacked("PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,", witnessType)
        );
        bytes32 sh = keccak256(
            abi.encode(
                typeHash,
                keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, p.permitted.token, p.permitted.amount)),
                spender,
                p.nonce,
                p.deadline,
                witness
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, keccak256(abi.encodePacked("\x19\x01", _domain(), sh)));
        return abi.encodePacked(r, s, v);
    }

    function _noApproval() internal pure returns (DisciplePermitForwarder.Approval memory a) {}

    function _withdraw(address to, uint256 fee) internal pure returns (DisciplePermitForwarder.Withdraw memory w) {
        w = DisciplePermitForwarder.Withdraw({to: to, fee: fee, feeTo: address(0xFEE)});
    }

    function _signWithdraw(IPermit2SignatureTransfer.PermitTransferFrom memory p, DisciplePermitForwarder.Withdraw memory w)
        internal
        view
        returns (bytes memory)
    {
        return _sign(p, fwd.WITHDRAW_WITNESS_TYPE(), fwd.hashWithdraw(w), address(fwd));
    }

    function _calls(uint256 tip) internal view returns (DisciplePermitForwarder.Call[] memory c) {
        c = new DisciplePermitForwarder.Call[](1);
        c[0] = DisciplePermitForwarder.Call({target: address(target), data: abi.encodeCall(TipTarget.claim, (tip))});
    }

    function _launch() internal view returns (DisciplePermitForwarder.AnonLaunch memory l) {
        l.name = "Halo Runner";
        l.ticker = "HALO";
        l.imageURI = "ipfs://img";
        l.description = "d";
        l.socialsURI = "";
        l.quote = address(0xBEEF);
        l.deadline = block.timestamp + 10 minutes;
        l.stealthOwner = address(0x5EA1);
        l.buyRecipient = address(0x5EA1);
        l.ephemeralPubKey = hex"02aabbcc";
        l.viewTag = bytes1(0x7f);
        l.maxFee = 3e18;
        l.usdgIn = 10e18;
        l.refundTo = alice;
        l.launcher = address(launcher);
    }

    // ───────── withdraw ─────────

    function test_withdraw_paysExactlyWhatWasSigned() public {
        IPermit2SignatureTransfer.PermitTransferFrom memory p = _permit(50e18, 1);
        DisciplePermitForwarder.Withdraw memory w = _withdraw(bob, 1e18);
        bytes memory sig = _signWithdraw(p, w);
        vm.prank(relayer);
        fwd.withdraw(p, w, alice, sig, _noApproval());
        assertEq(usdg.balanceOf(bob), 49e18, "net to destination");
        assertEq(usdg.balanceOf(address(0xFEE)), 1e18, "fee to fee recipient");
        assertEq(usdg.balanceOf(alice), 950e18);
        assertEq(usdg.balanceOf(address(fwd)), 0, "forwarder holds nothing");
    }

    /// The Vercel finding: an observer with an unused signature redirects it. Every variant reverts.
    function test_withdraw_observerCannotRedirect() public {
        IPermit2SignatureTransfer.PermitTransferFrom memory p = _permit(50e18, 2);
        DisciplePermitForwarder.Withdraw memory w = _withdraw(bob, 1e18);
        bytes memory sig = _signWithdraw(p, w);

        vm.startPrank(mallory);
        vm.expectRevert(); // destination changed
        fwd.withdraw(p, _withdraw(mallory, 1e18), alice, sig, _noApproval());
        DisciplePermitForwarder.Withdraw memory feeSwap = DisciplePermitForwarder.Withdraw({to: bob, fee: 1e18, feeTo: mallory});
        vm.expectRevert(); // fee recipient changed
        fwd.withdraw(p, feeSwap, alice, sig, _noApproval());
        vm.expectRevert(); // fee raised
        fwd.withdraw(p, _withdraw(bob, 40e18), alice, sig, _noApproval());
        IPermit2SignatureTransfer.PermitTransferFrom memory more = _permit(60e18, 2);
        vm.expectRevert(); // amount raised
        fwd.withdraw(more, w, alice, sig, _noApproval());
        // straight to Permit2 with mallory as recipient: the spender in the signature is the forwarder, not mallory
        bytes32 wh = fwd.hashWithdraw(w);
        string memory wt = fwd.WITHDRAW_WITNESS_TYPE();
        vm.expectRevert();
        IPermit2SignatureTransfer(PERMIT2).permitWitnessTransferFrom(
            p, IPermit2SignatureTransfer.SignatureTransferDetails({to: mallory, requestedAmount: 50e18}), alice, wh, wt, sig
        );
        // through the forwarder's action path (a relayed call to Permit2 is refused, and the witness type differs anyway)
        DisciplePermitForwarder.Call[] memory steal = new DisciplePermitForwarder.Call[](1);
        steal[0] = DisciplePermitForwarder.Call({
            target: PERMIT2,
            data: abi.encodeCall(
                IPermit2SignatureTransfer.permitWitnessTransferFrom,
                (p, IPermit2SignatureTransfer.SignatureTransferDetails({to: mallory, requestedAmount: 50e18}), alice, wh, wt, sig)
            )
        });
        vm.expectRevert();
        fwd.action(_permit(0, 99), DisciplePermitForwarder.Action({feeTo: mallory, callsHash: keccak256(abi.encode(steal))}), steal, mallory, "", _noApproval(), new address[](0));
        vm.stopPrank();

        assertEq(usdg.balanceOf(mallory), 0);
        // the real submission still works afterwards (nonce unused), whoever sends it
        vm.prank(mallory);
        fwd.withdraw(p, w, alice, sig, _noApproval());
        assertEq(usdg.balanceOf(bob), 49e18);
        assertEq(usdg.balanceOf(mallory), 0);
    }

    function test_withdraw_replayAndExpiry() public {
        IPermit2SignatureTransfer.PermitTransferFrom memory p = _permit(10e18, 3);
        DisciplePermitForwarder.Withdraw memory w = _withdraw(bob, 0);
        bytes memory sig = _signWithdraw(p, w);
        fwd.withdraw(p, w, alice, sig, _noApproval());
        vm.expectRevert(); // nonce used
        fwd.withdraw(p, w, alice, sig, _noApproval());

        IPermit2SignatureTransfer.PermitTransferFrom memory q = _permit(10e18, 4);
        bytes memory sig2 = _signWithdraw(q, w);
        vm.warp(q.deadline + 1);
        vm.expectRevert(); // expired
        fwd.withdraw(q, w, alice, sig2, _noApproval());
    }

    function test_withdraw_rejectsBadShape() public {
        IPermit2SignatureTransfer.PermitTransferFrom memory p = _permit(10e18, 5);
        DisciplePermitForwarder.Withdraw memory w = _withdraw(address(0), 0);
        bytes memory s1 = _signWithdraw(p, w);
        vm.expectRevert(DisciplePermitForwarder.ZeroAddress.selector);
        fwd.withdraw(p, w, alice, s1, _noApproval());
        DisciplePermitForwarder.Withdraw memory big = _withdraw(bob, 11e18);
        bytes memory s2 = _signWithdraw(p, big);
        vm.expectRevert(DisciplePermitForwarder.FeeTooHigh.selector);
        fwd.withdraw(p, big, alice, s2, _noApproval());
    }

    function test_withdraw_withOneTimeErc2612Approval() public {
        uint256 k = 0xB0B0;
        address carol = vm.addr(k);
        usdg.mint(carol, 20e18);
        DisciplePermitForwarder.Approval memory a;
        a.value = type(uint256).max;
        a.deadline = block.timestamp + 1 hours;
        bytes32 sh = keccak256(abi.encode(EIP2612_TYPEHASH, carol, PERMIT2, a.value, usdg.nonces(carol), a.deadline));
        (a.v, a.r, a.s) = vm.sign(k, keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), sh)));

        IPermit2SignatureTransfer.PermitTransferFrom memory p = _permit(20e18, 1);
        DisciplePermitForwarder.Withdraw memory w = _withdraw(bob, 1e18);
        bytes32 typeHash = keccak256(
            abi.encodePacked("PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,", fwd.WITHDRAW_WITNESS_TYPE())
        );
        bytes32 psh = keccak256(
            abi.encode(typeHash, keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, address(usdg), uint256(20e18))), address(fwd), uint256(1), p.deadline, fwd.hashWithdraw(w))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, keccak256(abi.encodePacked("\x19\x01", _domain(), psh)));
        // someone front-runs the EIP-2612 permit: the forwarder's try/catch still lets the withdrawal through
        usdg.permit(carol, PERMIT2, a.value, a.deadline, a.v, a.r, a.s);
        fwd.withdraw(p, w, carol, abi.encodePacked(r, s, v), a);
        assertEq(usdg.balanceOf(bob), 19e18);
    }

    // ───────── action ─────────

    function test_action_paysFeeRunsCallsSweepsTips() public {
        DisciplePermitForwarder.Call[] memory c = _calls(3e18);
        DisciplePermitForwarder.Action memory a = DisciplePermitForwarder.Action({feeTo: relayer, callsHash: keccak256(abi.encode(c))});
        IPermit2SignatureTransfer.PermitTransferFrom memory p = _permit(1e18, 10);
        bytes memory sig = _sign(p, fwd.ACTION_WITNESS_TYPE(), fwd.hashAction(a), address(fwd));
        address[] memory sweep = new address[](1);
        sweep[0] = address(usdg);
        vm.prank(relayer);
        fwd.action(p, a, c, alice, sig, _noApproval(), sweep);
        assertEq(target.hits(), 1, "call ran");
        assertEq(usdg.balanceOf(relayer), 4e18, "fee + the call's caller tip, swept to the signed fee recipient");
        assertEq(usdg.balanceOf(address(fwd)), 0, "nothing left on the forwarder");
    }

    function test_action_callsAndFeeAreBound() public {
        DisciplePermitForwarder.Call[] memory c = _calls(0);
        DisciplePermitForwarder.Action memory a = DisciplePermitForwarder.Action({feeTo: relayer, callsHash: keccak256(abi.encode(c))});
        IPermit2SignatureTransfer.PermitTransferFrom memory p = _permit(1e18, 11);
        bytes memory sig = _sign(p, fwd.ACTION_WITNESS_TYPE(), fwd.hashAction(a), address(fwd));

        vm.startPrank(mallory);
        vm.expectRevert(DisciplePermitForwarder.CallsMismatch.selector); // different calls than signed
        fwd.action(p, a, _calls(5e18), alice, sig, _noApproval(), new address[](0));
        DisciplePermitForwarder.Action memory swapped = DisciplePermitForwarder.Action({feeTo: mallory, callsHash: a.callsHash});
        vm.expectRevert(); // fee redirected
        fwd.action(p, swapped, c, alice, sig, _noApproval(), new address[](0));
        vm.stopPrank();

        // a failing call reverts everything: the fee is not taken
        DisciplePermitForwarder.Call[] memory bad = new DisciplePermitForwarder.Call[](1);
        bad[0] = DisciplePermitForwarder.Call({target: address(target), data: abi.encodeCall(TipTarget.boom, ())});
        DisciplePermitForwarder.Action memory ab = DisciplePermitForwarder.Action({feeTo: relayer, callsHash: keccak256(abi.encode(bad))});
        IPermit2SignatureTransfer.PermitTransferFrom memory pb = _permit(1e18, 12);
        bytes memory sb = _sign(pb, fwd.ACTION_WITNESS_TYPE(), fwd.hashAction(ab), address(fwd));
        uint256 before = usdg.balanceOf(alice);
        vm.expectRevert();
        fwd.action(pb, ab, bad, alice, sb, _noApproval(), new address[](0));
        assertEq(usdg.balanceOf(alice), before);
    }

    function test_action_forbiddenTargets() public {
        address[3] memory forbidden = [PERMIT2, address(fwd), address(usdg)];
        for (uint256 i; i < forbidden.length; ++i) {
            DisciplePermitForwarder.Call[] memory c = new DisciplePermitForwarder.Call[](1);
            c[0] = DisciplePermitForwarder.Call({target: forbidden[i], data: hex"00"});
            DisciplePermitForwarder.Action memory a = DisciplePermitForwarder.Action({feeTo: relayer, callsHash: keccak256(abi.encode(c))});
            IPermit2SignatureTransfer.PermitTransferFrom memory p = _permit(0, 20 + i);
            bytes memory sig = _sign(p, fwd.ACTION_WITNESS_TYPE(), fwd.hashAction(a), address(fwd));
            vm.expectRevert(abi.encodeWithSelector(DisciplePermitForwarder.ForbiddenTarget.selector, forbidden[i]));
            fwd.action(p, a, c, alice, sig, _noApproval(), new address[](0));
        }
    }

    // ───────── private launch ─────────

    function test_launch_runsSignedLaunchAndRefundsLeftover() public {
        launcher.setRefund(4e18);
        DisciplePermitForwarder.AnonLaunch memory l = _launch();
        IPermit2SignatureTransfer.PermitTransferFrom memory p = _permit(13e18, 30);
        bytes memory sig = _sign(p, fwd.ANON_LAUNCH_WITNESS_TYPE(), fwd.hashAnonLaunch(l), address(fwd));
        uint256 a0 = usdg.balanceOf(alice);
        vm.prank(relayer);
        ILaunchpad.LaunchResult memory r = fwd.launchAnon(p, l, alice, sig, _noApproval());
        assertEq(r.curve, address(0xC0FE));
        assertEq(launcher.lastName(), "Halo Runner");
        // pulled 13 (3 max fee + 10 boost); launcher took 2 fee + 10 boost and refunded 4 to the player; the unused 1 of the
        // fee margin comes back from the forwarder
        assertEq(a0 - usdg.balanceOf(alice), 13e18 - 4e18 - 1e18);
        assertEq(usdg.balanceOf(address(fwd)), 0, "no leftover on the forwarder");
        assertEq(usdg.allowance(address(fwd), address(launcher)), 0, "allowance cleared");
        assertEq(launcher.lastRefundTo(), alice);
    }

    function test_launch_fieldsAreBound() public {
        DisciplePermitForwarder.AnonLaunch memory l = _launch();
        IPermit2SignatureTransfer.PermitTransferFrom memory p = _permit(13e18, 31);
        bytes memory sig = _sign(p, fwd.ANON_LAUNCH_WITNESS_TYPE(), fwd.hashAnonLaunch(l), address(fwd));
        vm.startPrank(mallory);
        DisciplePermitForwarder.AnonLaunch memory m = _launch();
        m.refundTo = mallory;
        vm.expectRevert();
        fwd.launchAnon(p, m, alice, sig, _noApproval());
        m = _launch();
        m.stealthOwner = mallory;
        vm.expectRevert();
        fwd.launchAnon(p, m, alice, sig, _noApproval());
        m = _launch();
        m.name = "Mallory Coin";
        vm.expectRevert();
        fwd.launchAnon(p, m, alice, sig, _noApproval());
        m = _launch();
        m.usdgIn = 11e18;
        vm.expectRevert(DisciplePermitForwarder.AmountMismatch.selector);
        fwd.launchAnon(p, m, alice, sig, _noApproval());
        vm.stopPrank();
        assertEq(usdg.balanceOf(mallory), 0);
    }

    function test_launch_destinationRoutesToHarvestShape() public {
        DisciplePermitForwarder.AnonLaunch memory l = _launch();
        l.creatorFeeDestination = 2;
        IPermit2SignatureTransfer.PermitTransferFrom memory p = _permit(13e18, 32);
        bytes memory sig = _sign(p, fwd.ANON_LAUNCH_WITNESS_TYPE(), fwd.hashAnonLaunch(l), address(fwd));
        fwd.launchAnon(p, l, alice, sig, _noApproval());
        assertEq(launcher.lastDest(), 2);
        l.creatorFeeDestination = 3;
        vm.expectRevert(DisciplePermitForwarder.BadDestination.selector);
        fwd.launchAnon(p, l, alice, sig, _noApproval());
    }

    // ───────── cross-check with the site's hashing (web/tests/gasless-forwarder.test.ts pins the same vectors, computed with viem's EIP-712 hashStruct) ─────────

    function test_vectors() public view {
        DisciplePermitForwarder.Withdraw memory w = DisciplePermitForwarder.Withdraw({to: address(0xB0B), fee: 1234, feeTo: address(0xFEE)});
        DisciplePermitForwarder.Action memory a = DisciplePermitForwarder.Action({feeTo: address(0xFEE), callsHash: keccak256("calls")});
        DisciplePermitForwarder.AnonLaunch memory l;
        l.name = "Halo Runner";
        l.ticker = "HALO";
        l.imageURI = "ipfs://img";
        l.description = "d";
        l.quote = address(0xBEEF);
        l.deadline = 1_800_000_000;
        l.stealthOwner = address(0x5EA1);
        l.buyRecipient = address(0x5EA1);
        l.ephemeralPubKey = hex"02aabbcc";
        l.viewTag = bytes1(0x7f);
        l.maxFee = 3e18;
        l.usdgIn = 10e18;
        l.refundTo = address(0xA11CE);
        l.launcher = address(0x1A);
        l.creatorFeeDestination = 1;
        assertEq(fwd.hashWithdraw(w), 0x829688fa6c53b8799d518d5fa5a010a449c5d40c270731786c9476b5c2db51b9, "withdraw vector");
        assertEq(fwd.hashAction(a), 0x42fa0f62b3b00c3cd402c82344fbc9743ba26d6af606d9e6903eb14e61b42af7, "action vector");
        assertEq(fwd.hashAnonLaunch(l), 0x25405878d7714c648e45726cd0ce0c377ef27708c8fa3609d5cb3ac37028ce23, "launch vector");
    }
}
