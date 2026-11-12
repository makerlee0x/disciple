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
import {Launchpad} from "../src/Launchpad.sol";
import {LockedLP} from "../src/LockedLP.sol";
import {LoginGate} from "../src/LoginGate.sol";
import {Constants} from "../src/libraries/Constants.sol";
import {CurveFeeVault} from "../src/CurveFeeVault.sol";
import {CurveDeployer} from "../src/CurveDeployer.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Creator-fee destinations. Trades still pay the launcher. `route` runs later.
contract CreatorFeeRoutingTest is IntegrationBase {
    using PoolIdLibrary for PoolKey;
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
        // Trusting the harvest leaves curveRouter on DiscipleRouter.
        assertEq(launchpad.curveRouter(), address(router));
        feeRouter.setClaimRouter(address(harvest), true);
        feeRouter.setCreatorFeeHarvest_51(address(harvest));
        harvest.setFeeVault(address(feeVault));
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

    /// @dev Curve-phase quote sits on the vault (settled or still owed). Post-graduation quote sits on FeeRouter.
    function _quoteOwed(address token, address who) internal view returns (uint256) {
        return feeVault.creatorClaimable(token, who) + feeRouter.creatorAccrued(token, who);
    }

    function _expectRouted(address token, address who) internal {
        vm.startPrank(who);
        vm.expectRevert(FeeRouter.CreatorFeesRouted.selector);
        feeRouter.claimCreatorFees(token);
        vm.expectRevert(FeeRouter.CreatorFeesRouted.selector);
        feeRouter.claimCreatorTokenFees(token);
        vm.expectRevert(CurveFeeVault.CreatorFeesRouted.selector);
        feeVault.claimCreatorFees(token);
        vm.stopPrank();
    }

    /// @dev Private coins claim curve fees from a vault that knows the AnonLauncher. Point new launches at one.
    function _pointVaultAtAnon() internal {
        CurveFeeVault v = new CurveFeeVault(address(feeRouter), address(anon));
        vm.startPrank(owner);
        launchpad.setCurveDeployer(address(new CurveDeployer(address(v))));
        harvest.setFeeVault(address(v));
        vm.stopPrank();
        feeVault = v;
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
        assertEq(feeVault.creatorClaimable(address(tok), creator), creatorAmt, "share plus tax, and nothing else");
        assertEq(feeRouter.creatorAccrued(address(tok), creator), 0, "curve fees settle to the vault");
        assertEq(_escrow(address(tok)), esc0, "the trade leaves the LP share owed on the curve");
        assertEq(curve.lpFeeEscrow(), 0);

        uint256 bal0 = quote.balanceOf(creator);
        vm.prank(creator);
        uint256 got = feeVault.claimCreatorFees(address(tok));
        assertEq(got, creatorAmt);
        assertEq(quote.balanceOf(creator) - bal0, creatorAmt);
        assertEq(curve.lpFeeEscrow(), lpShare, "settling keeps the protocol LP share on the curve");

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
        assertEq(_quoteOwed(address(tok), creator), creatorAmt);
        assertEq(_escrow(address(tok)), esc0, "the trade did not lock the creator fee");
        _expectRouted(address(tok), creator);

        harvest.route(address(tok));
        console2.log("ROUTE_GAS dest1 on-curve", vm.lastCallGas().gasTotalUsed);
        assertEq(_escrow(address(tok)) - esc0, creatorAmt, "creator fee joined the locked escrow");
        assertEq(curve.lpFeeEscrow(), lpShare, "the protocol LP share stayed on the curve");
        assertEq(feeRouter.creatorAccrued(address(tok), creator), 0);
        assertEq(quote.balanceOf(BURN), 0, "burn destination was not used");
        assertEq(quote.balanceOf(address(harvest)), 0, "route did not keep the fees");

        vm.expectRevert(LockedLP.RemoveLiquidityDisabled.selector);
        lockedLP.removeLiquidity(address(tok), 1);
        _expectRouted(address(tok), creator);
    }

    function test_burnQuote_onCurve_burnsShareAndTax() public {
        (BondingCurve curve, Token tok) = _launchDest(2, TAX);
        assertEq(launchpad.creatorOf(address(tok)), creator);
        _warpPastSnipe();
        uint256 esc0 = _escrow(address(tok));
        _buy(curve, trader1, BUY, 0);
        (uint256 creatorAmt, uint256 share, uint256 tax, uint256 lpShare) = _owed(BUY, TAX);
        _expectRouted(address(tok), creator);
        router.setUsdgRouting(address(quote), address(launchpad));
        vm.prank(creator);
        vm.expectRevert(FeeRouter.CreatorFeesRouted.selector);
        router.claimCreatorFeesToUsdg(address(tok), 1);
        uint256 dead0 = quote.balanceOf(BURN);
        (uint256 qAmt, uint256 tAmt, uint256 bought) = harvest.route(address(tok));
        console2.log("ROUTE_GAS dest2 on-curve", vm.lastCallGas().gasTotalUsed);
        assertEq(qAmt, creatorAmt);
        assertEq(tAmt, 0, "on the curve there is no rocket-token fee");
        assertEq(bought, 0, "no buy is invented on the curve");
        assertGt(share, 0);
        assertGt(tax, 0);
        assertEq(quote.balanceOf(BURN) - dead0, share + tax);
        assertEq(_escrow(address(tok)), esc0, "creator fees were not sent to the pool");
        assertEq(curve.lpFeeEscrow(), lpShare, "the protocol LP share stayed on the curve");
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
        assertEq(feeVault.referrerAccrued(kol, address(quote)), kolCut + referral, "KOL keeps its cut and the 1%");
    }

    function test_lockedLp_afterOrbit_depositsBothSides() public {
        (BondingCurve curve, Token tok) = _launchDest(1, 0);
        _graduate(curve);
        _refReady(tok);
        _swapExactInQuoteForToken(tok, trader1, 1 ether);
        uint256 held = tok.balanceOf(trader1);
        _swapExactInTokenForQuote(tok, trader1, held / 2);
        uint256 qAcc = _quoteOwed(address(tok), creator);
        uint256 tAcc = feeRouter.creatorTokenAccrued(address(tok), creator);
        assertGt(feeRouter.creatorAccrued(address(tok), creator), 0, "quote half after orbit");
        assertGt(feeVault.creatorAccrued(address(tok), creator), 0, "curve-phase quote is on the vault");
        assertGt(tAcc, 0, "rocket-token half after orbit");
        _expectRouted(address(tok), creator);
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
        uint256 qAcc = _quoteOwed(address(tok), creator);
        uint256 tAcc = feeRouter.creatorTokenAccrued(address(tok), creator);
        assertGt(qAcc, 0);
        assertGt(tAcc, 0);
        _expectRouted(address(tok), creator);
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
        assertEq(feeVault.claimCreatorFees(address(keepTok)), creatorAmt);
        uint256 dead0 = quote.balanceOf(BURN);
        harvest.route(address(burnTok));
        assertEq(quote.balanceOf(BURN) - dead0, creatorAmt);
        _expectRouted(address(burnTok), creator);
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
        _pointVaultAtAnon();
        vm.prank(creator);
        ILaunchpad.LaunchResult memory r = harvest.launchAnon(_params(0, 0), stealth, stealth, "", bytes1(0), 0, 0);
        assertEq(launchpad.creatorOf(r.token), address(anon));
        assertEq(harvest.creatorFeeDestinationOf(r.token), 0);
        _warpPastSnipe();
        _buy(BondingCurve(r.curve), trader1, BUY, 0);
        address to = makeAddr("payout");
        vm.prank(stealth);
        feeVault.claimCreatorFeesAsStealth(r.token, to);
        (uint256 creatorAmt,,,) = _owed(BUY, 0);
        assertEq(quote.balanceOf(to), creatorAmt);
    }

    function test_anon_routePullsLauncher_andStealthCannotClaim() public {
        _pointVaultAtAnon();
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
        assertEq(_quoteOwed(lp.token, address(anon)), creatorAmt);

        address[] memory one = new address[](1);
        one[0] = lp.token;
        vm.prank(stealth);
        vm.expectRevert(AnonLauncher.CreatorFeesRouted.selector);
        anon.claimMany(one, stealth);
        vm.prank(stealth);
        vm.expectRevert(CurveFeeVault.CreatorFeesRouted.selector);
        feeVault.claimCreatorFeesAsStealth(lp.token, stealth);

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

    function test_transferCreator_routedFees_followCurrentCreator_andCannotBeClaimed() public {
        (BondingCurve curve, Token tok) = _launchDest(1, TAX);
        _warpPastSnipe();
        _buy(curve, trader1, BUY, 0);
        curve.settleFees();
        (uint256 first,,,) = _owed(BUY, TAX);
        assertEq(
            feeVault.creatorAccrued(address(tok), creator), first, "settled curve fees stay with the creator of record"
        );
        address next = makeAddr("next");
        vm.prank(creator);
        launchpad.transferCreator(address(tok), next);
        assertEq(launchpad.creatorOf(address(tok)), next);
        assertEq(harvest.creatorFeeDestinationOf(address(tok)), 1, "the choice stays on the coin");
        _expectRouted(address(tok), creator);
        _expectRouted(address(tok), next);
        _buy(curve, trader1, BUY, 0);
        (uint256 second,,,) = _owed(BUY, TAX);
        assertEq(feeVault.creatorClaimable(address(tok), next), second, "later fees follow the current creator");
        assertEq(feeVault.creatorAccrued(address(tok), creator), first);
        uint256 esc0 = _escrow(address(tok));
        harvest.route(address(tok));
        assertEq(_escrow(address(tok)) - esc0, first + second, "route pulled the original launcher and the new creator");
        assertEq(feeRouter.creatorAccrued(address(tok), creator), 0);
        assertEq(feeRouter.creatorAccrued(address(tok), next), 0);
    }

    function test_anon_afterOrbit_routePullsBothHalves() public {
        _pointVaultAtAnon();
        vm.prank(creator);
        ILaunchpad.LaunchResult memory locked = harvest.launchAnon(_params(0, 0), stealth, stealth, "", bytes1(0), 0, 1);
        vm.prank(creator);
        ILaunchpad.LaunchResult memory burned = harvest.launchAnon(_params(0, 0), stealth, stealth, "", bytes1(0), 0, 2);
        _orbit(BondingCurve(locked.curve), Token(locked.token));
        _orbit(BondingCurve(burned.curve), Token(burned.token));

        uint256 qL = _quoteOwed(locked.token, address(anon));
        uint256 tL = feeRouter.creatorTokenAccrued(locked.token, address(anon));
        uint256 qB = _quoteOwed(burned.token, address(anon));
        uint256 tB = feeRouter.creatorTokenAccrued(burned.token, address(anon));
        assertGt(feeVault.creatorAccrued(locked.token, address(anon)), 0, "curve-phase quote is on the vault");
        assertGt(qL, 0);
        assertGt(tL, 0);
        assertGt(qB, 0);
        assertGt(tB, 0);

        address[] memory one = new address[](1);
        one[0] = locked.token;
        vm.prank(stealth);
        vm.expectRevert(AnonLauncher.CreatorFeesRouted.selector);
        anon.claimMany(one, stealth);
        one[0] = burned.token;
        vm.prank(stealth);
        vm.expectRevert(AnonLauncher.CreatorFeesRouted.selector);
        anon.claimMany(one, stealth);
        vm.prank(stealth);
        vm.expectRevert(CurveFeeVault.CreatorFeesRouted.selector);
        feeVault.claimCreatorFeesAsStealth(burned.token, stealth);

        (uint256 bT0, uint256 bQ0) = lockedLP.compoundBucket(locked.token);
        vm.roll(block.number + 1);
        harvest.route(locked.token);
        (uint256 bT1, uint256 bQ1) = lockedLP.compoundBucket(locked.token);
        assertEq(bT1, bT0 + tL, "private dest 1 locked the rocket-token half");
        assertEq(bQ1, bQ0 + qL, "private dest 1 locked the quote half");

        uint256 dead0 = quote.balanceOf(BURN);
        vm.roll(block.number + 1);
        (uint256 qAmt, uint256 tAmt, uint256 bought) = harvest.route(burned.token);
        assertEq(qAmt, qB);
        assertEq(tAmt, tB);
        assertGt(bought, 0);
        assertEq(quote.balanceOf(BURN) - dead0, qB + bought);
        assertEq(feeRouter.creatorTokenAccrued(burned.token, address(anon)), 0);
    }

    function test_crewTip_stillGoesToHolders() public {
        uint256 attesterPk = 0xA11CE;
        LoginGate gate = new LoginGate(owner, vm.addr(attesterPk));
        vm.startPrank(owner);
        launchpad.setLoginGate(address(gate));
        launchpad.setCrewTipThresholdBps(Constants.CREW_TIP_THRESHOLD_BPS_MIN);
        vm.stopPrank();

        vm.prank(creator);
        ILaunchpad.LaunchResult memory r = harvest.launchWithMode(_params(0, 0), Constants.MODE_PVE, 2);
        BondingCurve curve = BondingCurve(r.curve);
        Token tok = Token(r.token);
        _attest(gate, attesterPk, trader1);
        _attest(gate, attesterPk, trader2);
        _warpPastSnipe();
        uint256 slice = Constants.TOTAL_SUPPLY / 100 * 8 / 10; // 0.8% of supply, under the 1% wallet cap
        _buy(curve, trader1, _quoteFor(curve, slice), 0);
        _buy(curve, trader2, _quoteFor(curve, slice), 0);
        uint256 sellAmt = Constants.TOTAL_SUPPLY / 100 * 4 / 10;
        for (uint256 i; i < 70 && curve.quoteSellFor(trader1, sellAmt).profitTax == 0; ++i) {
            address w = address(uint160(0xC000 + i));
            quote.mint(w, 1_000_000 ether);
            _attest(gate, attesterPk, w);
            _buy(curve, w, _quoteFor(curve, Constants.TOTAL_SUPPLY / 100 * 9 / 10), 0);
        }
        BondingCurve.SellQuote memory sq = curve.quoteSellFor(trader1, sellAmt);
        assertGt(sq.profitTax, 0, "the crew tip still applies on a profitable sell");
        assertEq(sq.profitTax, (sq.quoteOut + sq.profitTax) * Constants.PVE_CREW_TIP_PPM / 1e6);
        vm.startPrank(trader1);
        tok.approve(address(curve), sellAmt);
        curve.sell(sellAmt, 0, block.timestamp + 1 hours);
        vm.stopPrank();
        assertGt(curve.pendingRewards(trader2), 0, "the other holder still receives the crew tip");
        uint256 tip = curve.pendingRewards(trader2);
        uint256 dead0 = quote.balanceOf(BURN);
        uint256 creatorAmt = _quoteOwed(address(tok), creator);
        harvest.route(address(tok));
        assertEq(quote.balanceOf(BURN) - dead0, creatorAmt, "routing burned creator fees and left the crew tip");
        assertEq(curve.pendingRewards(trader2), tip, "route did not touch holder rewards");
    }

    function test_setTrustedRouter_doesNotMoveCurveRouter() public {
        address current = launchpad.curveRouter();
        assertEq(current, address(router));
        address helper = makeAddr("helperRouter");
        vm.prank(owner);
        launchpad.setTrustedRouter(helper, true);
        assertEq(launchpad.curveRouter(), current, "trusting another router must not move the default");
        assertTrue(launchpad.isTrustedRouter(helper));

        address rogue = makeAddr("untrustedRouter");
        vm.prank(owner);
        vm.expectRevert(Launchpad.NotRouter.selector);
        launchpad.setCurveRouter(rogue);

        vm.prank(owner);
        launchpad.setCurveRouter(helper);
        assertEq(launchpad.curveRouter(), helper);

        vm.prank(owner);
        launchpad.setTrustedRouter(helper, false);
        assertEq(launchpad.curveRouter(), address(0), "untrusting the default clears it");
    }

    function test_routeFrom_pullsIntermediateCreator() public {
        (BondingCurve curve, Token tok) = _launchDest(1, TAX);
        _warpPastSnipe();
        _buy(curve, trader1, BUY, 0);
        curve.settleFees();
        (uint256 first,,,) = _owed(BUY, TAX);
        address mid = makeAddr("mid");
        address last = makeAddr("last");
        vm.prank(creator);
        launchpad.transferCreator(address(tok), mid);
        _buy(curve, trader1, BUY, 0);
        curve.settleFees();
        (uint256 second,,,) = _owed(BUY, TAX);
        assertEq(feeVault.creatorClaimable(address(tok), mid), second);
        vm.prank(mid);
        launchpad.transferCreator(address(tok), last);
        _buy(curve, trader1, BUY, 0);
        curve.settleFees();
        (uint256 third,,,) = _owed(BUY, TAX);
        assertEq(feeVault.creatorClaimable(address(tok), last), third);

        uint256 esc0 = _escrow(address(tok));
        harvest.route(address(tok));
        assertEq(_escrow(address(tok)) - esc0, first + third, "route pulls the launcher and the current creator only");
        assertEq(feeVault.creatorClaimable(address(tok), mid), second, "the mid creator is still sitting on the vault");

        address[] memory past = new address[](1);
        past[0] = mid;
        harvest.routeFrom(address(tok), past);
        assertEq(_escrow(address(tok)) - esc0, first + second + third, "routeFrom sends the mid creator's fees to the same dest");
        assertEq(feeVault.creatorClaimable(address(tok), mid), 0);
        assertEq(feeVault.creatorClaimable(address(tok), creator), 0);
        assertEq(feeVault.creatorClaimable(address(tok), last), 0);
    }

    function test_lockedLp_refusesTokenDepositBeforeGraduation() public {
        (, Token tok) = _launchDest(1, 0);
        deal(address(tok), address(harvest), 1 ether);
        deal(address(quote), address(harvest), 2 ether);
        vm.startPrank(address(harvest));
        tok.approve(address(lockedLP), 1 ether);
        quote.approve(address(lockedLP), 2 ether);
        vm.expectRevert(LockedLP.NotGraduated.selector);
        lockedLP.depositCreatorFees_57(address(tok), address(quote), 1 ether, 0);
        vm.expectRevert(LockedLP.NotGraduated.selector);
        lockedLP.depositCreatorFees_57(address(tok), address(quote), 1 ether, 1 ether);
        uint256 esc0 = _escrow(address(tok));
        lockedLP.depositCreatorFees_57(address(tok), address(quote), 0, 1 ether);
        vm.stopPrank();
        assertEq(_escrow(address(tok)) - esc0, 1 ether, "quote still escrows before graduation");
        assertEq(tok.balanceOf(address(harvest)), 1 ether, "the rocket tokens stayed with the harvest");
    }

    // ───────── creator role moves any number of times; middle creators' fees still reach the destination ─────────

    /// @dev A -> B -> C -> D with settled fees booked to A, B and C. `route` reaches A and D; `routeFrom` reaches B
    ///      and C. No transfer is blocked by unclaimed fees, and nobody can self-claim a routed coin.
    function _chain(uint8 dest)
        internal
        returns (Token tok, address b, address c, address d, uint256 feeA, uint256 feeB, uint256 feeC)
    {
        BondingCurve curve;
        (curve, tok) = _launchDest(dest, TAX);
        _warpPastSnipe();
        b = makeAddr("creatorB");
        c = makeAddr("creatorC");
        d = makeAddr("creatorD");
        _buy(curve, trader1, BUY, 0);
        curve.settleFees();
        feeA = feeVault.creatorAccrued(address(tok), creator);
        vm.prank(creator);
        launchpad.transferCreator(address(tok), b);
        _buy(curve, trader1, BUY, 0);
        curve.settleFees();
        feeB = feeVault.creatorAccrued(address(tok), b);
        vm.prank(b);
        launchpad.transferCreator(address(tok), c);
        _buy(curve, trader1, BUY, 0);
        curve.settleFees();
        feeC = feeVault.creatorAccrued(address(tok), c);
        vm.prank(c);
        launchpad.transferCreator(address(tok), d);
        assertEq(launchpad.creatorOf(address(tok)), d, "three transfers, none blocked by unclaimed fees");
        assertGt(feeA, 0);
        assertGt(feeB, 0);
        assertGt(feeC, 0);
        _expectRouted(address(tok), b);
        _expectRouted(address(tok), c);
    }

    function test_lockedLp_middleCreators_routeFrom_reachesThem() public {
        (Token tok, address b, address c,, uint256 feeA, uint256 feeB, uint256 feeC) = _chain(1);
        uint256 esc0 = _escrow(address(tok));
        harvest.route(address(tok));
        assertEq(_escrow(address(tok)) - esc0, feeA, "route pulls the launcher and the current creator only");
        assertEq(feeVault.creatorAccrued(address(tok), b), feeB, "middle creator still owed");
        assertEq(feeVault.creatorAccrued(address(tok), c), feeC, "middle creator still owed");

        address[] memory past = new address[](4);
        past[0] = b;
        past[1] = c;
        past[2] = b; // repeats and unknown addresses are skipped
        past[3] = makeAddr("stranger");
        address keeper = makeAddr("keeper");
        vm.prank(keeper);
        (uint256 q,,) = harvest.routeFrom(address(tok), past);
        assertEq(q, feeB + feeC);
        assertEq(_escrow(address(tok)) - esc0, feeA + feeB + feeC, "every creator's fees joined the locked escrow");
        assertEq(feeVault.creatorAccrued(address(tok), b), 0);
        assertEq(feeVault.creatorAccrued(address(tok), c), 0);
        assertEq(quote.balanceOf(keeper), 0, "caller is paid nothing");
        assertEq(quote.balanceOf(address(harvest)), 0);
        vm.expectRevert(CreatorFeeHarvest.NothingToRoute.selector);
        harvest.routeFrom(address(tok), past);
    }

    function test_burn_middleCreators_routeFrom_burnsThem() public {
        (Token tok, address b, address c,, uint256 feeA, uint256 feeB, uint256 feeC) = _chain(2);
        uint256 burned0 = quote.balanceOf(BURN);
        address[] memory past = new address[](2);
        past[0] = b;
        past[1] = c;
        harvest.routeFrom(address(tok), past);
        assertEq(quote.balanceOf(BURN) - burned0, feeA + feeB + feeC, "launcher, middle and current creators burned");
        assertEq(feeVault.creatorAccrued(address(tok), b), 0);
        assertEq(feeVault.creatorAccrued(address(tok), c), 0);
    }

    function test_keepFees_transfersStillUnrestricted() public {
        (BondingCurve curve, Token tok) = _launchDest(0, TAX);
        _warpPastSnipe();
        _buy(curve, trader1, BUY, 0);
        curve.settleFees();
        address b = makeAddr("creatorB");
        vm.prank(creator);
        launchpad.transferCreator(address(tok), b);
        vm.prank(b);
        launchpad.transferCreator(address(tok), creator);
        vm.prank(creator);
        launchpad.transferCreator(address(tok), b);
        uint256 owed = feeVault.creatorAccrued(address(tok), creator);
        assertGt(owed, 0);
        vm.prank(creator);
        assertEq(feeVault.claimCreatorFees(address(tok)), owed, "past creator of a keep-fees coin claims any time");
    }

    // ───────── rocket tokens wait for graduation on locked-pool coins ─────────

    function test_lockedLp_preGraduationRocketDeposit_waitsForOrbit_thenJoinsBucket() public {
        (BondingCurve curve, Token tok) = _launchDest(1, TAX);
        _warpPastSnipe();
        _buy(curve, creator, BUY, 0);
        uint256 rockets = tok.balanceOf(creator) / 2;
        vm.startPrank(creator);
        IERC20(address(tok)).approve(address(harvest), rockets);
        harvest.depositRocketTokens(address(tok), rockets);
        vm.stopPrank();
        (,, uint256 posTok0,,,,) = lockedLP.positions(address(tok));

        uint256 esc0 = _escrow(address(tok));
        (uint256 q, uint256 r,) = harvest.route(address(tok));
        assertGt(q, 0, "quote fees still lock before graduation");
        assertEq(r, 0, "rocket side not deposited before graduation");
        assertEq(_escrow(address(tok)) - esc0, q);
        assertEq(harvest.rocketDeposited(address(tok)), rockets, "rockets parked on the harvest");
        assertEq(tok.balanceOf(address(harvest)), rockets);
        (,, uint256 posTok1,,,,) = lockedLP.positions(address(tok));
        assertEq(posTok1, posTok0, "no token-side credit the graduation seed would overwrite");
        vm.expectRevert(CreatorFeeHarvest.AwaitingOrbit.selector);
        harvest.route(address(tok));

        _graduate(curve);
        (uint256 bT0,) = lockedLP.compoundBucket(address(tok));
        (, uint256 r2,) = harvest.route(address(tok));
        assertEq(r2, rockets);
        (uint256 bT1,) = lockedLP.compoundBucket(address(tok));
        assertEq(bT1 - bT0, rockets, "parked rockets joined the locked position after graduation");
        assertEq(harvest.rocketDeposited(address(tok)), 0);
        assertEq(tok.balanceOf(address(harvest)), 0);
    }

    function test_lockedLP_refusesTokenSideBeforeGraduation_acceptsQuote() public {
        (BondingCurve curve, Token tok) = _launchDest(1, 0);
        vm.prank(address(harvest));
        vm.expectRevert(LockedLP.NotGraduated.selector);
        lockedLP.depositCreatorFees_57(address(tok), address(quote), 1, 0);
        quote.mint(address(harvest), 1 ether);
        uint256 esc0 = _escrow(address(tok));
        vm.startPrank(address(harvest));
        quote.approve(address(lockedLP), 1 ether);
        lockedLP.depositCreatorFees_57(address(tok), address(quote), 0, 1 ether);
        vm.stopPrank();
        assertEq(_escrow(address(tok)) - esc0, 1 ether, "quote-side escrow still allowed");
        curve; // silence
    }

    // ───────── default curve router stays on DiscipleRouter ─────────

    function test_trustingRouters_neverMovesCurveRouter() public {
        assertEq(launchpad.curveRouter(), address(router));
        address rogue = makeAddr("rogueRouter");
        vm.startPrank(owner);
        launchpad.setTrustedRouter(rogue, true);
        launchpad.setTrustedRouter(address(harvest), true);
        assertEq(launchpad.curveRouter(), address(router), "trusting other routers leaves the default alone");
        launchpad.setTrustedRouter(rogue, false);
        assertEq(launchpad.curveRouter(), address(router), "untrusting another router leaves the default alone");
        vm.expectRevert(Launchpad.NotRouter.selector);
        launchpad.setCurveRouter(rogue);
        launchpad.setCurveRouter(address(harvest));
        assertEq(launchpad.curveRouter(), address(harvest), "explicit setter moves it");
        launchpad.setCurveRouter(address(router));
        launchpad.setTrustedRouter(address(router), false);
        assertEq(launchpad.curveRouter(), address(0), "untrusting the default clears it (fails closed)");
        vm.stopPrank();
        vm.prank(creator);
        vm.expectRevert();
        launchpad.setCurveRouter(address(router));
    }

    function test_anonUsdgLaunch_survivesHarvestReTrust() public {
        vm.prank(owner);
        launchpad.setTrustedRouter(address(harvest), true);
        router.setUsdgRouting(address(quote), address(launchpad));
        quote.mint(creator, 10 ether);
        vm.startPrank(creator);
        quote.approve(address(anon), type(uint256).max);
        ILaunchpad.LaunchParams memory p = _params(0, 0);
        (ILaunchpad.LaunchResult memory r,) = anon.launchAnonWithUsdg(p, stealth, stealth, "", 0x00, 0, 1 ether, 1, creator);
        vm.stopPrank();
        assertEq(BondingCurve(r.curve).trustedRouter(), address(router), "new curve snapshots DiscipleRouter");
    }

    // ───────── hook fee path: take onto the hook, collect later ─────────

    function _pending(Token tok, address feeToken) internal view returns (uint256) {
        return hook.pendingFee(_poolKey(tok).toId(), feeToken, address(swapRouter));
    }

    function test_hook_swapTakesFeeOntoHook_collectBooksSameSplit() public {
        (BondingCurve curve, Token tok) = _launchDest(0, 0);
        _graduate(curve);
        _refReady(tok);
        autoCollectHookFees = false;
        uint256 qAcc0 = feeRouter.creatorAccrued(address(tok), creator);
        uint256 tAcc0 = feeRouter.creatorTokenAccrued(address(tok), creator); // _refReady's swaps, already collected
        _swapExactInQuoteForToken(tok, trader1, 1 ether);
        uint256 held = tok.balanceOf(trader1);
        _swapExactInTokenForQuote(tok, trader1, held / 2);
        uint256 pT = _pending(tok, address(tok));
        uint256 pQ = _pending(tok, address(quote));
        assertGt(pT, 0, "buy fee (token side) held on the hook");
        assertGt(pQ, 0, "sell fee (quote side) held on the hook");
        assertEq(tok.balanceOf(address(hook)), pT);
        assertEq(quote.balanceOf(address(hook)), pQ);
        assertEq(feeRouter.creatorAccrued(address(tok), creator), qAcc0, "FeeRouter untouched during the swap");
        assertEq(feeRouter.creatorTokenAccrued(address(tok), creator), tAcc0);

        (uint256 share,,,) = FeeMath.splitTradeFee(pQ);
        (uint256 tShare,,,) = FeeMath.splitTradeFee(pT);
        address[] memory ts = new address[](1);
        ts[0] = address(swapRouter);
        vm.prank(makeAddr("keeper"));
        (uint256 cT, uint256 cQ) = hook.collectFees(_poolKey(tok), ts);
        assertEq(cT, pT);
        assertEq(cQ, pQ);
        assertEq(feeRouter.creatorAccrued(address(tok), creator) - qAcc0, share, "official 33% creator share");
        assertEq(feeRouter.creatorTokenAccrued(address(tok), creator) - tAcc0, tShare);
        assertEq(_pending(tok, address(tok)), 0);
        assertEq(_pending(tok, address(quote)), 0);
        assertEq(tok.balanceOf(address(hook)), 0);
        assertEq(quote.balanceOf(address(hook)), 0);
        PoolKey memory key = _poolKey(tok);
        vm.expectRevert();
        hook.collectFees(key, ts);
    }

    function test_hook_swapsKeepTrading_whenFeeRouterReverts() public {
        (BondingCurve curve, Token tok) = _launchDest(0, 0);
        _graduate(curve);
        _refReady(tok);
        autoCollectHookFees = false;
        vm.mockCallRevert(address(feeRouter), abi.encodeWithSelector(FeeRouter.routeHookFee.selector), "router down");
        _swapExactInQuoteForToken(tok, trader1, 1 ether);
        _swapExactInTokenForQuote(tok, trader1, tok.balanceOf(trader1) / 2);
        uint256 pQ = _pending(tok, address(quote));
        assertGt(pQ, 0, "swaps completed and the fee is held");
        address[] memory ts = new address[](1);
        ts[0] = address(swapRouter);
        PoolKey memory key = _poolKey(tok);
        vm.expectRevert();
        hook.collectFees(key, ts);
        assertEq(_pending(tok, address(quote)), pQ, "a failed collect keeps the fee pending");
        vm.clearMockedCalls();
        hook.collectFees(key, ts);
        assertEq(_pending(tok, address(quote)), 0);
    }

    function test_collectAndRoute_isPublic_locksPostGraduationFees() public {
        (BondingCurve curve, Token tok) = _launchDest(1, 0);
        _graduate(curve);
        _refReady(tok);
        autoCollectHookFees = false;
        _swapExactInQuoteForToken(tok, trader1, 1 ether);
        _swapExactInTokenForQuote(tok, trader1, tok.balanceOf(trader1) / 2);
        uint256 pT = _pending(tok, address(tok));
        (uint256 tShare,,,) = FeeMath.splitTradeFee(pT);
        assertGt(tShare, 0);
        uint256 tAcc0 = feeRouter.creatorTokenAccrued(address(tok), creator); // _refReady's swaps, already collected
        (uint256 bT0,) = lockedLP.compoundBucket(address(tok));
        address[] memory ts = new address[](1);
        ts[0] = address(swapRouter);
        vm.roll(block.number + 1);
        vm.prank(makeAddr("keeper")); // no role needed
        (, uint256 r,) = harvest.collectAndRoute(address(tok), ts, new address[](0));
        assertEq(r, tShare + tAcc0, "creator's rocket share went to the locked position");
        (uint256 bT1,) = lockedLP.compoundBucket(address(tok));
        assertGe(bT1 - bT0, tShare + tAcc0);
        assertEq(_pending(tok, address(tok)), 0);
        assertEq(feeRouter.creatorTokenAccrued(address(tok), creator), 0);
    }

    function _orbit(BondingCurve curve, Token tok) internal {

        _graduate(curve);
        _refReady(tok);
        _swapExactInQuoteForToken(tok, trader1, 1 ether);
        uint256 held = tok.balanceOf(trader1);
        _swapExactInTokenForQuote(tok, trader1, held / 2);
    }

    function _attest(LoginGate gate, uint256 pk, address w) internal {
        uint64 exp = uint64(block.timestamp + 12 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, gate.digest(w, exp));
        gate.attest(w, exp, abi.encodePacked(r, s, v));
    }

    function _quoteFor(BondingCurve c, uint256 tokens) internal view returns (uint256 q) {
        q = 1 ether;
        while (c.quoteBuy(q).tokensOut < tokens) q = q * 2;
        uint256 lo = q / 2;
        uint256 hi = q;
        for (uint256 i; i < 40; ++i) {
            uint256 mid = (lo + hi) / 2;
            if (c.quoteBuy(mid).tokensOut <= tokens) lo = mid;
            else hi = mid;
        }
        return lo;
    }
}
