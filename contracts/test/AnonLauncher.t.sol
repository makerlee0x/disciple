// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./integration/IntegrationBase.sol";
import {AnonLauncher} from "../src/addons/AnonLauncher.sol";
import {Owned2Step} from "../src/utils/Owned2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {McapMath} from "../src/libraries/McapMath.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract Wallet1271 is IERC1271 {
    address public immutable signer;

    constructor(address s) {
        signer = s;
    }

    function isValidSignature(bytes32 h, bytes memory sig) external view returns (bytes4) {
        return ECDSA.recover(h, sig) == signer ? IERC1271.isValidSignature.selector : bytes4(0);
    }
}

contract AnonLauncherTest is IntegrationBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    AnonLauncher internal anon;
    address internal payer = makeAddr("payer"); // main wallet / smart account
    address internal relayer = makeAddr("relayer");
    uint256 internal skA;
    address internal stealthA;
    uint256 internal skB;
    address internal stealthB;
    uint256 internal FEE; // $0.50 at the USDG decimals

    function setUp() public override {
        super.setUp();
        FEE = U / 2;
        anon =
            new AnonLauncher(owner, address(launchpad), address(feeRouter), address(quote), treasury, address(0), FEE);
        (stealthA, skA) = makeAddrAndKey("stealthA");
        (stealthB, skB) = makeAddrAndKey("stealthB");
        quote.mint(payer, 1_000_000 * U);
        vm.prank(payer);
        quote.approve(address(anon), type(uint256).max);
    }

    function _params(uint256 buy) internal view returns (ILaunchpad.LaunchParams memory) {
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

    function _anonLaunch(address stealth, address recipient, uint256 buy)
        internal
        returns (BondingCurve c, Token t, uint256 bought)
    {
        vm.prank(payer);
        ILaunchpad.LaunchResult memory r = anon.launchAnon(_params(buy), stealth, recipient, "", 0x00);
        return (BondingCurve(r.curve), Token(r.token), r.creatorTokensBought);
    }

    function _sign(uint256 sk, address o, address[] memory toks, address to, uint256 rf, uint256 dl)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sk, anon.claimDigest(o, toks, to, rf, anon.nonces(o), dl));
        return abi.encodePacked(r, s, v);
    }

    function _req(uint256 sk, address o, address[] memory toks, address to, uint256 rf)
        internal
        view
        returns (AnonLauncher.ClaimReq memory)
    {
        uint256 dl = block.timestamp + 1 hours;
        return AnonLauncher.ClaimReq(o, toks, to, rf, dl, _sign(sk, o, toks, to, rf, dl));
    }

    function test_launch_creator_is_stealth_not_payer_fee_and_buy_routed() public {
        address fresh = makeAddr("fresh");
        uint256 tBefore = (quote.balanceOf(treasury) + feeRouter.treasuryAccrued(address(quote)));
        (uint256 expOut,,,,) = launchpad.quoteCreatorBuy(address(quote), 10 * U, 0);
        (BondingCurve c, Token t, uint256 bought) = _anonLaunch(stealthA, fresh, 10 * U);
        assertEq(anon.stealthOwnerOf(address(t)), stealthA);
        assertEq(launchpad.creatorOf(address(t)), address(anon));
        assertEq(c.creator(), address(anon));
        assertTrue(launchpad.creatorOf(address(t)) != payer);
        assertEq(bought, expOut, "creator buy anti-snipe exempt, via curve");
        assertEq(t.balanceOf(fresh), bought);
        assertEq(t.balanceOf(address(anon)), 0);
        assertEq(c.tokensSold(), bought);
        // launch fee + treasury share of 1% protocol fee
        assertGe((quote.balanceOf(treasury) + feeRouter.treasuryAccrued(address(quote))) - tBefore, FEE);
    }

    function testFuzz_buyRecipient_routing(address recipient, uint96 buy) public {
        vm.assume(recipient != address(0) && recipient != address(anon) && uint160(recipient) > 0x100);
        uint256 b = bound(uint256(buy), 1 * U, 40 * U);
        (, Token t, uint256 bought) = _anonLaunch(stealthA, recipient, b);
        assertGt(bought, 0);
        assertEq(t.balanceOf(recipient), bought);
    }

    function test_zero_recipient_defaults_to_stealth() public {
        (, Token t, uint256 bought) = _anonLaunch(stealthA, address(0), 10 * U);
        assertEq(t.balanceOf(stealthA), bought);
    }

    function test_launch_fee_capped_and_owner_only() public {
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        anon.setLaunchFee(1);
        vm.prank(owner);
        vm.expectRevert(AnonLauncher.FeeTooHigh.selector);
        anon.setLaunchFee(6 * U);
    }

    /// @dev 6-dec fix: the $5 ceiling is in USDG raw units at the token's decimals (was a fixed 5e18).
    function test_launch_fee_cap_is_five_dollars_at_usdg_decimals() public {
        assertEq(anon.MAX_LAUNCH_FEE(), 5 * U);
        vm.startPrank(owner);
        anon.setLaunchFee(5 * U);
        vm.expectRevert(AnonLauncher.FeeTooHigh.selector);
        anon.setLaunchFee(5 * U + 1);
        vm.stopPrank();
        vm.expectRevert(AnonLauncher.FeeTooHigh.selector);
        new AnonLauncher(owner, address(launchpad), address(feeRouter), address(quote), treasury, address(0), 5 * U + 1);
    }

    function test_claimManyBySig_batch_across_coins_any_address() public {
        (BondingCurve c1, Token t1,) = _anonLaunch(stealthA, address(0), 0);
        (BondingCurve c2, Token t2,) = _anonLaunch(stealthA, address(0), 0);
        _warpPastSnipe();
        _buy(c1, trader1, 200 * U, 0);
        _buy(c2, trader2, 300 * U, 0);
        (, uint256 p1,) = anon.pending(address(t1));
        (, uint256 p2,) = anon.pending(address(t2));
        // 33% of 1% creator share (no KOL)
        (uint256 cs1,,,) = FeeMath.splitTradeFee(FeeMath.protocolFee(200 * U));
        assertEq(p1, cs1);
        address[] memory toks = new address[](2);
        toks[0] = address(t1);
        toks[1] = address(t2);
        address dest = makeAddr("anyDest");
        AnonLauncher.ClaimReq memory r = _req(skA, stealthA, toks, dest, 100);
        vm.prank(relayer);
        anon.claimManyBySig(r);
        uint256 tot = p1 + p2;
        uint256 rf = (p1 * 100) / 10_000 + (p2 * 100) / 10_000;
        assertEq(quote.balanceOf(dest), tot - rf);
        assertEq(quote.balanceOf(relayer), rf);
        assertEq(feeRouter.creatorAccrued(address(t1), address(anon)), 0);
        // replay
        vm.expectRevert(AnonLauncher.BadSignature.selector);
        anon.claimManyBySig(r);
    }

    function test_sig_expiry_wrong_signer_wrong_chain() public {
        (BondingCurve c1, Token t1,) = _anonLaunch(stealthA, address(0), 0);
        _warpPastSnipe();
        _buy(c1, trader1, 100 * U, 0);
        address[] memory toks = new address[](1);
        toks[0] = address(t1);
        AnonLauncher.ClaimReq memory r = _req(skB, stealthA, toks, relayer, 0);
        vm.expectRevert(AnonLauncher.BadSignature.selector);
        anon.claimManyBySig(r);
        r = _req(skA, stealthA, toks, relayer, 0);
        vm.chainId(1);
        vm.expectRevert(AnonLauncher.BadSignature.selector);
        anon.claimManyBySig(r);
        vm.chainId(31337);
        vm.warp(r.deadline + 1);
        vm.expectRevert(AnonLauncher.Expired.selector);
        anon.claimManyBySig(r);
    }

    function test_cannot_claim_other_owners_coin() public {
        (, Token t1,) = _anonLaunch(stealthA, address(0), 0);
        address[] memory toks = new address[](1);
        toks[0] = address(t1);
        AnonLauncher.ClaimReq memory rq = _req(skB, stealthB, toks, stealthB, 0);
        vm.expectRevert(AnonLauncher.NotStealthOwner.selector);
        anon.claimManyBySig(rq);
        vm.prank(stealthB);
        vm.expectRevert(AnonLauncher.NotStealthOwner.selector);
        anon.claimMany(toks, stealthB);
    }

    function test_relayer_batches_many_owners() public {
        (BondingCurve c1, Token t1,) = _anonLaunch(stealthA, address(0), 0);
        (BondingCurve c2, Token t2,) = _anonLaunch(stealthB, address(0), 0);
        _warpPastSnipe();
        _buy(c1, trader1, 500 * U, 0);
        _buy(c2, trader1, 500 * U, 0);
        address[] memory a = new address[](1);
        a[0] = address(t1);
        address[] memory b = new address[](1);
        b[0] = address(t2);
        AnonLauncher.ClaimReq[] memory rs = new AnonLauncher.ClaimReq[](2);
        rs[0] = _req(skA, stealthA, a, makeAddr("dA"), 0);
        rs[1] = _req(skB, stealthB, b, makeAddr("dB"), 0);
        (, uint256 pa,) = anon.pending(address(t1));
        anon.claimManyBySigBatch(rs);
        assertEq(quote.balanceOf(makeAddr("dA")), pa);
        assertGt(quote.balanceOf(makeAddr("dB")), 0);
    }

    function test_erc1271_owner_and_direct_claimMany() public {
        Wallet1271 w = new Wallet1271(stealthA);
        (BondingCurve c1, Token t1,) = _anonLaunch(address(w), address(0), 0);
        _warpPastSnipe();
        _buy(c1, trader1, 100 * U, 0);
        address[] memory toks = new address[](1);
        toks[0] = address(t1);
        anon.claimManyBySig(_req(skA, address(w), toks, makeAddr("d"), 0));
        assertGt(quote.balanceOf(makeAddr("d")), 0);
        _buy(c1, trader1, 100 * U, 0);
        vm.prank(address(w));
        anon.claimMany(toks, makeAddr("d2"));
        assertGt(quote.balanceOf(makeAddr("d2")), 0);
    }

    function test_transferCreatorBySig_moves_unclaimed_and_metadata_by_sig() public {
        (BondingCurve c1, Token t1,) = _anonLaunch(stealthA, address(0), 0);
        uint256 dl = block.timestamp + 1 hours;
        bytes32 sh = keccak256(abi.encode(anon.TRANSFER_TYPEHASH(), address(t1), stealthB, anon.nonces(stealthA), dl));
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", anon.domainSeparator(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(skA, d);
        anon.transferCreatorBySig(address(t1), stealthB, dl, abi.encodePacked(r, s, v));
        assertEq(anon.stealthOwnerOf(address(t1)), stealthB);

        sh = keccak256(
            abi.encode(
                anon.METADATA_TYPEHASH(),
                address(t1),
                keccak256("ipfs://new"),
                keccak256("d"),
                keccak256(""),
                anon.nonces(stealthB),
                dl
            )
        );
        (v, r, s) = vm.sign(skB, keccak256(abi.encodePacked("\x19\x01", anon.domainSeparator(), sh)));
        anon.updateMetadataBySig(address(t1), "ipfs://new", "d", "", dl, abi.encodePacked(r, s, v));
        (,, string memory img,,,,,) = launchpad.metaOf(address(t1));
        assertEq(img, "ipfs://new");

        _warpPastSnipe();
        _buy(c1, trader1, 100 * U, 0);
        address[] memory toks = new address[](1);
        toks[0] = address(t1);
        AnonLauncher.ClaimReq memory rq = _req(skA, stealthA, toks, stealthA, 0);
        vm.expectRevert(AnonLauncher.NotStealthOwner.selector);
        anon.claimManyBySig(rq);
        anon.claimManyBySig(_req(skB, stealthB, toks, stealthB, 0));
        assertGt(quote.balanceOf(stealthB), 0);
    }

    function test_post_grad_fees_claimable_and_mcapNow_live() public {
        (BondingCurve c1, Token t1,) = _anonLaunch(stealthA, address(0), 0);
        _graduate(c1);
        uint256 m0 = c1.mcapNow();
        _swapExactInQuoteForToken(t1, trader1, 5_000 * U);
        uint256 m1 = c1.mcapNow();
        assertGt(m1, m0, "mcapNow tracks v4 pool after graduation");
        _swapExactInTokenForQuote(t1, trader1, t1.balanceOf(trader1) / 2);
        address[] memory toks = new address[](1);
        toks[0] = address(t1);
        (, uint256 q,) = anon.pending(address(t1));
        assertGt(q, 0);
        (,, uint256 tp) = anon.pending(address(t1));
        assertGt(tp, 0, "post-grad buy accrued token-side creator fees");
        anon.claimManyBySig(_req(skA, stealthA, toks, makeAddr("d"), 0));
        assertEq(feeRouter.creatorAccrued(address(t1), address(anon)), 0);
        assertEq(feeRouter.creatorTokenAccrued(address(t1), address(anon)), 0);
        assertEq(t1.balanceOf(address(anon)), 0);
        assertEq(t1.balanceOf(makeAddr("d")), tp);
    }

    // ───────────────────── v2: token-side (post-grad) creator fees ─────────────────────

    /// @dev Anon coin graduates; post-grad buy (hook fee in TOKEN) + sell (fee in quote) accrue both sides.
    function _gradWithBothSides(address stealth) internal returns (Token t) {
        BondingCurve c;
        (c, t,) = _anonLaunch(stealth, address(0), 0);
        _graduate(c);
        _swapExactInQuoteForToken(t, trader1, 5_000 * U);
        _swapExactInTokenForQuote(t, trader1, t.balanceOf(trader1) / 2);
        assertGt(feeRouter.creatorTokenAccrued(address(t), address(anon)), 0, "token side accrued to AnonLauncher");
        assertGt(feeRouter.creatorAccrued(address(t), address(anon)), 0, "quote side accrued to AnonLauncher");
    }

    function test_v2_pending_includes_token_side() public {
        Token t = _gradWithBothSides(stealthA);
        (address q, uint256 qa, uint256 ta) = anon.pending(address(t));
        assertEq(q, address(quote));
        assertEq(qa, feeRouter.creatorAccrued(address(t), address(anon)));
        assertEq(ta, feeRouter.creatorTokenAccrued(address(t), address(anon)));
    }

    function test_v2_claimMany_pays_both_sides() public {
        Token t = _gradWithBothSides(stealthA);
        (, uint256 qa, uint256 ta) = anon.pending(address(t));
        address dest = makeAddr("dest");
        address[] memory toks = new address[](1);
        toks[0] = address(t);
        vm.prank(stealthA);
        anon.claimMany(toks, dest);
        assertEq(quote.balanceOf(dest), qa);
        assertEq(t.balanceOf(dest), ta);
        assertEq(feeRouter.creatorAccrued(address(t), address(anon)), 0);
        assertEq(feeRouter.creatorTokenAccrued(address(t), address(anon)), 0);
        assertEq(t.balanceOf(address(anon)), 0);
        (, qa, ta) = anon.pending(address(t));
        assertEq(qa + ta, 0);
        // nothing left on either side -> NothingToClaim
        vm.prank(stealthA);
        vm.expectRevert(AnonLauncher.NothingToClaim.selector);
        anon.claimMany(toks, dest);
    }

    function test_v2_claimManyBySig_relayer_fee_on_both_sides_multi_coin() public {
        Token t1 = _gradWithBothSides(stealthA);
        Token t2 = _gradWithBothSides(stealthA);
        (, uint256 q1, uint256 a1) = anon.pending(address(t1));
        (, uint256 q2, uint256 a2) = anon.pending(address(t2));
        address[] memory toks = new address[](2);
        toks[0] = address(t1);
        toks[1] = address(t2);
        address dest = makeAddr("dest");
        uint256 rf = 250; // 2.5%
        uint256 relQ0 = quote.balanceOf(relayer);
        AnonLauncher.ClaimReq memory r = _req(skA, stealthA, toks, dest, rf);
        vm.prank(relayer);
        anon.claimManyBySig(r);
        uint256 fq = (q1 * rf) / 10_000 + (q2 * rf) / 10_000;
        assertEq(quote.balanceOf(relayer) - relQ0, fq, "relayer fee on quote side");
        assertEq(quote.balanceOf(dest), q1 + q2 - fq);
        assertEq(t1.balanceOf(relayer), (a1 * rf) / 10_000, "relayer fee on token side (t1)");
        assertEq(t2.balanceOf(relayer), (a2 * rf) / 10_000, "relayer fee on token side (t2)");
        assertGt(t1.balanceOf(relayer), 0);
        assertEq(t1.balanceOf(dest), a1 - (a1 * rf) / 10_000);
        assertEq(t2.balanceOf(dest), a2 - (a2 * rf) / 10_000);
        assertEq(feeRouter.creatorTokenAccrued(address(t1), address(anon)), 0);
        assertEq(feeRouter.creatorTokenAccrued(address(t2), address(anon)), 0);
        assertEq(anon.nonces(stealthA), 1);
    }

    function test_v2_claimManyBySigBatch_pays_token_side() public {
        Token t1 = _gradWithBothSides(stealthA);
        Token t2 = _gradWithBothSides(stealthB);
        (,, uint256 a1) = anon.pending(address(t1));
        (,, uint256 a2) = anon.pending(address(t2));
        address[] memory a = new address[](1);
        a[0] = address(t1);
        address[] memory b = new address[](1);
        b[0] = address(t2);
        AnonLauncher.ClaimReq[] memory rs = new AnonLauncher.ClaimReq[](2);
        rs[0] = _req(skA, stealthA, a, makeAddr("dA"), 100);
        rs[1] = _req(skB, stealthB, b, makeAddr("dB"), 100);
        vm.prank(relayer);
        anon.claimManyBySigBatch(rs);
        assertEq(t1.balanceOf(makeAddr("dA")), a1 - (a1 * 100) / 10_000);
        assertEq(t2.balanceOf(makeAddr("dB")), a2 - (a2 * 100) / 10_000);
        assertEq(t1.balanceOf(relayer), (a1 * 100) / 10_000);
        assertEq(t2.balanceOf(relayer), (a2 * 100) / 10_000);
    }

    function test_v2_skips_zero_side_without_revert() public {
        Token t = _gradWithBothSides(stealthA);
        address[] memory toks = new address[](1);
        toks[0] = address(t);
        vm.prank(stealthA);
        anon.claimMany(toks, makeAddr("d0"));
        // token side only (post-grad buy, no sell): quote side is 0 and must be skipped
        _swapExactInQuoteForToken(t, trader2, 1_000 * U);
        (, uint256 qa, uint256 ta) = anon.pending(address(t));
        assertEq(qa, 0);
        assertGt(ta, 0);
        vm.prank(stealthA);
        anon.claimMany(toks, makeAddr("d1"));
        assertEq(t.balanceOf(makeAddr("d1")), ta);
        assertEq(quote.balanceOf(makeAddr("d1")), 0);
        // quote side only (sell): token side is 0 and must be skipped
        _swapExactInTokenForQuote(t, trader2, t.balanceOf(trader2) / 2);
        (, qa, ta) = anon.pending(address(t));
        assertGt(qa, 0);
        assertEq(ta, 0);
        vm.prank(stealthA);
        anon.claimMany(toks, makeAddr("d2"));
        assertEq(quote.balanceOf(makeAddr("d2")), qa);
        assertEq(t.balanceOf(makeAddr("d2")), 0);
    }

    function test_v2_pre_grad_quote_only_and_empty_list_noop() public {
        (BondingCurve c1, Token t1,) = _anonLaunch(stealthA, address(0), 0);
        address[] memory toks = new address[](1);
        toks[0] = address(t1);
        vm.prank(stealthA);
        vm.expectRevert(AnonLauncher.NothingToClaim.selector);
        anon.claimMany(toks, stealthA);
        _warpPastSnipe();
        _buy(c1, trader1, 100 * U, 0);
        (, uint256 qa, uint256 ta) = anon.pending(address(t1));
        assertGt(qa, 0);
        assertEq(ta, 0);
        vm.prank(stealthA);
        anon.claimMany(toks, makeAddr("d"));
        assertEq(quote.balanceOf(makeAddr("d")), qa);
        // empty list: no-op (burns the nonce via claimManyBySig, never reverts NothingToClaim)
        address[] memory none = new address[](0);
        anon.claimManyBySig(_req(skA, stealthA, none, stealthA, 0));
        assertEq(anon.nonces(stealthA), 1);
    }

    function test_v2_eip712_domain_and_claim_digest_unchanged() public view {
        (, string memory name, string memory version, uint256 chainId, address vc,,) = anon.eip712Domain();
        assertEq(name, "DISCIPLE AnonLauncher");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(vc, address(anon));
        assertEq(
            anon.CLAIM_TYPEHASH(),
            keccak256(
                "Claim(address owner,address[] tokens,address to,uint256 relayerFeeBps,uint256 nonce,uint256 deadline)"
            )
        );
        address[] memory toks = new address[](1);
        toks[0] = address(0xBEEF);
        bytes32 sh = keccak256(
            abi.encode(anon.CLAIM_TYPEHASH(), stealthA, keccak256(abi.encodePacked(toks)), relayer, 7, 3, 99)
        );
        assertEq(
            anon.claimDigest(stealthA, toks, relayer, 7, 3, 99),
            keccak256(abi.encodePacked("\x19\x01", anon.domainSeparator(), sh))
        );
    }

    function test_v2_owned2step() public {
        address n = makeAddr("newOwner");
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        anon.transferOwnership(n);
        vm.prank(owner);
        anon.transferOwnership(n);
        assertEq(anon.owner(), owner);
        assertEq(anon.pendingOwner(), n);
        vm.expectRevert(Owned2Step.NotPendingOwner.selector);
        anon.acceptOwnership();
        vm.prank(n);
        anon.acceptOwnership();
        assertEq(anon.owner(), n);
        vm.prank(owner);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        anon.setTreasury(n);
        vm.prank(n);
        anon.setLaunchFee(1 * U);
        assertEq(anon.launchFee(), 1 * U);
    }
}

