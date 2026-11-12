// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IntegrationBase} from "./IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DiscipleRouter, IPermit2Witness} from "../../src/DiscipleRouter.sol";
import {Permit2Code} from "../helpers/Permit2Code.sol";

/// @notice 0x-Gasless-style trades: the user signs a Permit2 PermitWitnessTransferFrom whose witness is the trade;
///         a relayer (any EOA) submits and pays ETH. the canonical Permit2 runtime (read from 46630) is etched at its
///         canonical address. NOT run here (lee runs Foundry locally).
contract DiscipleRouterPermit2Test is IntegrationBase {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 constant EIP2612_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    BondingCurve sCurve; // STRATEGY-quoted coin (USDG hop + curve)
    Token sTok;
    BondingCurve uCurve; // USDG-quoted coin (curve only)
    Token uTok;
    uint256 aliceKey = 0xA11CE;
    address alice;
    address relayer = makeAddr("relayer");
    address mallory = makeAddr("mallory");

    function setUp() public override {
        super.setUp();
        alice = vm.addr(aliceKey);
        vm.etch(PERMIT2, Permit2Code.RUNTIME);
        router.setUsdgRouting(address(quote), address(launchpad));
        router.setUsdgPool(address(strategy), strategyUsdgKey);
        (sCurve, sTok) = _launchWithQuote(address(strategy), 0, 0);
        (uCurve, uTok) = _launchWithQuote(address(quote), 0, 0);
        _warpPastSnipe();
        quote.mint(alice, 1_000_000 ether);
    }

    // ───────── signing helpers ─────────

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

    function _trade(Token t, bool isBuy, uint256 amountIn, uint256 minOut)
        internal
        view
        returns (DiscipleRouter.Trade memory)
    {
        return DiscipleRouter.Trade({
            coin: address(t), isBuy: isBuy, amountIn: amountIn, minOut: minOut, recipient: alice, deadline: block.timestamp + 5 minutes
        });
    }

    function _permit(address token, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        pure
        returns (IPermit2Witness.PermitTransferFrom memory p)
    {
        p.permitted = IPermit2Witness.TokenPermissions({token: token, amount: amount});
        p.nonce = nonce;
        p.deadline = deadline;
    }

    function _sign(uint256 key, IPermit2Witness.PermitTransferFrom memory p, DiscipleRouter.Trade memory t, address spender)
        internal
        view
        returns (bytes memory)
    {
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                router.TRADE_WITNESS_TYPE()
            )
        );
        bytes32 witness = keccak256(
            abi.encode(router.TRADE_TYPEHASH(), t.coin, t.isBuy, t.amountIn, t.minOut, t.recipient, t.deadline)
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

    function _erc2612(address token, uint256 key) internal view returns (DiscipleRouter.Erc2612 memory a) {
        address owner = vm.addr(key);
        a.value = type(uint256).max;
        a.deadline = block.timestamp + 1 hours;
        bytes32 sh = keccak256(
            abi.encode(EIP2612_TYPEHASH, owner, PERMIT2, a.value, Token(token).nonces(owner), a.deadline)
        );
        (a.v, a.r, a.s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", Token(token).DOMAIN_SEPARATOR(), sh)));
    }

    function _noDust() internal view {
        assertEq(quote.balanceOf(address(router)), 0, "router usdg dust");
        assertEq(strategy.balanceOf(address(router)), 0, "router quote dust");
        assertEq(sTok.balanceOf(address(router)), 0, "router token dust");
        assertEq(uTok.balanceOf(address(router)), 0, "router token dust");
    }

    function _buy(Token t, uint256 amt, uint256 nonce, bool withApprove) internal returns (uint256 out, uint256 gasUsed) {
        DiscipleRouter.Trade memory tr = _trade(t, true, amt, 1);
        IPermit2Witness.PermitTransferFrom memory p = _permit(address(quote), amt, nonce, tr.deadline);
        bytes memory sig = _sign(aliceKey, p, tr, address(router));
        DiscipleRouter.Erc2612 memory a = withApprove ? _erc2612(address(quote), aliceKey) : DiscipleRouter.Erc2612(0, 0, 0, 0, 0);
        uint256 u0 = quote.balanceOf(alice);
        uint256 rEth = relayer.balance;
        vm.prank(relayer, relayer);
        uint256 g = gasleft();
        out = withApprove ? router.buyWithPermit2AndApprove(alice, p, tr, sig, a) : router.buyWithPermit2(alice, p, tr, sig);
        gasUsed = g - gasleft();
        assertEq(u0 - quote.balanceOf(alice), amt, "usdg from signer");
        assertEq(t.balanceOf(alice), out, "coins to signer");
        assertEq(t.balanceOf(relayer), 0, "relayer gets nothing");
        assertEq(relayer.balance, rEth);
        _noDust();
    }

    function _sell(Token t, uint256 amt, uint256 nonce, bool withApprove) internal returns (uint256 out, uint256 gasUsed) {
        DiscipleRouter.Trade memory tr = _trade(t, false, amt, 1);
        IPermit2Witness.PermitTransferFrom memory p = _permit(address(t), amt, nonce, tr.deadline);
        bytes memory sig = _sign(aliceKey, p, tr, address(router));
        DiscipleRouter.Erc2612 memory a = withApprove ? _erc2612(address(t), aliceKey) : DiscipleRouter.Erc2612(0, 0, 0, 0, 0);
        uint256 u0 = quote.balanceOf(alice);
        vm.prank(relayer, relayer);
        uint256 g = gasleft();
        out = withApprove ? router.sellWithPermit2AndApprove(alice, p, tr, sig, a) : router.sellWithPermit2(alice, p, tr, sig);
        gasUsed = g - gasleft();
        assertEq(quote.balanceOf(alice) - u0, out, "usdg to signer");
        assertEq(quote.balanceOf(relayer), 0, "relayer gets nothing");
        _noDust();
    }

    // ───────── happy paths (first trade bundles the EIP-2612 approve; no ETH on the user) ─────────

    function test_gaslessBuySell_usdgQuote_firstTradeBundlesPermit() public {
        assertEq(alice.balance, 0);
        (uint256 out, uint256 gb1) = _buy(uTok, 3 ether, 0, true);
        (, uint256 gb2) = _buy(uTok, 3 ether, 1, false);
        (, uint256 gs1) = _sell(uTok, out / 2, 2, true);
        (, uint256 gs2) = _sell(uTok, out / 4, 3, false);
        console2.log("gas buyWithPermit2AndApprove 1-hop", gb1);
        console2.log("gas buyWithPermit2 1-hop", gb2);
        console2.log("gas sellWithPermit2AndApprove 1-hop", gs1);
        console2.log("gas sellWithPermit2 1-hop", gs2);
    }

    function test_gaslessBuySell_strategyQuote_twoHops() public {
        (uint256 out,) = _buy(sTok, 3 ether, 0, true);
        assertGt(out, 0);
        _sell(sTok, out / 2, 1, true);
    }

    function test_gaslessGraduated() public {
        _graduateWith(uCurve, quote);
        (uint256 out,) = _buy(uTok, 3 ether, 0, true);
        _sell(uTok, out / 2, 1, true);
    }

    // ───────── binding / replay / signer == recipient ─────────

    function test_revert_replaySameNonce() public {
        DiscipleRouter.Trade memory tr = _trade(uTok, true, 3 ether, 1);
        IPermit2Witness.PermitTransferFrom memory p = _permit(address(quote), 3 ether, 9, tr.deadline);
        bytes memory sig = _sign(aliceKey, p, tr, address(router));
        DiscipleRouter.Erc2612 memory a = _erc2612(address(quote), aliceKey);
        vm.prank(relayer, relayer);
        router.buyWithPermit2AndApprove(alice, p, tr, sig, a);
        vm.prank(relayer, relayer);
        vm.expectRevert(); // Permit2 InvalidNonce
        router.buyWithPermit2(alice, p, tr, sig);
    }

    function test_revert_relayerChangesMinOutOrRecipient() public {
        _buy(uTok, 3 ether, 0, true); // approve Permit2
        DiscipleRouter.Trade memory tr = _trade(uTok, true, 3 ether, 1e18);
        IPermit2Witness.PermitTransferFrom memory p = _permit(address(quote), 3 ether, 1, tr.deadline);
        bytes memory sig = _sign(aliceKey, p, tr, address(router));
        DiscipleRouter.Trade memory loose = tr;
        loose.minOut = 0;
        vm.prank(relayer, relayer);
        vm.expectRevert(); // Permit2 InvalidSigner (witness differs)
        router.buyWithPermit2(alice, p, loose, sig);
        DiscipleRouter.Trade memory steal = tr;
        steal.recipient = mallory;
        vm.prank(relayer, relayer);
        vm.expectRevert(DiscipleRouter.BadSigner.selector);
        router.buyWithPermit2(alice, p, steal, sig);
    }

    function test_revert_signerNotRecipient_evenIfSigned() public {
        _buy(uTok, 3 ether, 0, true);
        DiscipleRouter.Trade memory tr = _trade(uTok, true, 3 ether, 1);
        tr.recipient = mallory; // alice herself signs a trade paying someone else: refused
        IPermit2Witness.PermitTransferFrom memory p = _permit(address(quote), 3 ether, 1, tr.deadline);
        bytes memory sig = _sign(aliceKey, p, tr, address(router));
        vm.expectRevert(DiscipleRouter.BadSigner.selector);
        router.buyWithPermit2(alice, p, tr, sig);
    }

    function test_revert_otherSignerForAlice() public {
        _buy(uTok, 3 ether, 0, true);
        DiscipleRouter.Trade memory tr = _trade(uTok, true, 3 ether, 1);
        IPermit2Witness.PermitTransferFrom memory p = _permit(address(quote), 3 ether, 1, tr.deadline);
        bytes memory sig = _sign(0xBAD, p, tr, address(router));
        vm.expectRevert(); // Permit2 InvalidSigner
        router.buyWithPermit2(alice, p, tr, sig);
    }

    function test_revert_permitMismatch_sideMismatch_expired() public {
        _buy(uTok, 3 ether, 0, true);
        DiscipleRouter.Trade memory tr = _trade(uTok, true, 3 ether, 1);
        IPermit2Witness.PermitTransferFrom memory p = _permit(address(quote), 2 ether, 1, tr.deadline);
        bytes memory sig = _sign(aliceKey, p, tr, address(router));
        vm.expectRevert(DiscipleRouter.BadPermit.selector);
        router.buyWithPermit2(alice, p, tr, sig);
        p = _permit(address(uTok), 3 ether, 1, tr.deadline);
        sig = _sign(aliceKey, p, tr, address(router));
        vm.expectRevert(DiscipleRouter.BadPermit.selector);
        router.buyWithPermit2(alice, p, tr, sig);
        p = _permit(address(quote), 3 ether, 1, tr.deadline);
        sig = _sign(aliceKey, p, tr, address(router));
        vm.expectRevert(DiscipleRouter.BadParam.selector);
        router.sellWithPermit2(alice, p, tr, sig);
        vm.warp(tr.deadline + 1);
        vm.expectRevert();
        router.buyWithPermit2(alice, p, tr, sig);
    }

    function test_revert_signatureForAnotherSpender() public {
        _buy(uTok, 3 ether, 0, true);
        DiscipleRouter.Trade memory tr = _trade(uTok, true, 3 ether, 1);
        IPermit2Witness.PermitTransferFrom memory p = _permit(address(quote), 3 ether, 1, tr.deadline);
        bytes memory sig = _sign(aliceKey, p, tr, makeAddr("otherRouter"));
        vm.expectRevert();
        router.buyWithPermit2(alice, p, tr, sig);
    }

    /// A front-run of the bundled EIP-2612 permit must not brick the trade.
    function test_frontRunPermit_tradeStillSucceeds() public {
        DiscipleRouter.Trade memory tr = _trade(uTok, true, 3 ether, 1);
        IPermit2Witness.PermitTransferFrom memory p = _permit(address(quote), 3 ether, 0, tr.deadline);
        bytes memory sig = _sign(aliceKey, p, tr, address(router));
        DiscipleRouter.Erc2612 memory a = _erc2612(address(quote), aliceKey);
        quote.permit(alice, PERMIT2, a.value, a.deadline, a.v, a.r, a.s);
        vm.prank(relayer, relayer);
        uint256 out = router.buyWithPermit2AndApprove(alice, p, tr, sig, a);
        assertGt(out, 0);
    }
}
