// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./IntegrationBase.sol";
import {AnonLauncher} from "../../src/addons/AnonLauncher.sol";
import {GaslessForwarder} from "../../src/addons/GaslessForwarder.sol";
import {IPermit2Witness} from "../../src/DiscipleRouter.sol";
import {Permit2Code} from "../helpers/Permit2Code.sol";

/// @notice Gasless private launch and USDG withdraw where the protocol contract is the Permit2 spender and the
///         witness binds every recipient (UniswapX / 0x Settler / DiscipleRouter.buyWithPermit2 pattern).
contract GaslessForwarderTest is IntegrationBase {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    string constant STUB =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";
    uint256 constant FEE = 0.5 ether;

    AnonLauncher internal anon;
    GaslessForwarder internal fwd;
    uint256 internal aliceKey = 0xA11CE;
    address internal alice;
    address internal relayer = makeAddr("relayer");
    address internal mallory = makeAddr("mallory");
    address internal stealth = makeAddr("stealth");

    function setUp() public override {
        super.setUp();
        alice = vm.addr(aliceKey);
        vm.etch(PERMIT2, Permit2Code.RUNTIME);
        anon = new AnonLauncher(owner, address(launchpad), address(feeRouter), address(quote), treasury, address(0), FEE);
        feeVault = new CurveFeeVault(address(feeRouter), address(anon));
        address d = address(new CurveDeployer(address(feeVault)));
        vm.prank(owner);
        launchpad.setCurveDeployer(d);
        router.setUsdgRouting(address(quote), address(launchpad));
        router.setUsdgPool(address(strategy), strategyUsdgKey);
        fwd = new GaslessForwarder(address(anon));
        quote.mint(alice, 1_000_000 ether);
        vm.prank(alice);
        quote.approve(PERMIT2, type(uint256).max);
    }

    // ───────── signing helpers (what a wallet / viem signs) ─────────

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

    function _permit(uint256 amount, uint256 nonce) internal view returns (IPermit2Witness.PermitTransferFrom memory p) {
        p.permitted = IPermit2Witness.TokenPermissions({token: address(quote), amount: amount});
        p.nonce = nonce;
        p.deadline = block.timestamp + 5 minutes;
    }

    function _sign(IPermit2Witness.PermitTransferFrom memory p, address spender, string memory witnessType, bytes32 w)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(abi.encodePacked(STUB, witnessType)),
                keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, p.permitted.token, p.permitted.amount)),
                spender,
                p.nonce,
                p.deadline,
                w
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, keccak256(abi.encodePacked("\x19\x01", _domain(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _noApproval() internal pure returns (GaslessForwarder.Erc2612 memory a) {}

    function _launch(uint256 usdgIn) internal view returns (GaslessForwarder.AnonLaunch memory l) {
        l = GaslessForwarder.AnonLaunch({
            name: "Anon",
            ticker: "ANON",
            imageURI: "ipfs://x",
            description: "",
            socialsURI: "",
            quote: address(quote),
            creatorTaxBps: 0,
            creatorBuyQuoteIn: 0,
            creatorBuyMinTokensOut: 1,
            deadline: block.timestamp + 1 hours,
            stealthOwner: stealth,
            buyRecipient: stealth,
            ephemeralPubKey: "",
            viewTag: 0x00,
            maxFee: FEE,
            usdgIn: usdgIn,
            minQuoteIn: 1,
            refundTo: alice,
            launcher: address(anon)
        });
    }

    // ───────── EIP-712 encoding matches what viem signs ─────────

    /// @dev Reference values from viem 2.x encodeType / hashStruct for the same types and sample data.
    function test_typeStrings_matchViem() public view {
        assertEq(
            keccak256(abi.encodePacked(STUB, fwd.ANON_LAUNCH_WITNESS_TYPE())),
            0x9b790f53ed01882f534a69a4a77fb2f1d44c7e3514e4afbacaa5c48dd02c77de
        );
        assertEq(
            keccak256(abi.encodePacked(STUB, fwd.WITHDRAW_WITNESS_TYPE())),
            0x945e134c2a9fefcb069758d9234d06fdf2ef7d5af9617d6fcb274e19d92de975
        );
        GaslessForwarder.AnonLaunch memory l = GaslessForwarder.AnonLaunch({
            name: "Anon",
            ticker: "ANON",
            imageURI: "ipfs://x",
            description: "d",
            socialsURI: "s",
            quote: 0x1111111111111111111111111111111111111111,
            creatorTaxBps: 0,
            creatorBuyQuoteIn: 0,
            creatorBuyMinTokensOut: 1,
            deadline: 1000,
            stealthOwner: 0x2222222222222222222222222222222222222222,
            buyRecipient: 0x3333333333333333333333333333333333333333,
            ephemeralPubKey: hex"abcd",
            viewTag: 0x07,
            maxFee: 500000,
            usdgIn: 10000000,
            minQuoteIn: 1,
            refundTo: 0x4444444444444444444444444444444444444444,
            launcher: 0x5555555555555555555555555555555555555555
        });
        assertEq(fwd.anonLaunchWitnessHash(l), 0xb39ca315179d97e94ecc2bb9e6743423ae8fa489745006d311f29a5f78be47f8);
        GaslessForwarder.Withdraw memory w = GaslessForwarder.Withdraw({
            to: 0x6666666666666666666666666666666666666666,
            fee: 123,
            feeTo: 0x7777777777777777777777777777777777777777
        });
        assertEq(fwd.withdrawWitnessHash(w), 0xb1e7b9296d5945f569ac0c347500ad10e9de290b7f1cf395681810e9b1dbf738);
    }

    // ───────── private launch ─────────

    function test_launch_relayerSubmits_leftoverGoesToSigner_nothingStaysOnForwarder() public {
        GaslessForwarder.AnonLaunch memory l = _launch(10 ether);
        IPermit2Witness.PermitTransferFrom memory p = _permit(FEE + 10 ether, 1);
        bytes memory sig = _sign(p, address(fwd), fwd.ANON_LAUNCH_WITNESS_TYPE(), fwd.anonLaunchWitnessHash(l));
        uint256 a0 = quote.balanceOf(alice);
        uint256 t0 = quote.balanceOf(treasury);
        vm.prank(relayer);
        (ILaunchpad.LaunchResult memory r,) = fwd.launchAnon(alice, p, l, sig, _noApproval());
        assertEq(anon.stealthOwnerOf(r.token), stealth);
        assertEq(launchpad.creatorOf(r.token), address(anon), "AnonLauncher stays the on-chain creator");
        assertGt(IERC20(r.token).balanceOf(stealth), 0, "First BOOST coins to the signed recipient");
        assertEq(quote.balanceOf(treasury) - t0, FEE);
        assertLe(a0 - quote.balanceOf(alice), FEE + 10 ether);
        assertEq(quote.balanceOf(address(fwd)), 0, "forwarder holds nothing");
        assertEq(quote.balanceOf(address(anon)), 0, "launcher holds nothing");
        assertEq(quote.allowance(address(fwd), address(anon)), 0);
        assertEq(quote.balanceOf(relayer), 0, "relayer gets nothing");
    }

    function test_launch_feeBelowMax_differenceRefundedToSigner() public {
        vm.prank(owner);
        anon.setLaunchFee(0.2 ether);
        GaslessForwarder.AnonLaunch memory l = _launch(0);
        IPermit2Witness.PermitTransferFrom memory p = _permit(FEE, 2);
        bytes memory sig = _sign(p, address(fwd), fwd.ANON_LAUNCH_WITNESS_TYPE(), fwd.anonLaunchWitnessHash(l));
        uint256 a0 = quote.balanceOf(alice);
        vm.prank(relayer);
        (, uint256 refund) = fwd.launchAnon(alice, p, l, sig, _noApproval());
        assertEq(refund, 0.3 ether);
        assertEq(a0 - quote.balanceOf(alice), 0.2 ether);
        assertEq(quote.balanceOf(address(fwd)), 0);
    }

    function test_launch_thirdPartyCannotRedirectOrReplay() public {
        GaslessForwarder.AnonLaunch memory l = _launch(10 ether);
        IPermit2Witness.PermitTransferFrom memory p = _permit(FEE + 10 ether, 3);
        bytes memory sig = _sign(p, address(fwd), fwd.ANON_LAUNCH_WITNESS_TYPE(), fwd.anonLaunchWitnessHash(l));

        // Mallory swaps in herself as the leftover / coin recipient: the witness no longer matches.
        GaslessForwarder.AnonLaunch memory evil = _launch(10 ether);
        evil.refundTo = mallory;
        vm.prank(mallory);
        vm.expectRevert();
        fwd.launchAnon(alice, p, evil, sig, _noApproval());
        evil = _launch(10 ether);
        evil.buyRecipient = mallory;
        vm.prank(mallory);
        vm.expectRevert();
        fwd.launchAnon(alice, p, evil, sig, _noApproval());

        // Mallory calls Permit2 herself, as the old public Multicall3 spender allowed: she is not the spender.
        bytes32 wh = fwd.anonLaunchWitnessHash(l);
        string memory wt = fwd.ANON_LAUNCH_WITNESS_TYPE();
        vm.prank(mallory);
        vm.expectRevert();
        IPermit2Witness(PERMIT2).permitWitnessTransferFrom(
            p, IPermit2Witness.SignatureTransferDetails({to: mallory, requestedAmount: FEE + 10 ether}), alice, wh, wt, sig
        );

        // The honest submission works once; the same signature cannot be used again.
        vm.prank(mallory);
        fwd.launchAnon(alice, p, l, sig, _noApproval());
        assertEq(quote.balanceOf(mallory), 0, "submitter gets nothing");
        vm.prank(mallory);
        vm.expectRevert();
        fwd.launchAnon(alice, p, l, sig, _noApproval());
    }

    function test_launch_rejectsOtherLauncherAndWrongAmount() public {
        GaslessForwarder.AnonLaunch memory l = _launch(10 ether);
        l.launcher = mallory;
        IPermit2Witness.PermitTransferFrom memory p = _permit(FEE + 10 ether, 4);
        bytes memory sig = _sign(p, address(fwd), fwd.ANON_LAUNCH_WITNESS_TYPE(), fwd.anonLaunchWitnessHash(l));
        vm.expectRevert(GaslessForwarder.BadLauncher.selector);
        fwd.launchAnon(alice, p, l, sig, _noApproval());
        l = _launch(10 ether);
        p = _permit(FEE + 1 ether, 4);
        vm.expectRevert(GaslessForwarder.BadPermit.selector);
        fwd.launchAnon(alice, p, l, sig, _noApproval());
    }

    // ───────── withdraw ─────────

    function test_withdraw_recipientAndFeeBound() public {
        GaslessForwarder.Withdraw memory w = GaslessForwarder.Withdraw({to: stealth, fee: 0.01 ether, feeTo: relayer});
        IPermit2Witness.PermitTransferFrom memory p = _permit(5 ether, 10);
        bytes memory sig = _sign(p, address(fwd), fwd.WITHDRAW_WITNESS_TYPE(), fwd.withdrawWitnessHash(w));

        GaslessForwarder.Withdraw memory evil = GaslessForwarder.Withdraw({to: mallory, fee: 0.01 ether, feeTo: relayer});
        vm.prank(mallory);
        vm.expectRevert();
        fwd.withdraw(alice, p, evil, sig, _noApproval());
        evil = GaslessForwarder.Withdraw({to: stealth, fee: 0.01 ether, feeTo: mallory});
        vm.prank(mallory);
        vm.expectRevert();
        fwd.withdraw(alice, p, evil, sig, _noApproval());
        evil = GaslessForwarder.Withdraw({to: stealth, fee: 1 ether, feeTo: relayer});
        vm.prank(mallory);
        vm.expectRevert();
        fwd.withdraw(alice, p, evil, sig, _noApproval());

        uint256 a0 = quote.balanceOf(alice);
        vm.prank(mallory); // any submitter: the outcome is exactly what alice signed
        fwd.withdraw(alice, p, w, sig, _noApproval());
        assertEq(a0 - quote.balanceOf(alice), 5 ether);
        assertEq(quote.balanceOf(stealth), 5 ether - 0.01 ether);
        assertEq(quote.balanceOf(relayer), 0.01 ether);
        assertEq(quote.balanceOf(mallory), 0);
        assertEq(quote.balanceOf(address(fwd)), 0);

        vm.expectRevert();
        fwd.withdraw(alice, p, w, sig, _noApproval());
    }

    function test_withdraw_rejectsBadInputs() public {
        GaslessForwarder.Withdraw memory w = GaslessForwarder.Withdraw({to: address(0), fee: 0, feeTo: address(0)});
        IPermit2Witness.PermitTransferFrom memory p = _permit(5 ether, 11);
        vm.expectRevert(GaslessForwarder.BadRecipient.selector);
        fwd.withdraw(alice, p, w, "", _noApproval());
        w = GaslessForwarder.Withdraw({to: stealth, fee: 5 ether, feeTo: relayer});
        vm.expectRevert(GaslessForwarder.FeeTooHigh.selector);
        fwd.withdraw(alice, p, w, "", _noApproval());
        w = GaslessForwarder.Withdraw({to: stealth, fee: 1, feeTo: address(0)});
        vm.expectRevert(GaslessForwarder.BadRecipient.selector);
        fwd.withdraw(alice, p, w, "", _noApproval());
    }
}
