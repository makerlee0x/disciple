// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {DiscipleSessionPolicy as P} from "../../src/session/DiscipleSessionPolicy.sol";
import {ReferralRegistry} from "../../src/ReferralRegistry.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {TKN, MockMAv2, MockLaunchpad, MockCurve} from "./DiscipleSessionPolicy.t.sol";

/// @dev Stand-in for the redeploy-pack DiscipleRouter surface the 1.4.1 policy signs: launchWithUsdg,
///      swapUsdgToQuote, swapQuoteToUsdg, quoteUsdgQuoteSwap (+ claimCreatorFeesToUsdg, which must stay unsigned).
contract MockPackRouter {
    TKN public usdgT;
    uint256 public quoteBps = 10_000;

    constructor(TKN u) {
        usdgT = u;
    }

    function usdg() external view returns (address) {
        return address(usdgT);
    }

    function setQuoteBps(uint256 b) external {
        quoteBps = b;
    }

    function quoteUsdgQuoteSwap(address, bool, uint256 amountIn) external view returns (uint256, uint256) {
        return (amountIn * quoteBps / 10_000, 0);
    }

    function swapUsdgToQuote(address quote, uint256 usdgIn, uint256, address recipient, uint256)
        external
        returns (uint256)
    {
        usdgT.transferFrom(msg.sender, address(this), usdgIn);
        TKN(quote).mint(recipient, usdgIn);
        return usdgIn;
    }

    function swapQuoteToUsdg(address quote, uint256 quoteIn, uint256, address recipient, uint256)
        external
        returns (uint256)
    {
        TKN(quote).transferFrom(msg.sender, address(this), quoteIn);
        usdgT.mint(recipient, quoteIn);
        return quoteIn;
    }

    function launchWithUsdg(ILaunchpad.LaunchParams calldata, uint8, uint256 usdgIn, uint256)
        external
        returns (address token)
    {
        if (usdgIn != 0) usdgT.transferFrom(msg.sender, address(this), usdgIn);
        return address(0xBEEF);
    }

    function claimCreatorFeesToUsdg(address, uint256) external {}
}

