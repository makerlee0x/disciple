// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {console2} from "forge-std/console2.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {CurveFeeVault} from "../../src/CurveFeeVault.sol";
import {CurveDeployer} from "../../src/CurveDeployer.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {LoginGate} from "../../src/LoginGate.sol";
import {AnonLauncher} from "../../src/addons/AnonLauncher.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {Constants} from "../../src/libraries/Constants.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";

/// @notice lp-accrue follow-ups (lee 2026-11-09 9:16 PM CT): H1 stealth-owner vault claim, M1 router claim covers the
///         vault, L2 release capped at the LP share accrued by the timeout (one release only).
contract LpAccrueFollowupsTest is IntegrationBase {
    AnonLauncher internal anon;
    uint256 internal stealthPk = 0x5EA17;
    address internal stealth;
    uint256 internal n_;

    function setUp() public override {
        super.setUp();
        LoginGate g = new LoginGate(owner, makeAddr("attester"));
        anon = new AnonLauncher(owner, address(launchpad), address(feeRouter), address(quote), treasury, address(0), 0);
        // the vault is built with the AnonLauncher (H1); swap it in exactly as DeployLpAccrue does
        feeVault = new CurveFeeVault(address(feeRouter), address(anon));
        address d = address(new CurveDeployer(address(feeVault)));
        vm.startPrank(owner);
        launchpad.setLoginGate(address(g));
        launchpad.setCurveDeployer(d);
        vm.stopPrank();
        stealth = vm.addr(stealthPk);
    }

    // ───────── helpers ─────────

    function _p(uint256 taxBps) internal view returns (ILaunchpad.LaunchParams memory) {
        return ILaunchpad.LaunchParams({
            name: "F",
            ticker: "F",
            imageURI: "ipfs://img",
            description: "",
            socialsURI: "",
            quote: address(quote),
            creatorTaxBps: taxBps,
            creatorBuyQuoteIn: 0,
            creatorBuyMinTokensOut: 0,
            deadline: block.timestamp + 1 hours
        });
    }

    function _launchWallet(uint256 taxBps) internal returns (BondingCurve c, Token t) {
        vm.prank(creator);
        ILaunchpad.LaunchResult memory r = launchpad.launchWithMode(_p(taxBps), Constants.MODE_TRENCH);
        c = BondingCurve(r.curve);
        t = Token(r.token);
    }

    function _launchAnon(uint256 taxBps) internal returns (BondingCurve c, Token t) {
        vm.prank(makeAddr("payer"));
        ILaunchpad.LaunchResult memory r = anon.launchAnon(_p(taxBps), stealth, stealth, "", 0x00, 0);
        c = BondingCurve(r.curve);
        t = Token(r.token);
    }

    function _w() internal returns (address w) {
        w = makeAddr(string(abi.encodePacked("fw", vm.toString(++n_))));
        quote.mint(w, 10_000_000 ether);
    }

    function _b(BondingCurve c, address w, uint256 q) internal returns (uint256 out) {
        vm.startPrank(w);
        quote.approve(address(c), q);
        out = c.buy(q, 0, block.timestamp + 1 hours);
        vm.stopPrank();
    }

    function _s(BondingCurve c, Token t, address w, uint256 n) internal returns (uint256 out) {
        vm.startPrank(w);
        t.approve(address(c), n);
        out = c.sell(n, 0, block.timestamp + 1 hours);
        vm.stopPrank();
    }

    function _one(address t) internal pure returns (address[] memory a) {
        a = new address[](1);
        a[0] = t;
    }

    /// @dev EIP-712 digest of AnonLauncher's Claim struct under the vault's domain (as the web signs it).
    function _digest(address o, address[] memory toks, address to, uint256 feeBps, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        (, string memory name, string memory version, uint256 chainId, address vc,,) = feeVault.eip712Domain();
        bytes32 ds = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                vc
            )
        );
        bytes32 sh = keccak256(
            abi.encode(
                keccak256(
                    "Claim(address owner,address[] tokens,address to,uint256 relayerFeeBps,uint256 nonce,uint256 deadline)"
                ),
                o,
                keccak256(abi.encodePacked(toks)),
                to,
                feeBps,
                nonce,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", ds, sh));
    }

    function _sig(address[] memory toks, address to, uint256 feeBps, uint256 deadline) internal view returns (bytes memory) {
        bytes32 d = _digest(stealth, toks, to, feeBps, feeVault.sigNonces(stealth), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(stealthPk, d);
        return abi.encodePacked(r, s, v);
    }

    /// @dev creator share of `protoFee` + `tax` (no launch KOL)
    function _creatorPart(uint256 protoFee, uint256 tax) internal pure returns (uint256 cr) {
        (cr,,,) = FeeMath.splitTradeFee(protoFee);
        cr += tax;
    }

    // ───────── H1: stealth owner claims a private coin's vault fees ─────────

    function test_H1_stealthOwner_claimsDirect_exact() public {
        (BondingCurve c, Token t) = _launchAnon(100);
        _warpPastSnipe();
        address w = _w();
        _b(c, w, 500 ether);
        _s(c, t, w, t.balanceOf(w) / 3);
        uint256 expect = _creatorPart(c.protoFeesOwed(), c.creatorTaxOwed());
        assertEq(feeVault.creatorClaimable(address(t), address(anon)), expect, "pending = accrued + owed share");
        address to = makeAddr("payout");
        vm.prank(stealth);
        uint256 got = feeVault.claimCreatorFeesAsStealth(address(t), to);
        assertEq(got, expect, "creator 33% + tax, settled first");
        assertEq(quote.balanceOf(to), got);
        assertEq(feeVault.creatorAccrued(address(t), address(anon)), 0);
        assertEq(c.protoFeesOwed(), 0, "claim settled the coin");
        vm.prank(stealth);
        vm.expectRevert(CurveFeeVault.NothingToClaim.selector);
        feeVault.claimCreatorFeesAsStealth(address(t), to);
        // FeeRouter-side AnonLauncher claims are unchanged (nothing there on a new curve)
        (, uint256 qa,) = anon.pending(address(t));
        assertEq(qa, 0);
    }

    function test_H1_gates() public {
        (BondingCurve c, Token t) = _launchAnon(0);
        (BondingCurve wc, Token wt) = _launchWallet(0);
        _warpPastSnipe();
        address w = _w();
        _b(c, w, 100 ether);
        _b(wc, w, 100 ether);
        // not the stealth owner
        vm.prank(w);
        vm.expectRevert(CurveFeeVault.NotStealthOwner.selector);
        feeVault.claimCreatorFeesAsStealth(address(t), w);
        // the launcher itself can't use the stealth path, and the creator path pays only msg.sender's own key
        vm.prank(stealth);
        vm.expectRevert(CurveFeeVault.NothingToClaim.selector);
        feeVault.claimCreatorFees(address(t));
        // a wallet-launched coin is not an anonLauncher coin
        vm.prank(creator);
        vm.expectRevert(CurveFeeVault.NotStealthOwner.selector);
        feeVault.claimCreatorFeesAsStealth(address(wt), creator);
        // zero recipient
        vm.prank(stealth);
        vm.expectRevert(CurveFeeVault.ZeroAddress.selector);
        feeVault.claimCreatorFeesAsStealth(address(t), address(0));
        // creator of the wallet coin still claims normally
        vm.prank(creator);
        assertGt(feeVault.claimCreatorFees(address(wt)), 0);
    }

    function test_H1_vaultWithoutAnonLauncher_rejects() public {
        CurveFeeVault v0 = new CurveFeeVault(address(feeRouter), address(0));
        (, Token t) = _launchAnon(0);
        vm.prank(stealth);
        vm.expectRevert(CurveFeeVault.NotStealthOwner.selector);
        v0.claimCreatorFeesAsStealth(address(t), stealth);
    }

    function test_H1_stealthTransfer_newOwnerClaims_oldCannot() public {
        (BondingCurve c, Token t) = _launchAnon(0);
        _warpPastSnipe();
        _b(c, _w(), 200 ether);
        address next = makeAddr("nextOwner");
        vm.prank(stealth);
        anon.transferCreator(address(t), next);
        vm.prank(stealth);
        vm.expectRevert(CurveFeeVault.NotStealthOwner.selector);
        feeVault.claimCreatorFeesAsStealth(address(t), stealth);
        vm.prank(next);
        assertGt(feeVault.claimCreatorFeesAsStealth(address(t), next), 0, "unclaimed fees move with the stealth role");
    }

    function test_H1_bySig_relayer_gasless() public {
        (BondingCurve c, Token t) = _launchAnon(200);
        (BondingCurve c2, Token t2) = _launchAnon(0);
        _warpPastSnipe();
        address w = _w();
        _b(c, w, 300 ether);
        _b(c2, w, 100 ether);
        address[] memory toks = new address[](2);
        toks[0] = address(t);
        toks[1] = address(t2);
        uint256 e1 = _creatorPart(c.protoFeesOwed(), c.creatorTaxOwed());
        uint256 e2 = _creatorPart(c2.protoFeesOwed(), c2.creatorTaxOwed());
        address to = makeAddr("smartAccount");
        address relayer = makeAddr("relayer");
        uint256 dl = block.timestamp + 30 minutes;
        bytes memory sig = _sig(toks, to, 100, dl);
        CurveFeeVault.ClaimReq memory req = CurveFeeVault.ClaimReq(stealth, toks, to, 100, dl, sig);
        uint256 rf1 = (e1 * 100) / 10_000;
        uint256 rf2 = (e2 * 100) / 10_000;
        vm.prank(relayer);
        feeVault.claimManyAsStealthBySig(req);
        assertEq(quote.balanceOf(to), e1 - rf1 + e2 - rf2, "paid to `to` net of the relayer fee");
        assertEq(quote.balanceOf(relayer), rf1 + rf2, "relayer fee <= 5% to msg.sender");
        assertEq(feeVault.sigNonces(stealth), 1);
        // replay: nonce moved, signature no longer valid
        vm.expectRevert(CurveFeeVault.BadSignature.selector);
        feeVault.claimManyAsStealthBySig(req);
    }

    function test_H1_bySig_rejects() public {
        (BondingCurve c, Token t) = _launchAnon(0);
        _warpPastSnipe();
        _b(c, _w(), 100 ether);
        address[] memory toks = _one(address(t));
        uint256 dl = block.timestamp + 1;
        // relayer fee above AnonLauncher's 5% cap
        bytes memory hi = _sig(toks, stealth, 501, dl);
        vm.expectRevert(CurveFeeVault.FeeTooHigh.selector);
        feeVault.claimManyAsStealthBySig(CurveFeeVault.ClaimReq(stealth, toks, stealth, 501, dl, hi));
        // expired
        bytes memory sig = _sig(toks, stealth, 0, dl);
        vm.warp(dl + 1);
        vm.expectRevert(CurveFeeVault.Expired.selector);
        feeVault.claimManyAsStealthBySig(CurveFeeVault.ClaimReq(stealth, toks, stealth, 0, dl, sig));
        // wrong signer
        dl = block.timestamp + 1 hours;
        bytes32 d = _digest(stealth, toks, stealth, 0, 0, dl);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, d);
        vm.expectRevert(CurveFeeVault.BadSignature.selector);
        feeVault.claimManyAsStealthBySig(CurveFeeVault.ClaimReq(stealth, toks, stealth, 0, dl, abi.encodePacked(r, s, v)));
        // a signer that is not the coin's stealth owner
        uint256 otherPk = 0x0DD;
        address other = vm.addr(otherPk);
        d = _digest(other, toks, other, 0, 0, dl);
        (v, r, s) = vm.sign(otherPk, d);
        vm.expectRevert(CurveFeeVault.NotStealthOwner.selector);
        feeVault.claimManyAsStealthBySig(CurveFeeVault.ClaimReq(other, toks, other, 0, dl, abi.encodePacked(r, s, v)));
    }

    function test_H1_pendingCreatorFees_walletCoin_matchesClaim() public {
        _bindReferral(creator, kol, 100 ether); // launch KOL coin: creator share minus the KOL cut
        (BondingCurve c, Token t) = _launchWallet(50);
        _warpPastSnipe();
        address w = _w();
        _b(c, w, 250 ether);
        c.settleFees();
        _b(c, w, 40 ether); // part settled, part owed
        uint256 p = feeVault.creatorClaimable(address(t), creator);
        vm.prank(creator);
        assertEq(feeVault.claimCreatorFees(address(t)), p, "preview == claim (same aggregate split)");
        assertEq(feeVault.creatorClaimable(address(t), creator), 0);
        assertEq(feeVault.creatorClaimable(address(t), w), 0, "not the creator: accrued only");
    }

    // ───────── M1: DiscipleRouter.claimCreatorFeesToUsdg covers the vault ─────────

    function test_M1_routerClaimToUsdg_paysVaultFees() public {
        router.setUsdgRouting(address(quote), address(launchpad)); // V4Deploy: router owner = this test
        (BondingCurve c, Token t) = _launchWallet(100);
        _warpPastSnipe();
        _b(c, _w(), 300 ether);
        uint256 p = feeVault.creatorClaimable(address(t), creator);
        assertGt(p, 0);
        assertEq(feeRouter.creatorAccrued(address(t), creator), 0, "nothing in FeeRouter on a new curve");
        uint256 u0 = quote.balanceOf(creator);
        vm.prank(creator);
        uint256 out = router.claimCreatorFeesToUsdg(address(t), p);
        assertEq(out, p, "USDG pair: plain transfer of the vault balance");
        assertEq(quote.balanceOf(creator) - u0, p);
        assertEq(quote.balanceOf(address(router)), 0, "router keeps nothing");
        // nothing left anywhere: still FeeRouter.NothingToClaim (unchanged revert)
        vm.prank(creator);
        vm.expectRevert(FeeRouter.NothingToClaim.selector);
        router.claimCreatorFeesToUsdg(address(t), 0);
        // not the creator
        vm.prank(trader1);
        vm.expectRevert(FeeRouter.NothingToClaim.selector);
        router.claimCreatorFeesToUsdg(address(t), 0);
        // the vault's router entry is FeeRouter.isClaimRouter-only
        vm.prank(creator);
        vm.expectRevert(CurveFeeVault.OnlyClaimRouter.selector);
        feeVault.claimCreatorFeesToRouter(address(t), creator);
    }

    function test_M1_routerClaimToUsdg_vaultPlusFeeRouter_afterGraduation() public {
        router.setUsdgRouting(address(quote), address(launchpad));
        (BondingCurve c, Token t) = _launchWallet(0);
        _graduate(c);
        uint256 vaultPart = feeVault.creatorAccrued(address(t), creator);
        assertGt(vaultPart, 0, "curve-phase fees settled to the vault at ascension");
        // post-graduation sell: quote-side hook fee → FeeRouter.creatorAccrued
        address s = makeAddr("gradW0");
        uint256 bal = t.balanceOf(s);
        if (bal == 0) {
            _swapExactInQuoteForToken(t, s, 10 ether);
            bal = t.balanceOf(s);
        }
        _swapExactInTokenForQuote(t, s, bal / 2);
        uint256 frPart = feeRouter.creatorAccrued(address(t), creator);
        vm.prank(creator);
        uint256 out = router.claimCreatorFeesToUsdg(address(t), 1);
        assertEq(out, vaultPart + frPart, "both balances in one claim");
        assertEq(feeVault.creatorAccrued(address(t), creator), 0);
        assertEq(feeRouter.creatorAccrued(address(t), creator), 0);
    }

    // ───────── L2: release capped at the LP share accrued by the timeout; one release only ─────────

    function test_L2_release_onlyPreTimeoutLp_laterLpToCompoundBucket() public {
        (BondingCurve c, Token t) = _launchWallet(0);
        address s = _w();
        _b(c, s, 10 ether); // sniper window → sniper tax
        _warpPastSnipe();
        address w = _w();
        _b(c, w, 200 ether);
        c.settleFees();
        _s(c, t, w, t.balanceOf(w) / 4);
        _bindReferral(referred, kol, 100 ether);
        quote.mint(referred, 1_000 ether);
        _b(c, referred, 30 ether); // referred: settles in-trade
        uint256 sn = c.sniperTaxEscrow();
        // LP share accrued by the timeout: settled LP + LP part of what is still owed
        uint256 preLp = c.lpFeeEscrow() + (uint256(c.protoFeesOwed()) * 33) / 100;
        assertGt(preLp, 0);

        vm.warp(c.launchTime() + c.snipeEscrowTimeout()); // day 12: releasable
        _b(c, w, 80 ether); // post-timeout unreferred trade
        (, uint256 capNow) = c.releasableEscrow();
        assertEq(capNow, preLp, "first fee after the timeout freezes the releasable LP at what accrued by then");
        _b(c, referred, 20 ether); // post-timeout referred trade
        _s(c, t, w, t.balanceOf(w) / 5);
        uint256 postLp = (FeeMath.protocolFee(80 ether) * 33) / 100 + (FeeMath.protocolFee(20 ether) * 33) / 100;

        uint256 v0 = quote.balanceOf(address(rewardsVault));
        uint256 got = c.releaseSnipeEscrow();
        assertEq(got, sn + preLp, "sniper tax + pre-timeout LP only");
        assertEq(quote.balanceOf(address(rewardsVault)) - v0, got);
        assertGe(c.lpFeeEscrow(), postLp, "post-timeout LP shares stay in the curve");
        (uint256 snLeft, uint256 lpLeft) = c.releasableEscrow();
        assertEq(snLeft + lpLeft, 0, "nothing releasable after the release");
        assertEq(c.sniperTaxEscrow(), 0);

        // releasing twice is impossible, also after more trades
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        c.releaseSnipeEscrow();
        _b(c, w, 50 ether);
        c.settleFees();
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        c.releaseSnipeEscrow();

        // graduation: everything still escrowed (post-timeout LP) → compound bucket, nothing more to RewardsVault
        uint256 v1 = quote.balanceOf(address(rewardsVault));
        _graduate(c);
        (, uint256 bucket) = lockedLP.compoundBucket(address(t));
        assertGt(bucket, postLp, "post-timeout LP shares in the compound bucket");
        assertEq(quote.balanceOf(address(rewardsVault)), v1);
        vm.expectRevert(BondingCurve.Graduated.selector);
        c.releaseSnipeEscrow();
    }

    function test_L2_release_noTradeSinceTimeout_takesAllAccrued() public {
        (BondingCurve c, Token t) = _launchWallet(0);
        _b(c, _w(), 10 ether);
        _warpPastSnipe();
        address w = _w();
        _b(c, w, 120 ether);
        _s(c, t, w, t.balanceOf(w) / 3);
        uint256 all = c.sniperTaxEscrow() + c.lpFeeEscrow() + (uint256(c.protoFeesOwed()) * 33) / 100;
        vm.warp(c.launchTime() + c.snipeEscrowTimeout() + 3 days);
        (uint256 a1, uint256 a2) = c.releasableEscrow();
        assertEq(a1 + a2, all, "preview");
        assertEq(c.releaseSnipeEscrow(), all, "no fee after the timeout: all of it accrued by then");
        assertEq(c.lpFeeEscrow(), 0);
        _b(c, w, 40 ether);
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        c.releaseSnipeEscrow();
        c.settleFees();
        assertEq(c.lpFeeEscrow(), (FeeMath.protocolFee(40 ether) * 33) / 100, "later LP kept for the bucket");
    }

    function test_L2_release_nothingAccrued_thenTrades_stillZero() public {
        (BondingCurve c,) = _launchWallet(0);
        vm.warp(c.launchTime() + c.snipeEscrowTimeout());
        vm.expectRevert(BondingCurve.ZeroAmount.selector); // nothing accrued by day 12 (reverts, no state change)
        c.releaseSnipeEscrow();
        _b(c, _w(), 60 ether); // first fee after the timeout: snapshots cap = 0
        (, uint256 lpCap) = c.releasableEscrow();
        assertEq(lpCap, 0, "cap snapshotted at 0");
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        c.releaseSnipeEscrow();
    }

    function testFuzz_L2_releaseEqualsPreTimeoutLp(uint96 a, uint96 b, uint96 x, uint96 y) public {
        (BondingCurve c, Token t) = _launchWallet(0);
        _warpPastSnipe();
        address w = _w();
        _b(c, w, bound(uint256(a), 1 ether, 300 ether));
        _s(c, t, w, t.balanceOf(w) / 4);
        _b(c, w, bound(uint256(b), 1 ether, 200 ether));
        uint256 preLp = c.lpFeeEscrow() + (uint256(c.protoFeesOwed()) * 33) / 100;
        vm.warp(c.launchTime() + c.snipeEscrowTimeout() + 1);
        _b(c, w, bound(uint256(x), 1 ether, 200 ether));
        _s(c, t, w, t.balanceOf(w) / 6);
        _b(c, w, bound(uint256(y), 1 ether, 100 ether));
        uint256 heldBefore = c.lpFeeEscrow() + (uint256(c.protoFeesOwed()) * 33) / 100;
        assertEq(c.releaseSnipeEscrow(), preLp, "release == LP share accrued by the timeout");
        assertGe(c.lpFeeEscrow() + preLp, heldBefore, "nothing lost (aggregate rounding only adds)");
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        c.releaseSnipeEscrow();
    }

    // ───────── gas (new paths) ─────────

    function test_gas_newClaimPaths() public {
        router.setUsdgRouting(address(quote), address(launchpad));
        (BondingCurve c, Token t) = _launchAnon(0);
        (BondingCurve c2, Token t2) = _launchAnon(0);
        (BondingCurve wc, Token wt) = _launchWallet(0);
        _warpPastSnipe();
        address w = _w();
        _b(c, w, 50 ether);
        _b(c2, w, 50 ether);
        _b(wc, w, 50 ether);
        address[6] memory cool = [address(c), address(t), address(quote), address(feeVault), address(launchpad), address(anon)];
        for (uint256 i; i < 6; ++i) vm.cool(cool[i]);
        vm.prank(stealth);
        uint256 g = gasleft();
        feeVault.claimCreatorFeesAsStealth(address(t), stealth);
        console2.log("GAS vault_claimCreatorFeesAsStealth_incl_settle", g - gasleft());
        address[] memory toks = _one(address(t2));
        uint256 dl = block.timestamp + 1 hours;
        CurveFeeVault.ClaimReq memory req = CurveFeeVault.ClaimReq(stealth, toks, stealth, 0, dl, _sig(toks, stealth, 0, dl));
        vm.cool(address(c2));
        vm.cool(address(t2));
        vm.cool(address(feeVault));
        g = gasleft();
        feeVault.claimManyAsStealthBySig(req);
        console2.log("GAS vault_claimCreatorFeesAsStealthBySig_1coin_incl_settle", g - gasleft());
        vm.cool(address(wc));
        vm.cool(address(wt));
        vm.cool(address(feeVault));
        vm.cool(address(router));
        vm.cool(address(feeRouter));
        vm.prank(creator);
        g = gasleft();
        router.claimCreatorFeesToUsdg(address(wt), 1);
        console2.log("GAS router_claimCreatorFeesToUsdg_new_curve_vault", g - gasleft());
    }
}