contract McapNowGraduatedTest is IntegrationBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function test_mcapNow_reads_v4_pool_after_graduation() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _graduate(curve);
        uint256 launchVal = CurveMathView.mcap(curve);
        // right after graduation pool price == curve-end price
        assertApproxEqRel(curve.mcapNow(), launchVal, 1e12);
        _swapExactInQuoteForToken(tok, trader1, 10_000 * U);
        (uint160 sp,,,) = manager.getSlot0(_poolKey(tok).toId());
        uint256 px = uint160(address(tok)) < uint160(address(quote))
            ? Math.mulDiv(Math.mulDiv(sp, sp, 1 << 64), 1e18, 1 << 128)
            : Math.mulDiv(Math.mulDiv(1e18, 1 << 96, sp), 1 << 96, sp);
        assertEq(curve.priceNow(), px);
        // full-precision mcap from sqrtPrice (not via the floored priceWad)
        assertEq(
            curve.mcapNow(),
            McapMath.mcapUsdFromSqrt(
                sp, uint160(address(tok)) < uint160(address(quote)), Constants.TOTAL_SUPPLY, curve.quotePriceUsd()
            )
        );
        // Via the floored WAD price only at 18-dec USDG: at 6 dec priceNow() is a single-digit integer (here
        // ~5) so px-based mcap is off by up to ~25% (why mcapNow() reads sqrtPrice). SITE: never derive mcap/price from
        // priceNow()/priceAfterX18 at 6 dec.
        if (_usdgDecimals() == 18) {
            assertApproxEqRel(
                curve.mcapNow(),
                Math.mulDiv(Math.mulDiv(px, Constants.TOTAL_SUPPLY, 1e18), curve.quotePriceUsd(), 1e18),
                1e6
            );
        } else {
            assertLt(px, 100, "6-dec priceNow is coarse");
        }
        assertGt(curve.mcapNow(), launchVal);
        uint256 hi = curve.mcapNow();
        _swapExactInTokenForQuote(tok, trader1, tok.balanceOf(trader1));
        assertLt(curve.mcapNow(), hi);
    }
}

