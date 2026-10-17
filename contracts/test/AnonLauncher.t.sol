// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./integration/IntegrationBase.sol";
import {AnonLauncher} from "../src/addons/AnonLauncher.sol";
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
    uint256 constant FEE = 0.5 ether;

    function setUp() public override {
        super.setUp();
        anon =
            new AnonLauncher(owner, address(launchpad), address(feeRouter), address(quote), treasury, address(0), FEE);
        (stealthA, skA) = makeAddrAndKey("stealthA");
        (stealthB, skB) = makeAddrAndKey("stealthB");
        quote.mint(payer, 1_000_000 ether);
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
        uint256 tBefore = quote.balanceOf(treasury);
        (uint256 expOut,,,,) = launchpad.quoteCreatorBuy(address(quote), 10 ether, 0);
        (BondingCurve c, Token t, uint256 bought) = _anonLaunch(stealthA, fresh, 10 ether);
        assertEq(anon.stealthOwnerOf(address(t)), stealthA);
        assertEq(launchpad.creatorOf(address(t)), address(anon));
        assertEq(c.creator(), address(anon));
        assertTrue(launchpad.creatorOf(address(t)) != payer);
        assertEq(bought, expOut, "creator buy anti-snipe exempt, via curve");
        assertEq(t.balanceOf(fresh), bought);
        assertEq(t.balanceOf(address(anon)), 0);
        assertEq(c.tokensSold(), bought);
        // launch fee + treasury share of 1% protocol fee
        assertGe(quote.balanceOf(treasury) - tBefore, FEE);
    }

    function testFuzz_buyRecipient_routing(address recipient, uint96 buy) public {
        vm.assume(recipient != address(0) && recipient != address(anon) && uint160(recipient) > 0x100);
        uint256 b = bound(uint256(buy), 1 ether, 40 ether);
        (, Token t, uint256 bought) = _anonLaunch(stealthA, recipient, b);
        assertGt(bought, 0);
        assertEq(t.balanceOf(recipient), bought);
    }

    function test_zero_recipient_defaults_to_stealth() public {
        (, Token t, uint256 bought) = _anonLaunch(stealthA, address(0), 10 ether);
        assertEq(t.balanceOf(stealthA), bought);
    }

    function test_launch_fee_capped_and_owner_only() public {
        vm.expectRevert(AnonLauncher.OnlyOwner.selector);
        anon.setLaunchFee(1);
        vm.prank(owner);
        vm.expectRevert(AnonLauncher.FeeTooHigh.selector);
        anon.setLaunchFee(6 ether);
    }

    function test_claimManyBySig_batch_across_coins_any_address() public {
        (BondingCurve c1, Token t1,) = _anonLaunch(stealthA, address(0), 0);
        (BondingCurve c2, Token t2,) = _anonLaunch(stealthA, address(0), 0);
        _warpPastSnipe();
        _buy(c1, trader1, 200 ether, 0);
        _buy(c2, trader2, 300 ether, 0);
        (, uint256 p1,) = anon.pending(address(t1));
        (, uint256 p2,) = anon.pending(address(t2));
        // 33% of 1% creator share (no KOL)
        (uint256 cs1,,,) = FeeMath.splitTradeFee(FeeMath.protocolFee(200 ether));
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
        _buy(c1, trader1, 100 ether, 0);
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
        _buy(c1, trader1, 500 ether, 0);
        _buy(c2, trader1, 500 ether, 0);
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
        _buy(c1, trader1, 100 ether, 0);
        address[] memory toks = new address[](1);
        toks[0] = address(t1);
        anon.claimManyBySig(_req(skA, address(w), toks, makeAddr("d"), 0));
        assertGt(quote.balanceOf(makeAddr("d")), 0);
        _buy(c1, trader1, 100 ether, 0);
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
        _buy(c1, trader1, 100 ether, 0);
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
        _swapExactInQuoteForToken(t1, trader1, 5_000 ether);
        uint256 m1 = c1.mcapNow();
        assertGt(m1, m0, "mcapNow tracks v4 pool after graduation");
        _swapExactInTokenForQuote(t1, trader1, t1.balanceOf(trader1) / 2);
        address[] memory toks = new address[](1);
        toks[0] = address(t1);
        (, uint256 q,) = anon.pending(address(t1));
        assertGt(q, 0);
        anon.claimManyBySig(_req(skA, stealthA, toks, makeAddr("d"), 0));
        assertEq(feeRouter.creatorAccrued(address(t1), address(anon)), 0);
        assertEq(t1.balanceOf(address(anon)), 0);
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
        _swapExactInQuoteForToken(tok, trader1, 10_000 ether);
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
        assertApproxEqRel(
            curve.mcapNow(), Math.mulDiv(Math.mulDiv(px, Constants.TOTAL_SUPPLY, 1e18), curve.quotePriceUsd(), 1e18), 1e6
        );
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
        _swapExactInQuoteForToken(tok, trader1, 10_000 ether);
        (uint256 p, uint256 m, bool g) = lens.market(address(tok));
        assertTrue(g);
        assertEq(p, curve.priceNow());
        assertEq(m, curve.mcapNow());
    }
}