/// @notice Policy 1.4.1 (redeploy pack, scope locked by lee 2026-10-24): one-tap covers launchWithUsdg,
///         swapUsdgToQuote, swapQuoteToUsdg (+ existing buy/sell and launchAnon v2). NO claim selectors.
contract SessionPackTest is Test {
    P policy;
    TKN usdg;
    TKN strat; // capped pair coin (quote1)
    TKN rogue; // uncapped asset
    MockPackRouter router;
    MockLaunchpad lp;
    MockCurve curve;
    MockMAv2 acct;
    address owner = makeAddr("owner");
    address key = makeAddr("sessionKey");
    address attacker = makeAddr("attacker");
    address feeRouter = makeAddr("feeRouter");
    uint32 constant E = 8;
    uint128 constant CAP = 100e18;
    uint128 constant CAP1 = 50e18;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new TKN("USDG");
        strat = new TKN("STRAT");
        rogue = new TKN("ROGUE");
        ReferralRegistry registry = new ReferralRegistry(address(this), address(usdg));
        policy = new P(address(registry), address(0));
        router = new MockPackRouter(usdg);
        lp = new MockLaunchpad();
        lp.setDefaultQuote(address(strat));
        TKN coin = new TKN("COIN");
        curve = new MockCurve(address(coin), strat);
        lp.set(address(coin), address(curve));
        acct = new MockMAv2(owner);
        usdg.mint(address(acct), 1000e18);
        strat.mint(address(acct), 1000e18);
        rogue.mint(address(acct), 1000e18);
        P.SessionConfig memory c;
        c.validUntil = uint48(block.timestamp + 1 days);
        c.permissions = (1 << 11) - 1;
        c.router = address(router);
        c.launchpad = address(lp);
        c.anonLauncher = address(0xA11CE);
        c.quote0 = address(usdg);
        c.cap0 = CAP;
        c.quote1 = address(strat);
        c.cap1 = CAP1;
        vm.prank(owner);
        acct.installSession(policy, E, key, c);
    }

    // ── helpers ──
    function _approve(address tok, uint256 a) internal view returns (MockMAv2.Call memory) {
        return MockMAv2.Call(tok, 0, abi.encodeCall(ERC20.approve, (address(router), a)));
    }

    function _toQuote(address q, uint256 a, uint256 minOut, address r) internal view returns (MockMAv2.Call memory) {
        return MockMAv2.Call(
            address(router), 0, abi.encodeCall(MockPackRouter.swapUsdgToQuote, (q, a, minOut, r, block.timestamp))
        );
    }

    function _toUsdg(address q, uint256 a, uint256 minOut, address r) internal view returns (MockMAv2.Call memory) {
        return MockMAv2.Call(
            address(router), 0, abi.encodeCall(MockPackRouter.swapQuoteToUsdg, (q, a, minOut, r, block.timestamp))
        );
    }

    function _lp(address quote) internal pure returns (ILaunchpad.LaunchParams memory p) {
        p.name = "Coin";
        p.ticker = "COIN";
        p.quote = quote;
    }

    function _launch(address quote, uint256 usdgIn, uint256 minQuoteIn) internal pure returns (MockMAv2.Call memory) {
        return MockMAv2.Call(
            address(0), 0, abi.encodeCall(MockPackRouter.launchWithUsdg, (_lp(quote), uint8(0), usdgIn, minQuoteIn))
        );
    }

    function _batch2(MockMAv2.Call memory a, MockMAv2.Call memory b) internal {
        MockMAv2.Call[] memory cs = new MockMAv2.Call[](2);
        cs[0] = a;
        cs[1] = b;
        vm.prank(key);
        acct.executeBatch(cs);
    }

    function _spent() internal view returns (uint128 s0, uint128 s1) {
        P.Session memory s = policy.sessionOf(address(acct), E);
        return (s.spent0, s.spent1);
    }

    // ── version + selectors ──
    function test_moduleId_1_4_1() public view {
        assertEq(policy.moduleId(), "disciple.session-policy.1.4.1");
    }

    function test_selectorStrings() public pure {
        assertEq(
            MockPackRouter.swapUsdgToQuote.selector,
            bytes4(keccak256("swapUsdgToQuote(address,uint256,uint256,address,uint256)"))
        );
        assertEq(
            MockPackRouter.swapQuoteToUsdg.selector,
            bytes4(keccak256("swapQuoteToUsdg(address,uint256,uint256,address,uint256)"))
        );
        assertEq(
            MockPackRouter.launchWithUsdg.selector,
            bytes4(
                keccak256(
                    "launchWithUsdg((string,string,string,string,string,address,uint256,uint256,uint256,uint256),uint8,uint256,uint256)"
                )
            )
        );
    }

    // ── swapUsdgToQuote ──
    function test_swapUsdgToQuote_allowed_countsUsdg() public {
        _batch2(_approve(address(usdg), 10e18), _toQuote(address(strat), 10e18, 9.6e18, address(acct)));
        (uint128 s0, uint128 s1) = _spent();
        assertEq(s0, 10e18);
        assertEq(s1, 0);
        assertEq(strat.balanceOf(address(acct)), 1010e18);
    }

    function test_swapUsdgToQuote_capExceeded() public {
        vm.expectRevert(abi.encodeWithSelector(P.SpendCapExceeded.selector, address(usdg), uint256(CAP) + 1, uint256(CAP)));
        _batch2(_approve(address(usdg), CAP + 1), _toQuote(address(strat), CAP + 1, CAP, address(acct)));
    }

    function test_swapUsdgToQuote_lowMinOut() public {
        vm.expectRevert();
        _batch2(_approve(address(usdg), 10e18), _toQuote(address(strat), 10e18, 9.4e18, address(acct)));
        vm.expectRevert();
        _batch2(_approve(address(usdg), 10e18), _toQuote(address(strat), 10e18, 0, address(acct)));
    }

    function test_swapUsdgToQuote_minOutTracksLiveQuote() public {
        router.setQuoteBps(5_000); // pool moved: 10 USDG -> 5 STRAT; 4.75 is the 5% floor
        _batch2(_approve(address(usdg), 10e18), _toQuote(address(strat), 10e18, 4.75e18, address(acct)));
    }

    function test_swapUsdgToQuote_wrongRecipient() public {
        vm.expectRevert(P.RecipientNotAccount.selector);
        _batch2(_approve(address(usdg), 10e18), _toQuote(address(strat), 10e18, 10e18, attacker));
    }

    function test_swapUsdgToQuote_approveMustBeExact() public {
        vm.expectRevert();
        _batch2(_approve(address(usdg), 11e18), _toQuote(address(strat), 10e18, 10e18, address(acct)));
    }

    function test_swaps_wrongTarget() public {
        MockPackRouter evil = new MockPackRouter(usdg);
        MockMAv2.Call memory c = _toQuote(address(strat), 1e18, 1e18, address(acct));
        vm.expectRevert(abi.encodeWithSelector(P.NotAllowed.selector, address(evil), MockPackRouter.swapUsdgToQuote.selector));
        vm.prank(key);
        acct.execute(address(evil), 0, c.data);
        c = _toUsdg(address(strat), 1e18, 1e18, address(acct));
        vm.expectRevert(abi.encodeWithSelector(P.NotAllowed.selector, address(evil), MockPackRouter.swapQuoteToUsdg.selector));
        vm.prank(key);
        acct.execute(address(evil), 0, c.data);
    }

    // ── swapQuoteToUsdg ──
    function test_swapQuoteToUsdg_allowed_countsQuoteCap() public {
        _batch2(_approve(address(strat), 10e18), _toUsdg(address(strat), 10e18, 10e18, address(acct)));
        (uint128 s0, uint128 s1) = _spent();
        assertEq(s0, 0);
        assertEq(s1, 10e18);
        assertEq(usdg.balanceOf(address(acct)), 1010e18);
    }

    function test_swapQuoteToUsdg_capExceeded() public {
        vm.expectRevert(abi.encodeWithSelector(P.SpendCapExceeded.selector, address(strat), uint256(CAP1) + 1, uint256(CAP1)));
        _batch2(_approve(address(strat), CAP1 + 1), _toUsdg(address(strat), CAP1 + 1, CAP1 + 1, address(acct)));
    }

    function test_swapQuoteToUsdg_uncappedAssetRejected() public {
        vm.expectRevert(abi.encodeWithSelector(P.SpendCapExceeded.selector, address(rogue), 1e18, 0));
        _batch2(_approve(address(rogue), 1e18), _toUsdg(address(rogue), 1e18, 1e18, address(acct)));
    }

    function test_swapQuoteToUsdg_lowMinOut() public {
        vm.expectRevert();
        _batch2(_approve(address(strat), 10e18), _toUsdg(address(strat), 10e18, 9e18, address(acct)));
    }

    function test_swapQuoteToUsdg_wrongRecipient() public {
        vm.expectRevert(P.RecipientNotAccount.selector);
        _batch2(_approve(address(strat), 10e18), _toUsdg(address(strat), 10e18, 10e18, attacker));
    }

    function test_swaps_needPermission() public {
        vm.startPrank(owner);
        acct.uninstallSession();
        P.SessionConfig memory c;
        c.validUntil = uint48(block.timestamp + 1 days);
        c.permissions = policy.P_ROUTER_SELL(); // no buy, no launch
        c.router = address(router);
        c.launchpad = address(lp);
        c.quote0 = address(usdg);
        c.cap0 = CAP;
        c.quote1 = address(strat);
        c.cap1 = CAP1;
        acct.installSession(policy, E, key, c);
        vm.stopPrank();
        MockMAv2.Call memory call = _toQuote(address(strat), 1e18, 1e18, address(acct));
        vm.expectRevert(abi.encodeWithSelector(P.NotAllowed.selector, address(router), MockPackRouter.swapUsdgToQuote.selector));
        vm.prank(key);
        acct.execute(address(router), 0, call.data);
        call = _launch(address(0), 0, 0);
        vm.expectRevert(abi.encodeWithSelector(P.NotAllowed.selector, address(router), MockPackRouter.launchWithUsdg.selector));
        vm.prank(key);
        acct.execute(address(router), 0, call.data);
    }

    // ── launchWithUsdg ──
    function test_launchWithUsdg_allowed_countsUsdg() public {
        MockMAv2.Call memory l = _launch(address(0), 20e18, 19e18); // default quote = STRAT
        l.target = address(router);
        _batch2(_approve(address(usdg), 20e18), l);
        (uint128 s0, uint128 s1) = _spent();
        assertEq(s0, 20e18);
        assertEq(s1, 0);
    }

    function test_launchWithUsdg_noBuy_noApprove() public {
        MockMAv2.Call memory l = _launch(address(strat), 0, 0);
        vm.prank(key);
        acct.execute(address(router), 0, l.data);
        (uint128 s0,) = _spent();
        assertEq(s0, 0);
    }

    function test_launchWithUsdg_usdgPair_skipsMinQuote() public {
        MockMAv2.Call memory l = _launch(address(usdg), 20e18, 0);
        l.target = address(router);
        _batch2(_approve(address(usdg), 20e18), l);
    }

    function test_launchWithUsdg_capExceeded() public {
        MockMAv2.Call memory l = _launch(address(strat), CAP + 1, CAP + 1);
        l.target = address(router);
        vm.expectRevert(abi.encodeWithSelector(P.SpendCapExceeded.selector, address(usdg), uint256(CAP) + 1, uint256(CAP)));
        _batch2(_approve(address(usdg), CAP + 1), l);
    }

    function test_launchWithUsdg_lowMinQuoteIn() public {
        MockMAv2.Call memory l = _launch(address(strat), 20e18, 0);
        l.target = address(router);
        vm.expectRevert();
        _batch2(_approve(address(usdg), 20e18), l);
    }

    function test_launchWithUsdg_wrongTarget() public {
        MockPackRouter evil = new MockPackRouter(usdg);
        MockMAv2.Call memory l = _launch(address(strat), 0, 0);
        vm.expectRevert(abi.encodeWithSelector(P.NotAllowed.selector, address(evil), MockPackRouter.launchWithUsdg.selector));
        vm.prank(key);
        acct.execute(address(evil), 0, l.data);
    }

    // ── claims are NOT one-tap (lee 2026-10-24) ──
    function _rejects(address target, bytes memory data) internal {
        bytes4 sel;
        assembly {
            sel := mload(add(data, 32))
        }
        vm.expectRevert(abi.encodeWithSelector(P.NotAllowed.selector, target, sel));
        vm.prank(key);
        acct.execute(target, 0, data);
    }

    function test_claimSelectors_rejected() public {
        address coin = address(0xC0FFEE);
        // router: claimCreatorFeesToUsdg (removed from 1.4.x)
        _rejects(address(router), abi.encodeWithSignature("claimCreatorFeesToUsdg(address,uint256)", coin, 0));
        // FeeRouter: creator / creator-token / referral / treasury claims
        _rejects(feeRouter, abi.encodeWithSignature("claimCreatorFees(address)", coin));
        _rejects(feeRouter, abi.encodeWithSignature("claimCreatorTokenFees(address)", coin));
        _rejects(feeRouter, abi.encodeWithSignature("claimReferrerFees(address)", address(usdg)));
        _rejects(feeRouter, abi.encodeWithSignature("claimTreasury(address)", address(usdg)));
        // Launchpad: claim + transferCreator
        _rejects(address(lp), abi.encodeWithSignature("claim(address)", coin));
        _rejects(address(lp), abi.encodeWithSignature("transferCreator(address,address)", coin, attacker));
        // curve crew tips (claim / claimFor) — even on a registered curve
        _rejects(address(curve), abi.encodeWithSignature("claim()"));
        _rejects(address(curve), abi.encodeWithSignature("claimFor(address)", address(acct)));
        // AnonLauncher: transferCreator + claimMany
        _rejects(address(0xA11CE), abi.encodeWithSignature("transferCreator(address,address)", coin, attacker));
        _rejects(address(0xA11CE), abi.encodeWithSignature("claimMany(address[],address)", new address[](0), attacker));
    }
}
