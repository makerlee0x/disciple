// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "./integration/IntegrationBase.sol";
import {Token} from "../src/Token.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {CurveFeeVault} from "../src/CurveFeeVault.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {ILaunchpad} from "../src/interfaces/ILaunchpad.sol";
import {CreatorClaimBySig} from "../src/addons/CreatorClaimBySig.sol";

/// @notice Owner-yes claim for normal rockets (lee, Nov 12 2026 12:21 AM CT): the creator signs the existing
///         AnonLauncher-style Claim, anyone submits it, CreatorClaimBySig pulls through the existing claim-router
///         functions (FeeRouter.claimCreatorFeesFor / claimCreatorTokenFeesFor_15, CurveFeeVault.claimCreatorFeesToRouter).
contract CreatorClaimBySigTest is IntegrationBase {
    uint256 internal constant CREATOR_PK = 0xC0FFEE;
    uint256 internal constant OTHER_PK = 0xBEEF;
    CreatorClaimBySig internal helper;
    address internal other;
    address internal relayer = makeAddr("relayer");

    function setUp() public override {
        creator = vm.addr(CREATOR_PK); // a normal launch wallet with a key (base funds it)
        other = vm.addr(OTHER_PK);
        super.setUp();
        quote.mint(other, 1_000_000 * U);
        helper = new CreatorClaimBySig(address(feeRouter), address(launchpad));
        vm.prank(owner);
        feeRouter.setClaimRouter(address(helper), true); // the later owner step, done here only in the test
    }

    // ───────── helpers ─────────

    function _launchAs(address who) internal returns (BondingCurve c, Token t) {
        vm.prank(who);
        ILaunchpad.LaunchResult memory r = launchpad.launchCoin(
            ILaunchpad.LaunchParams({
                name: "N",
                ticker: "N",
                imageURI: "ipfs://img",
                description: "",
                socialsURI: "",
                quote: address(quote),
                creatorTaxBps: 100,
                creatorBuyQuoteIn: 0,
                creatorBuyMinTokensOut: 0,
                deadline: block.timestamp + 1 days
            })
        );
        c = BondingCurve(r.curve);
        t = Token(r.token);
    }

    /// @dev graduated coin with fees on every side: vault (curve phase), FeeRouter quote and token (post-grad)
    function _allSides() internal returns (Token t) {
        BondingCurve c;
        (c, t) = _launchAs(creator);
        _graduate(c);
        _swapExactInQuoteForToken(t, trader1, 5_000 * U);
        _swapExactInTokenForQuote(t, trader1, t.balanceOf(trader1) / 2);
        assertGt(feeVault.creatorAccrued(address(t), creator), 0, "vault side");
        assertGt(feeRouter.creatorAccrued(address(t), creator), 0, "FeeRouter quote side");
        assertGt(feeRouter.creatorTokenAccrued(address(t), creator), 0, "FeeRouter token side");
    }

    function _one(address t) internal pure returns (address[] memory a) {
        a = new address[](1);
        a[0] = t;
    }

    function _req(uint256 pk, address owner_, address[] memory toks, address to, uint256 feeBps, uint256 deadline)
        internal
        view
        returns (CreatorClaimBySig.ClaimReq memory r)
    {
        bytes32 d = helper.claimDigest(owner_, toks, to, feeBps, helper.nonces(owner_), deadline);
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(pk, d);
        r = CreatorClaimBySig.ClaimReq({
            owner: owner_,
            tokens: toks,
            to: to,
            relayerFeeBps: feeBps,
            deadline: deadline,
            sig: abi.encodePacked(rr, s, v)
        });
    }

    // ───────── tests ─────────

    function test_digest_matchesAnonLauncherClaimStruct() public view {
        assertEq(
            helper.CLAIM_TYPEHASH(),
            keccak256(
                "Claim(address owner,address[] tokens,address to,uint256 relayerFeeBps,uint256 nonce,uint256 deadline)"
            )
        );
        (, string memory name, string memory version,, address vc,,) = helper.eip712Domain();
        assertEq(name, "DISCIPLE CreatorClaim");
        assertEq(version, "1");
        assertEq(vc, address(helper));
    }

    function test_validSig_paysAllSidesToSigner_relayerSubmits() public {
        Token t = _allSides();
        uint256 v = feeVault.creatorAccrued(address(t), creator);
        uint256 q = feeRouter.creatorAccrued(address(t), creator);
        uint256 tk = feeRouter.creatorTokenAccrued(address(t), creator);
        uint256 q0 = quote.balanceOf(creator);
        uint256 t0 = t.balanceOf(creator);
        CreatorClaimBySig.ClaimReq memory r =
            _req(CREATOR_PK, creator, _one(address(t)), creator, 0, block.timestamp + 1 hours);
        vm.prank(relayer);
        address who = helper.claimCreatorFeesBySig(r);
        assertEq(who, creator, "paid wallet is the recovered signer");
        assertEq(quote.balanceOf(creator) - q0, v + q, "vault + FeeRouter quote");
        assertEq(t.balanceOf(creator) - t0, tk, "rocket-token side");
        assertEq(feeVault.creatorAccrued(address(t), creator), 0);
        assertEq(feeRouter.creatorAccrued(address(t), creator), 0);
        assertEq(feeRouter.creatorTokenAccrued(address(t), creator), 0);
        assertEq(quote.balanceOf(address(helper)), 0, "helper keeps nothing");
        assertEq(t.balanceOf(address(helper)), 0, "helper keeps nothing");
        assertEq(quote.balanceOf(relayer), 0, "no relayer cut at 0 bps");
        assertEq(helper.nonces(creator), 1);
    }

    function test_curvePhaseOnly_vaultPaid() public {
        (BondingCurve c, Token t) = _launchAs(creator);
        _warpPastSnipe();
        _buy(c, trader1, 300 * U, 0);
        uint256 p = feeVault.creatorClaimable(address(t), creator);
        assertGt(p, 0);
        assertEq(feeRouter.creatorAccrued(address(t), creator), 0);
        uint256 q0 = quote.balanceOf(creator);
        CreatorClaimBySig.ClaimReq memory r =
            _req(CREATOR_PK, creator, _one(address(t)), creator, 0, block.timestamp + 1 hours);
        vm.prank(relayer);
        helper.claimCreatorFeesBySig(r);
        assertEq(quote.balanceOf(creator) - q0, p, "owed fees settled and paid");
    }

    function test_wrongSigner_reverts() public {
        Token t = _allSides();
        // `other` signs a request naming the creator
        CreatorClaimBySig.ClaimReq memory r =
            _req(OTHER_PK, creator, _one(address(t)), other, 0, block.timestamp + 1 hours);
        vm.expectRevert(CreatorClaimBySig.BadSignature.selector);
        helper.claimCreatorFeesBySig(r);
        // tampered payout of a real creator signature
        r = _req(CREATOR_PK, creator, _one(address(t)), creator, 0, block.timestamp + 1 hours);
        r.to = other;
        vm.expectRevert(CreatorClaimBySig.BadSignature.selector);
        helper.claimCreatorFeesBySig(r);
        // garbage signature
        r.to = creator;
        r.sig = hex"1234";
        vm.expectRevert(CreatorClaimBySig.BadSignature.selector);
        helper.claimCreatorFeesBySig(r);
        assertGt(feeRouter.creatorAccrued(address(t), creator), 0, "untouched");
    }

    function test_replay_reverts() public {
        Token t = _allSides();
        CreatorClaimBySig.ClaimReq memory r =
            _req(CREATOR_PK, creator, _one(address(t)), creator, 0, block.timestamp + 1 hours);
        helper.claimCreatorFeesBySig(r);
        // more fees arrive; the same signature must not claim them
        _swapExactInTokenForQuote(t, trader1, t.balanceOf(trader1) / 2);
        assertGt(feeRouter.creatorAccrued(address(t), creator), 0);
        vm.expectRevert(CreatorClaimBySig.BadSignature.selector);
        helper.claimCreatorFeesBySig(r);
    }

    function test_onlySignersBalance() public {
        Token t = _allSides();
        (BondingCurve c2, Token t2) = _launchAs(other);
        _warpPastSnipe();
        _buy(c2, trader2, 300 * U, 0);
        uint256 otherOwed = feeVault.creatorClaimable(address(t2), other);
        assertGt(otherOwed, 0);
        // the creator signs for the other creator's coin: nothing of theirs is the signer's
        CreatorClaimBySig.ClaimReq memory r =
            _req(CREATOR_PK, creator, _one(address(t2)), creator, 0, block.timestamp + 1 hours);
        vm.expectRevert(CreatorClaimBySig.NothingToClaim.selector);
        helper.claimCreatorFeesBySig(r);
        assertEq(feeVault.creatorClaimable(address(t2), other), otherOwed, "other creator untouched");
        // the other creator's own signature only takes their own coin's balance, not the first creator's
        r = _req(OTHER_PK, other, _one(address(t)), other, 0, block.timestamp + 1 hours);
        vm.expectRevert(CreatorClaimBySig.NothingToClaim.selector);
        helper.claimCreatorFeesBySig(r);
        assertGt(feeRouter.creatorAccrued(address(t), creator), 0, "first creator untouched");
        r = _req(OTHER_PK, other, _one(address(t2)), other, 0, block.timestamp + 1 hours);
        uint256 o0 = quote.balanceOf(other);
        helper.claimCreatorFeesBySig(r);
        assertEq(quote.balanceOf(other) - o0, otherOwed);
    }

    function test_notAllowlisted_reverts() public {
        CreatorClaimBySig h2 = new CreatorClaimBySig(address(feeRouter), address(launchpad));
        // curve-phase coin: the vault refuses a router FeeRouter has not approved
        (BondingCurve c, Token t) = _launchAs(creator);
        _warpPastSnipe();
        _buy(c, trader1, 300 * U, 0);
        bytes32 d = h2.claimDigest(creator, _one(address(t)), creator, 0, 0, block.timestamp + 1 hours);
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(CREATOR_PK, d);
        CreatorClaimBySig.ClaimReq memory r = CreatorClaimBySig.ClaimReq({
            owner: creator,
            tokens: _one(address(t)),
            to: creator,
            relayerFeeBps: 0,
            deadline: block.timestamp + 1 hours,
            sig: abi.encodePacked(rr, s, v)
        });
        vm.expectRevert(CurveFeeVault.OnlyClaimRouter.selector);
        h2.claimCreatorFeesBySig(r);
        // revoking an approved helper stops it the same way
        vm.prank(owner);
        feeRouter.setClaimRouter(address(helper), false);
        r = _req(CREATOR_PK, creator, _one(address(t)), creator, 0, block.timestamp + 1 hours);
        vm.expectRevert(CurveFeeVault.OnlyClaimRouter.selector);
        helper.claimCreatorFeesBySig(r);
        assertGt(feeVault.creatorClaimable(address(t), creator), 0, "untouched");
    }

    function test_relayerFee_capAndPaidToSubmitter() public {
        Token t = _allSides();
        CreatorClaimBySig.ClaimReq memory r =
            _req(CREATOR_PK, creator, _one(address(t)), creator, 501, block.timestamp + 1 hours);
        vm.expectRevert(CreatorClaimBySig.FeeTooHigh.selector);
        helper.claimCreatorFeesBySig(r);
        uint256 v = feeVault.creatorAccrued(address(t), creator);
        uint256 q = feeRouter.creatorAccrued(address(t), creator);
        r = _req(CREATOR_PK, creator, _one(address(t)), creator, 100, block.timestamp + 1 hours);
        vm.prank(relayer);
        helper.claimCreatorFeesBySig(r);
        assertEq(quote.balanceOf(relayer), (v + q) / 100, "1% of the quote side to the submitter");
    }

    function test_expired_zeroTo_unknownToken_emptyList() public {
        Token t = _allSides();
        CreatorClaimBySig.ClaimReq memory r =
            _req(CREATOR_PK, creator, _one(address(t)), creator, 0, block.timestamp - 1);
        vm.expectRevert(CreatorClaimBySig.Expired.selector);
        helper.claimCreatorFeesBySig(r);
        r = _req(CREATOR_PK, creator, _one(address(t)), address(0), 0, block.timestamp + 1);
        vm.expectRevert(CreatorClaimBySig.ZeroAddress.selector);
        helper.claimCreatorFeesBySig(r);
        address bogus = makeAddr("bogus");
        r = _req(CREATOR_PK, creator, _one(bogus), creator, 0, block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(CreatorClaimBySig.UnknownToken.selector, bogus));
        helper.claimCreatorFeesBySig(r);
        // empty list: only uses up the nonce (same as claimManyBySig)
        r = _req(CREATOR_PK, creator, new address[](0), creator, 0, block.timestamp + 1);
        helper.claimCreatorFeesBySig(r);
        assertEq(helper.nonces(creator), 1);
    }

    function test_existingPathsUnchanged() public {
        // the creator can still self-claim directly, and DiscipleRouter stays an approved claim router
        Token t = _allSides();
        assertTrue(feeRouter.isClaimRouter(address(router)));
        vm.startPrank(creator);
        assertGt(feeRouter.claimCreatorFees(address(t)), 0);
        assertGt(feeRouter.claimCreatorTokenFees(address(t)), 0);
        assertGt(feeVault.claimCreatorFees(address(t)), 0);
        vm.stopPrank();
        CreatorClaimBySig.ClaimReq memory r =
            _req(CREATOR_PK, creator, _one(address(t)), creator, 0, block.timestamp + 1 hours);
        vm.expectRevert(CreatorClaimBySig.NothingToClaim.selector);
        helper.claimCreatorFeesBySig(r);
    }
}
