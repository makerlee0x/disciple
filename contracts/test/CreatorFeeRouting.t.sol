// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {IntegrationBase} from "./integration/IntegrationBase.sol";
import {CreatorFeeHarvest} from "../src/addons/CreatorFeeHarvest.sol";
import {AnonLauncher} from "../src/addons/AnonLauncher.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {FeeMath} from "../src/libraries/FeeMath.sol";
import {Token} from "../src/Token.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {ILaunchpad} from "../src/interfaces/ILaunchpad.sol";
import {LockedLP} from "../src/LockedLP.sol";

/// @notice Creator-fee destinations. Trades still pay the launcher. `route` runs later.
contract CreatorFeeRoutingTest is IntegrationBase {
    uint256 internal constant TAX = 700; // 7%
    uint256 internal constant BUY = 100 ether;
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    AnonLauncher internal anon;
    uint256 internal sk;
    address internal stealth;

    function setUp() public override {
        super.setUp();
        vm.startPrank(owner);
        harvest.wire(
            address(launchpad), address(feeRouter), address(lockedLP), address(router), address(hook), address(manager)
        );
        launchpad.setTrustedRouter(address(harvest), true);
        // setTrustedRouter also stores curveRouter. Put DiscipleRouter back so private USDG launches still find it.
        launchpad.setTrustedRouter(address(router), true);
        feeRouter.setClaimRouter(address(harvest), true);
        vm.stopPrank();
        anon = new AnonLauncher(owner, address(launchpad), address(feeRouter), address(quote), treasury, address(0), 0);
        vm.prank(owner);
        harvest.setAnonLauncher(address(anon));
        vm.prank(owner);
        anon.setCreatorFeeHarvest(address(harvest));
        (stealth, sk) = makeAddrAndKey("stealth");
    }

    function _params(uint256 tax, uint256 buy) internal view returns (ILaunchpad.LaunchParams memory p) {
        p = ILaunchpad.LaunchParams({
            name: "FeeCoin",
            ticker: "FEE",
            imageURI: "ipfs://img",
            description: "fees",
            socialsURI: "",
            quote: address(quote),
            creatorTaxBps: tax,
            creatorBuyQuoteIn: buy,
            creatorBuyMinTokensOut: 0,
            deadline: block.timestamp + 1 days
        });
    }

    function _launchDest(uint8 dest, uint256 tax) internal returns (BondingCurve curve, Token tok) {
        vm.prank(creator);
        ILaunchpad.LaunchResult memory r = harvest.launch(_params(tax, 0), dest);
        curve = BondingCurve(r.curve);
        tok = Token(r.token);
    }

    /// @dev Creator fee owed on a post-snipe curve buy of `quoteIn`: the 33% creator share plus the creator tax.
    function _owed(uint256 quoteIn, uint256 taxBps)
        internal
        pure
        returns (uint256 creatorAmt, uint256 share, uint256 tax, uint256 lpShare)
    {
        uint256 proto = FeeMath.protocolFee(quoteIn);
        tax = FeeMath.creatorTax(quoteIn, taxBps);
        (share, lpShare,,) = FeeMath.splitTradeFee(proto);
        creatorAmt = share + tax;
    }

    function _escrow(address token) internal view returns (uint256) {
        (,,,, uint256 esc,,) = lockedLP.positions(token);
        return esc;
    }

    /// @dev The launcher self-claims rocket-token fees and hands them to the harvest. Quote fees stay accrued.
    function _handOverRockets(Token tok) internal {
        uint256 tAcc = feeRouter.creatorTokenAccrued(address(tok), creator);
        vm.startPrank(creator);
        feeRouter.claimCreatorTokenFees(address(tok));
        tok.approve(address(harvest), tAcc);
        harvest.depositRocketTokens(address(tok), tAcc);
        vm.stopPrank();
    }

    function test_keepFees_isDefault_andIncludesShareAndTax() public {
        vm.prank(creator);
        ILaunchpad.LaunchResult memory direct = launchpad.launch(_params(TAX, 0));
        assertEq(launchpad.creatorOf(direct.token), creator, "a normal launch is still the launcher");
        assertEq(harvest.creatorFeeDestinationOf(direct.token), 0);
        assertEq(Token(direct.token).creator(), creator);

        (BondingCurve curve, Token tok) = _launchDest(0, TAX);
        assertEq(launchpad.creatorOf(address(tok)), creator, "destination 0 does not move creatorOf");
        assertEq(harvest.creatorFeeDestinationOf(address(tok)), 0);
        assertEq(tok.creator(), creator);
        _warpPastSnipe();
        uint256 esc0 = _escrow(address(tok));
        _buy(curve, trader1, BUY, 0);
        (uint256 creatorAmt, uint256 share, uint256 tax, uint256 lpShare) = _owed(BUY, TAX);
        assertGt(share, 0, "33% creator share");
        assertGt(tax, 0, "creator tax");
        assertEq(feeRouter.creatorAccrued(address(tok), creator), creatorAmt, "share plus tax, and nothing else");
        assertEq(_escrow(address(tok)) - esc0, lpShare, "only the protocol LP share moved during the trade");

        uint256 bal0 = quote.balanceOf(creator);
        vm.prank(creator);
        uint256 got = feeRouter.claimCreatorFees(address(tok));
        assertEq(got, creatorAmt);
        assertEq(quote.balanceOf(creator) - bal0, creatorAmt);

        address next = makeAddr("next");
        vm.prank(creator);
        launchpad.transferCreator(address(tok), next);
        assertEq(launchpad.creatorOf(address(tok)), next, "destination 0 still follows the creator role");
    }

    function test_badDestination_reverts() public {
        vm.prank(creator);
        vm.expectRevert(CreatorFeeHarvest.BadDestination.selector);
        harvest.launch(_params(0, 0), 3);
    }

    function test_lockedLp_onCurve_depositsShareAndTax_andIsRenounced() public {
        (BondingCurve curve, Token tok) = _launchDest(1, TAX);
        assertEq(launchpad.creatorOf(address(tok)), creator, "fees still accrue to the launcher");
        assertEq(tok.creator(), creator);
        assertEq(curve.creator(), creator, "First BOOST and Easy lock stay with the launcher");
        assertEq(harvest.creatorFeeDestinationOf(address(tok)), 1);
        _warpPastSnipe();
        uint256 esc0 = _escrow(address(tok));
        _buy(curve, trader1, BUY, 0);
        (uint256 creatorAmt,,, uint256 lpShare) = _owed(BUY, TAX);
        assertEq(feeRouter.creatorAccrued(address(tok), creator), creatorAmt);
        assertEq(_escrow(address(tok)) - esc0, lpShare, "trade path only moved the protocol share");

        harvest.route(address(tok));
        console2.log("ROUTE_GAS dest1 on-curve", vm.lastCallGas().gasTotalUsed);
        assertEq(_escrow(address(tok)) - esc0, lpShare + creatorAmt, "creator fee joined the locked escrow");
        assertEq(feeRouter.creatorAccrued(address(tok), creator), 0);
        assertEq(quote.balanceOf(BURN), 0, "burn destination was not used");
        assertEq(quote.balanceOf(address(harvest)), 0, "route did not keep the fees");

        vm.expectRevert(LockedLP.RemoveLiquidityDisabled.selector);
        lockedLP.removeLiquidity(address(tok), 1);
        vm.prank(creator);
        vm.expectRevert(FeeRouter.NothingToClaim.selector);
        feeRouter.claimCreatorFees(address(tok));
    }

    function test_burnQuote_onCurve_burnsShareAndTax() public {
        (BondingCurve curve, Token tok) = _launchDest(2, TAX);
        assertEq(launchpad.creatorOf(address(tok)), creator);
        _warpPastSnipe();
        uint256 esc0 = _escrow(address(tok));
        _buy(curve, trader1, BUY, 0);
        (uint256 creatorAmt, uint256 share, uint256 tax, uint256 lpShare) = _owed(BUY, TAX);
        uint256 dead0 = quote.balanceOf(BURN);
        (uint256 qAmt, uint256 tAmt, uint256 bought) = harvest.route(address(tok));
        console2.log("ROUTE_GAS dest2 on-curve", vm.lastCallGas().gasTotalUsed);
        assertEq(qAmt, creatorAmt);
        assertEq(tAmt, 0, "on the curve there is no rocket-token fee");
        assertEq(bought, 0, "no buy is invented on the curve");
        assertGt(share, 0);
        assertGt(tax, 0);
        assertEq(quote.balanceOf(BURN) - dead0, share + tax);
        assertEq(_escrow(address(tok)) - esc0, lpShare, "rocket and quote creator fees were not sent to the pool");
        assertEq(tok.balanceOf(address(lockedLP)), 0);
    }

    function test_kolCutStaysWithKol_restOfCreatorFeeBurns() public {
        _bindReferral(creator, kol, 10 ether);
        (BondingCurve curve, Token tok) = _launchDest(2, TAX);
        _warpPastSnipe();
        _buy(curve, trader1, BUY, 0);
        (, uint256 share, uint256 tax,) = _owed(BUY, TAX);
        uint256 kolCut = (share * feeRouter.kolCreatorShareBps()) / 10_000;
        uint256 net = share - kolCut + tax;
        (,,, uint256 referral) = FeeMath.splitTradeFee(FeeMath.protocolFee(BUY));
        assertGt(kolCut, 0);
        uint256 dead0 = quote.balanceOf(BURN);
        harvest.route(address(tok));
        assertEq(quote.balanceOf(BURN) - dead0, net, "the creator fee, after the KOL cut, is burned");
        assertEq(feeRouter.referrerAccrued(kol, address(quote)), kolCut + referral, "KOL keeps its cut and the 1%");
    }

    function test_lockedLp_afterOrbit_depositsBothSides() public {
        (BondingCurve curve, Token tok) = _launchDest(1, 0);
        _graduate(curve);
        _refReady(tok);
        _swapExactInQuoteForToken(tok, trader1, 1 ether);
        uint256 held = tok.balanceOf(trader1);
        _swapExactInTokenForQuote(tok, trader1, held / 2);
        uint256 qAcc = feeRouter.creatorAccrued(address(tok), creator);
        uint256 tAcc = feeRouter.creatorTokenAccrued(address(tok), creator);
        assertGt(qAcc, 0, "quote half after orbit");
        assertGt(tAcc, 0, "rocket-token half after orbit");
        _handOverRockets(tok);
        (uint256 bT0, uint256 bQ0) = lockedLP.compoundBucket(address(tok));
        vm.roll(block.number + 1);
        harvest.route(address(tok));
        console2.log("ROUTE_GAS dest1 after-orbit", vm.lastCallGas().gasTotalUsed);
        (uint256 bT1, uint256 bQ1) = lockedLP.compoundBucket(address(tok));
        assertEq(bT1, bT0 + tAcc, "rocket-token fees joined the locked position's bucket");
        assertEq(bQ1, bQ0 + qAcc, "quote fees joined the locked position's bucket");
        assertEq(tok.balanceOf(address(harvest)), 0);
        vm.expectRevert(LockedLP.RemoveLiquidityDisabled.selector);
        lockedLP.removeLiquidity(address(tok), 1);
    }

    function test_burnQuote_afterOrbit_burnsQuoteHalf_andSellsRocketHalf() public {
        (BondingCurve curve, Token tok) = _launchDest(2, 0);
        _graduate(curve);
        _refReady(tok);
        _swapExactInQuoteForToken(tok, trader1, 1 ether);
        uint256 held = tok.balanceOf(trader1);
        _swapExactInTokenForQuote(tok, trader1, held / 2);
        uint256 qAcc = feeRouter.creatorAccrued(address(tok), creator);
        uint256 tAcc = feeRouter.creatorTokenAccrued(address(tok), creator);
        assertGt(qAcc, 0);
        assertGt(tAcc, 0);
        _handOverRockets(tok);
        uint256 dead0 = quote.balanceOf(BURN);
        uint256 lpTok0 = tok.balanceOf(address(lockedLP));
        (uint256 bT0,) = lockedLP.compoundBucket(address(tok));
        vm.roll(block.number + 1);
        (uint256 qAmt, uint256 tAmt, uint256 bought) = harvest.route(address(tok));
        console2.log("ROUTE_GAS dest2 after-orbit", vm.lastCallGas().gasTotalUsed);
        assertEq(qAmt, qAcc, "quote half burned as quote");
        assertEq(tAmt, tAcc, "rocket-token half was sold, not locked");
        assertGt(bought, 0, "the sale bought more quote");
        assertEq(quote.balanceOf(BURN) - dead0, qAcc + bought);
        assertEq(tok.balanceOf(address(harvest)), 0);
        assertLe(tok.balanceOf(address(lockedLP)), lpTok0, "rocket-token fees were not sent to the pool");
        (uint256 bT1,) = lockedLP.compoundBucket(address(tok));
        assertLe(bT1, bT0, "the rocket-token bucket did not receive the creator fee");
        assertEq(feeRouter.creatorTokenAccrued(address(tok), creator), 0);
        assertEq(feeRouter.creatorAccrued(address(tok), creator), 0);
    }

    function test_twoCoins_keepPathUnchanged() public {
        (BondingCurve keepCurve, Token keepTok) = _launchDest(0, TAX);
        (BondingCurve burnCurve, Token burnTok) = _launchDest(2, TAX);
        _warpPastSnipe();
        _buy(keepCurve, trader1, BUY, 0);
        _buy(burnCurve, trader1, BUY, 0);
        (uint256 creatorAmt,,,) = _owed(BUY, TAX);
        vm.prank(creator);
        assertEq(feeRouter.claimCreatorFees(address(keepTok)), creatorAmt);
        uint256 dead0 = quote.balanceOf(BURN);
        harvest.route(address(burnTok));
        assertEq(quote.balanceOf(BURN) - dead0, creatorAmt);
        vm.prank(creator);
        vm.expectRevert(FeeRouter.NothingToClaim.selector);
        feeRouter.claimCreatorFees(address(burnTok));
    }

    function test_launchWithMode_and_launchWithUsdg_recordChoice_andKeepLauncher() public {
        vm.prank(creator);
        ILaunchpad.LaunchResult memory a = harvest.launchWithMode(_params(0, 0), 0, 2);
        assertEq(harvest.creatorFeeDestinationOf(a.token), 2);
        assertEq(launchpad.creatorOf(a.token), creator);
        assertEq(Token(a.token).creator(), creator);

        router.setUsdgRouting(address(quote), address(launchpad));
        vm.prank(creator);
        (ILaunchpad.LaunchResult memory b,) = harvest.launchWithUsdg(_params(0, 0), 0, 0, 0, 1);
        assertEq(harvest.creatorFeeDestinationOf(b.token), 1);
        assertEq(launchpad.creatorOf(b.token), creator, "the caller stays the launcher");
        assertEq(Token(b.token).creator(), creator);
    }

    function test_anon_keep_stillPaysStealthOwner() public {
        vm.prank(creator);
        ILaunchpad.LaunchResult memory r = harvest.launchAnon(_params(0, 0), stealth, stealth, "", bytes1(0), 0, 0);
        assertEq(launchpad.creatorOf(r.token), address(anon));
        assertEq(harvest.creatorFeeDestinationOf(r.token), 0);
        _warpPastSnipe();
        _buy(BondingCurve(r.curve), trader1, BUY, 0);
        address[] memory toks = new address[](1);
        toks[0] = r.token;
        address to = makeAddr("payout");
        vm.prank(stealth);
        anon.claimMany(toks, to);
        (uint256 creatorAmt,,,) = _owed(BUY, 0);
        assertEq(quote.balanceOf(to), creatorAmt);
    }

    function test_anon_routePullsLauncher_andStealthCannotClaim() public {
        vm.prank(creator);
        ILaunchpad.LaunchResult memory lp = harvest.launchAnon(_params(TAX, 0), stealth, stealth, "", bytes1(0), 0, 1);
        router.setUsdgRouting(address(quote), address(launchpad));
        vm.prank(creator);
        (ILaunchpad.LaunchResult memory burnR,) =
            harvest.launchAnonWithUsdg(_params(TAX, 0), stealth, stealth, "", bytes1(0), 0, 0, 0, 2);

        assertEq(launchpad.creatorOf(lp.token), address(anon), "AnonLauncher stays creatorOf");
        assertEq(Token(lp.token).creator(), address(anon));
        assertEq(launchpad.creatorOf(burnR.token), address(anon));
        assertEq(anon.stealthOwnerOf(lp.token), stealth);
        assertEq(harvest.creatorFeeDestinationOf(lp.token), 1);
        assertEq(harvest.creatorFeeDestinationOf(burnR.token), 2);

        _warpPastSnipe();
        _buy(BondingCurve(lp.curve), trader1, BUY, 0);
        _buy(BondingCurve(burnR.curve), trader1, BUY, 0);
        (uint256 creatorAmt,,,) = _owed(BUY, TAX);
        assertEq(feeRouter.creatorAccrued(lp.token, address(anon)), creatorAmt);

        address[] memory one = new address[](1);
        one[0] = lp.token;
        vm.prank(stealth);
        vm.expectRevert(AnonLauncher.CreatorFeesRouted.selector);
        anon.claimMany(one, stealth);

        uint256 esc0 = _escrow(lp.token);
        harvest.route(lp.token);
        assertEq(_escrow(lp.token) - esc0, creatorAmt, "route pulled AnonLauncher's accrued fees into the pool");

        uint256 dead0 = quote.balanceOf(BURN);
        harvest.route(burnR.token);
        assertEq(quote.balanceOf(BURN) - dead0, creatorAmt);

        uint256 dl = block.timestamp + 1 hours;
        bytes32 sh = keccak256(
            abi.encode(
                anon.METADATA_TYPEHASH(),
                lp.token,
                keccak256("ipfs://private"),
                keccak256("hidden"),
                keccak256(""),
                anon.nonces(stealth),
                dl
            )
        );
        (uint8 v, bytes32 rr, bytes32 s) =
            vm.sign(sk, keccak256(abi.encodePacked("\x19\x01", anon.domainSeparator(), sh)));
        anon.updateMetadataBySig(lp.token, "ipfs://private", "hidden", "", dl, abi.encodePacked(rr, s, v));
        (,, string memory img, string memory desc,,,,) = launchpad.metaOf(lp.token);
        assertEq(img, "ipfs://private");
        assertEq(desc, "hidden");
    }
}
