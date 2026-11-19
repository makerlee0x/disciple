// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IntegrationBase} from "./integration/IntegrationBase.sol";
import {CreatorFeeHarvest} from "../src/addons/CreatorFeeHarvest.sol";
import {AnonLauncher} from "../src/addons/AnonLauncher.sol";
import {Token} from "../src/Token.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {ILaunchpad} from "../src/interfaces/ILaunchpad.sol";
import {CurveFeeVault} from "../src/CurveFeeVault.sol";
import {CurveDeployer} from "../src/CurveDeployer.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {stdStorage, StdStorage} from "forge-std/Test.sol";

/// @notice "Pays to" (maker 2026-11-19): a coin's creator picks the wallet its creator fees go to. Only the current
///         creator sets it, a new creator starts with no pick, and it covers curve (CurveFeeVault) and pool (hook)
///         claims. Private coins: the stealth owner picks by signature on AnonLauncher.
contract CreatorPayeeTest is IntegrationBase {
    using stdStorage for StdStorage;
    uint256 internal constant BUY = 100 ether;

    AnonLauncher internal anon;
    address internal payee = makeAddr("payee");
    address internal bot = makeAddr("bot");
    address internal stealth;
    uint256 internal sk;

    function setUp() public override {
        super.setUp();
        anon = new AnonLauncher(owner, address(launchpad), address(feeRouter), address(quote), address(0));
        // curve-phase fees of private coins sit on a vault that knows the AnonLauncher
        CurveFeeVault v = new CurveFeeVault(address(feeRouter), address(anon));
        vm.startPrank(owner);
        vm.store(address(launchpad), bytes32(uint256(5)), bytes32(0)); // test-only: the deployer is write-once
        launchpad.setCurveDeployer(address(new CurveDeployer(address(v))));
        harvest.wire(address(launchpad), address(feeRouter), address(lockedLP), address(router), address(manager));
        feeRouter.setClaimRouter(address(harvest), true);
        feeRouter.setCreatorFeeHarvest_51(address(harvest));
        harvest.setFeeVault(address(v));
        harvest.setAnonLauncher(address(anon));
        anon.setCreatorFeeHarvest(address(harvest));
        anon.setHook(address(hook));
        vm.stopPrank();
        feeVault = v;
        (stealth, sk) = makeAddrAndKey("stealth");
    }

    function _params() internal view returns (ILaunchpad.LaunchParams memory) {
        return ILaunchpad.LaunchParams({
            name: "PayCoin",
            ticker: "PAY",
            imageURI: "ipfs://img",
            description: "",
            socialsURI: "",
            quote: address(quote),
            creatorTaxBps: 0,
            creatorBuyQuoteIn: 0,
            creatorBuyMinTokensOut: 0,
            deadline: block.timestamp + 1 days
        });
    }

    function _orbitAndTrade(BondingCurve c, Token tok) internal {
        _graduate(c);
        _swapExactInQuoteForToken(tok, trader1, 200 * U);
        _swapExactInTokenForQuote(tok, trader1, tok.balanceOf(trader1) / 2);
    }

    function _setPayee(address token, address who, address to) internal {
        vm.prank(who);
        harvest.setCreatorFeeRecipient(token, to);
    }

    // ── public coins ──────────────────────────────────────────────────────

    function test_curveAndPoolClaims_payThePick() public {
        (BondingCurve c, Token tok) = _launch(0, 0);
        _setPayee(address(tok), creator, payee);
        assertEq(harvest.creatorFeeRecipientOf(address(tok), creator), payee);

        _warpPastSnipe();
        _buy(c, trader1, BUY, 0);
        uint256 owed = feeVault.creatorClaimable(address(tok), creator);
        assertGt(owed, 0);
        uint256 c0 = quote.balanceOf(creator);
        vm.prank(creator);
        feeVault.claimCreatorFees(address(tok));
        assertEq(quote.balanceOf(payee), owed, "curve fees to the pick");
        assertEq(quote.balanceOf(creator), c0, "creator wallet gets nothing");

        _orbitAndTrade(c, tok);
        (uint256 hq, uint256 ht) = hook.claimable(address(tok), 0);
        assertGt(hq + ht, 0);
        uint256 p0 = quote.balanceOf(payee);
        vm.prank(bot); // public claim still lands on the pick
        hook.claimCreatorFees(address(tok));
        assertEq(quote.balanceOf(payee) - p0, hq, "pool quote to the pick");
        assertEq(tok.balanceOf(payee), ht, "pool token to the pick");
        assertEq(quote.balanceOf(creator), c0);
        assertEq(tok.balanceOf(bot) + quote.balanceOf(bot), 0);
    }

    function test_onlyCurrentCreatorSets_andTransferResets() public {
        (BondingCurve c, Token tok) = _launch(0, 0);
        vm.prank(trader1);
        vm.expectRevert(CreatorFeeHarvest.NotCreator.selector);
        harvest.setCreatorFeeRecipient(address(tok), trader1);

        _setPayee(address(tok), creator, payee);
        address next = makeAddr("nextCreator");
        vm.prank(creator);
        launchpad.transferCreator(address(tok), next);
        assertEq(harvest.creatorFeeRecipientOf(address(tok), next), next, "new creator starts with no pick");

        vm.prank(creator); // the old creator can no longer change it
        vm.expectRevert(CreatorFeeHarvest.NotCreator.selector);
        harvest.setCreatorFeeRecipient(address(tok), creator);

        _orbitAndTrade(c, tok);
        (uint256 hq,) = hook.claimable(address(tok), 0);
        uint256 n0 = quote.balanceOf(next);
        hook.claimCreatorFees(address(tok));
        assertEq(quote.balanceOf(next) - n0, hq, "new creator is paid");

        address np = makeAddr("nextPayee");
        _setPayee(address(tok), next, np);
        _swapExactInTokenForQuote(tok, trader1, tok.balanceOf(trader1) / 2);
        (uint256 hq2,) = hook.claimable(address(tok), 0);
        hook.claimCreatorFees(address(tok));
        assertEq(quote.balanceOf(np), hq2, "new creator's own pick");
    }

    function test_clearWithZeroOrSelf() public {
        (, Token tok) = _launch(0, 0);
        _setPayee(address(tok), creator, payee);
        _setPayee(address(tok), creator, address(0));
        assertEq(harvest.creatorFeeRecipientOf(address(tok), creator), creator);
        _setPayee(address(tok), creator, payee);
        _setPayee(address(tok), creator, creator);
        assertEq(harvest.creatorFeeRecipientOf(address(tok), creator), creator);
    }

    // ── new creator gets every unclaimed fee (maker 2026-11-19) ─────────────

    function test_newCreatorGetsCurveBookedFees() public {
        (BondingCurve c, Token tok) = _launch(0, 0);
        _warpPastSnipe();
        _buy(c, trader1, BUY, 0);
        c.settleFees(); // booked to the old creator on the vault
        uint256 owed = feeVault.creatorAccrued(address(tok), creator);
        assertGt(owed, 0);
        address next = makeAddr("nextCreator");
        vm.prank(creator);
        launchpad.transferCreator(address(tok), next);

        vm.prank(creator);
        vm.expectRevert(CurveFeeVault.NotCurrentCreator.selector);
        feeVault.claimCreatorFees(address(tok));

        vm.prank(bot); // anyone moves it; nobody is paid by the sweep
        feeVault.sweepPastCreatorFees_1311(address(tok), creator);
        assertEq(feeVault.creatorAccrued(address(tok), creator), 0);
        vm.expectRevert(CurveFeeVault.NotCurrentCreator.selector);
        feeVault.sweepPastCreatorFees_1311(address(tok), next);

        uint256 n0 = quote.balanceOf(next);
        vm.prank(next);
        feeVault.claimCreatorFees(address(tok));
        assertEq(quote.balanceOf(next) - n0, owed, "new creator gets the old balance");
        assertEq(quote.balanceOf(bot), 0);
    }

    function test_newCreatorGetsFeeRouterBookedFees() public {
        (, Token tok) = _launch(0, 0);
        uint256 q = 7 * U;
        uint256 t = 5 ether;
        stdstore.target(address(feeRouter)).sig("creatorAccrued(address,address)").with_key(address(tok)).with_key(
            creator
        ).checked_write(q);
        stdstore.target(address(feeRouter)).sig("creatorTokenAccrued(address,address)").with_key(address(tok))
            .with_key(creator).checked_write(t);
        quote.mint(address(feeRouter), q);
        deal(address(tok), address(feeRouter), tok.balanceOf(address(feeRouter)) + t);

        address next = makeAddr("nextCreator");
        vm.prank(creator);
        launchpad.transferCreator(address(tok), next);
        vm.startPrank(creator);
        vm.expectRevert(FeeRouter.NotCurrentCreator.selector);
        feeRouter.claimCreatorFees(address(tok));
        vm.expectRevert(FeeRouter.NotCurrentCreator.selector);
        feeRouter.claimCreatorTokenFees(address(tok));
        vm.stopPrank();
        vm.prank(address(router)); // a claim router cannot pay a past creator either
        vm.expectRevert(FeeRouter.NotCurrentCreator.selector);
        feeRouter.claimCreatorFeesFor(address(tok), creator);

        vm.prank(bot);
        feeRouter.sweepPastCreatorFees_1311(address(tok), creator);
        address np = makeAddr("nextPayee");
        _setPayee(address(tok), next, np);
        vm.startPrank(next);
        feeRouter.claimCreatorFees(address(tok));
        feeRouter.claimCreatorTokenFees(address(tok));
        vm.stopPrank();
        assertEq(quote.balanceOf(np), q, "quote to the new creator's pick");
        assertEq(tok.balanceOf(np), t, "token to the new creator's pick");
    }

    // ── private coins ─────────────────────────────────────────────────────

    function _anonLaunch() internal returns (BondingCurve c, Token tok) {
        ILaunchpad.LaunchResult memory r = anon.launchAnon(_params(), stealth, stealth, "", bytes1(0), 0);
        c = BondingCurve(r.curve);
        tok = Token(r.token);
    }

    function _payeeSig(address token, address to, uint256 deadline) internal view returns (bytes memory) {
        bytes32 sh = keccak256(abi.encode(anon.PAYEE_TYPEHASH(), token, to, anon.nonces(stealth), deadline));
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", anon.domainSeparator(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sk, d);
        return abi.encodePacked(r, s, v);
    }

    function test_anon_pickBySig_curveAndPool_paidByAnyone() public {
        (BondingCurve c, Token tok) = _anonLaunch();
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _payeeSig(address(tok), payee, dl);
        vm.prank(bot); // relayer submits the signature
        anon.setPayeeBySig(address(tok), payee, dl, sig);
        assertEq(anon.payeeOf(address(tok)), payee);
        vm.expectRevert(AnonLauncher.BadSignature.selector); // nonce used
        anon.setPayeeBySig(address(tok), bot, dl, sig);

        _warpPastSnipe();
        _buy(c, trader1, BUY, 0);
        uint256 owed = feeVault.creatorClaimable(address(tok), address(anon));
        assertGt(owed, 0);
        vm.prank(bot);
        feeVault.claimAnonToPayee(address(tok));
        assertEq(quote.balanceOf(payee), owed, "curve fees to the pick");

        _orbitAndTrade(c, tok);
        (uint256 hq, uint256 ht) = hook.claimable(address(tok), 0);
        assertGt(hq, 0);
        address[] memory ts = new address[](1);
        ts[0] = address(tok);
        vm.prank(bot);
        anon.claimToPayee(ts);
        assertEq(quote.balanceOf(payee) - owed, hq, "pool quote to the pick");
        assertEq(tok.balanceOf(payee), ht, "pool token to the pick");
        assertEq(quote.balanceOf(bot) + tok.balanceOf(bot), 0, "caller gets nothing");
    }

    function test_anon_onlyStealthOwner_andTransferClears() public {
        (, Token tok) = _anonLaunch();
        vm.prank(bot);
        vm.expectRevert(AnonLauncher.NotStealthOwner.selector);
        anon.setPayee(address(tok), bot);

        address[] memory ts = new address[](1);
        ts[0] = address(tok);
        vm.expectRevert(AnonLauncher.ZeroAddress.selector); // no pick yet
        anon.claimToPayee(ts);
        vm.expectRevert(CurveFeeVault.ZeroAddress.selector);
        feeVault.claimAnonToPayee(address(tok));

        vm.prank(stealth);
        anon.setPayee(address(tok), payee);
        vm.prank(stealth);
        anon.transferCreator(address(tok), makeAddr("newStealth"));
        assertEq(anon.payeeOf(address(tok)), address(0), "cleared on transfer");
        // nobody can point a private coin's pool fees elsewhere through the public registry
        vm.prank(bot);
        vm.expectRevert(CreatorFeeHarvest.NotCreator.selector);
        harvest.setCreatorFeeRecipient(address(tok), bot);
        assertEq(harvest.creatorFeeRecipientOf(address(tok), address(anon)), address(anon));
    }
}