library CurveMathView {
    function mcap(BondingCurve c) internal view returns (uint256) {
        (uint256 ts, uint256 sC, uint256 x0, uint256 y0) = c.curveParams();
        sC;
        uint256 y = y0 - c.tokensSold();
        uint256 x = Math.mulDiv(x0, y0, y);
        return Math.mulDiv(Math.mulDiv(x, ts, y), c.quotePriceUsd(), 1e18);
    }
}

import {MarketLens} from "../src/addons/MarketLens.sol";

contract MarketLensTest is IntegrationBase {
    function test_lens_matches_fixed_curve_and_pool() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        MarketLens lens = new MarketLens(address(launchpad), address(migration));
        assertEq(lens.mcapNow(address(tok)), curve.mcapNow());
        _graduate(curve);
        _swapExactInQuoteForToken(tok, trader1, 10_000 * U);
        (uint256 p, uint256 m, bool g) = lens.market(address(tok));
        assertTrue(g);
        assertEq(p, curve.priceNow());
        assertEq(m, curve.mcapNow());
    }
}

/// @notice 6-decimal USDG run of AnonLauncherTest (mainnet USDG / next testnet mock); same tests, `U` = 1e6.
contract AnonLauncher6DecTest is AnonLauncherTest {
    function _usdgDecimals() internal pure override returns (uint8) {
        return 6;
    }
}

/// @notice 6-decimal USDG run of McapNowGraduatedTest (mainnet USDG / next testnet mock); same tests, `U` = 1e6.
contract McapNowGraduated6DecTest is McapNowGraduatedTest {
    function _usdgDecimals() internal pure override returns (uint8) {
        return 6;
    }
}

/// @notice 6-decimal USDG run of MarketLensTest (mainnet USDG / next testnet mock); same tests, `U` = 1e6.
contract MarketLens6DecTest is MarketLensTest {
    function _usdgDecimals() internal pure override returns (uint8) {
        return 6;
    }
}
