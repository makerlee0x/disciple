// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {console2} from "forge-std/console2.sol";
import {Vm} from "forge-std/Vm.sol";
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
import {RewardsVault} from "../../src/RewardsVault.sol";
import {DeployRewardsVault} from "../../script/rewards/DeployRewardsVault.s.sol";

/// @notice lp-accrue follow-ups (lee 2026-11-09 9:16 PM CT): H1 stealth-owner vault claim, M1 router claim covers the
///         vault; LP rule (10:17 PM CT): a coin not graduated by day 12 sends ALL its curve LP fees to RewardsVault.
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

    // ───────── LP rule (lee 2026-11-09 10:17 PM CT): not graduated by day 12 ⇒ ALL curve LP fees → RewardsVault ─────────
    // ───────── sniper tax (lee 2026-11-10 7:44 AM CT): "the sniper tax should go to community rewards" (late graduation too) ─────────

    bytes32 internal constant LP_REL = keccak256("LpFeeEscrowReleased(address,address,uint256)");
    bytes32 internal constant SN_REL = keccak256("SnipeEscrowReleased(address,address,uint256)");
    bytes32 internal constant TO_LP = keccak256("SnipeEscrowToLP(address,uint256)");

    /// @dev LP fee share held by the curve right now (settled + the LP part of what is still owed).
    function _lpHeld(BondingCurve c) internal view returns (uint256) {
        return c.lpFeeEscrow() + (uint256(c.protoFeesOwed()) * Constants.FEE_SHARE_LP_LOCK) / Constants.FEE_SHARE_DENOM;
    }

    /// @dev Sums of the escrow events `c` emitted in the recorded logs: LP → vault, sniper → vault, escrow → bucket.
    function _escrowEvents(BondingCurve c) internal returns (uint256 lpRel, uint256 snRel, uint256 toLp) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(c)) continue;
            bytes32 t0 = logs[i].topics[0];
            if (t0 == LP_REL) lpRel += abi.decode(logs[i].data, (uint256));
            else if (t0 == SN_REL) snRel += abi.decode(logs[i].data, (uint256));
            else if (t0 == TO_LP) toLp += abi.decode(logs[i].data, (uint256));
        }
    }

    function test_LP_neverGraduates_repeatedReleases_allLpToVault_noDoublePay() public {
        (BondingCurve c, Token t) = _launchWallet(0);
        _b(c, _w(), 10 ether); // sniper window → sniper tax
        _warpPastSnipe();
        address w = _w();
        _b(c, w, 200 ether);
        _s(c, t, w, t.balanceOf(w) / 4);
        _bindReferral(referred, kol, 100 ether);
        quote.mint(referred, 1_000 ether);
        _b(c, referred, 30 ether); // referred: settles in-trade
        uint256 sn = c.sniperTaxEscrow();
        assertGt(sn, 0);

        vm.warp(c.launchTime() + c.snipeEscrowTimeout() - 1);
        vm.expectRevert(BondingCurve.EscrowLocked.selector);
        c.releaseSnipeEscrow();
        vm.warp(c.launchTime() + c.snipeEscrowTimeout());
        _b(c, w, 80 ether); // after day 12: still to the vault (lee: "those lp fees should always go to the creator rewards")
        _b(c, referred, 20 ether);
        uint256 lp1 = _lpHeld(c);

        uint256 v0 = quote.balanceOf(address(rewardsVault));
        uint256 got1 = c.releaseSnipeEscrow();
        assertEq(got1, sn + lp1, "1st release: sniper tax + ALL LP so far (before and after day 12)");
        assertEq(c.lpFeeEscrow(), 0);
        assertEq(c.sniperTaxEscrow(), 0);
        assertEq(c.protoFeesOwed(), 0, "release settles everything owed");
        vm.expectRevert(BondingCurve.ZeroAmount.selector); // nothing new: no double pay
        c.releaseSnipeEscrow();

        // later trades on the never-graduated coin: released again, nothing stranded
        _s(c, t, w, t.balanceOf(w) / 5);
        _b(c, w, 50 ether);
        uint256 lp2 = _lpHeld(c);
        assertGt(lp2, 0);
        uint256 got2 = c.releaseSnipeEscrow();
        assertEq(got2, lp2, "repeat release: exactly the LP accrued since");
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        c.releaseSnipeEscrow();
        assertEq(quote.balanceOf(address(rewardsVault)) - v0, sn + lp1 + lp2, "vault got each share once");
        assertEq(quote.balanceOf(address(c)), c.quoteReserve() + c.rewardsHeld(), "only the reserve is left");
    }

    function test_LP_graduatesWithin12d_lpAndSniperToCompoundBucket() public {
        (BondingCurve c, Token t) = _launchWallet(0);
        _b(c, _w(), 10 ether);
        uint256 sn = c.sniperTaxEscrow();
        uint256 v0 = quote.balanceOf(address(rewardsVault));
        vm.recordLogs();
        _graduate(c);
        assertLt(block.timestamp, c.launchTime() + c.snipeEscrowTimeout());
        (uint256 lpRel, uint256 snRel, uint256 toLp) = _escrowEvents(c);
        assertEq(lpRel + snRel, 0, "nothing released");
        assertGt(toLp, sn, "sniper tax + LP fees to the compound bucket");
        assertEq(quote.balanceOf(address(rewardsVault)), v0);
        (, uint256 bucket) = lockedLP.compoundBucket(address(t));
        assertGe(bucket, toLp);
        assertEq(quote.balanceOf(address(c)), c.rewardsHeld(), "everything migrated");
    }

    function test_LP_graduatesLate_noRelease_lpAndSniperToVault() public {
        (BondingCurve c, Token t) = _launchWallet(0);
        _b(c, _w(), 10 ether);
        _warpPastSnipe();
        address w = _w();
        _b(c, w, 200 ether);
        _s(c, t, w, t.balanceOf(w) / 4);
        uint256 sn = c.sniperTaxEscrow();
        uint256 lpPre = _lpHeld(c);
        vm.warp(c.launchTime() + c.snipeEscrowTimeout() + 1 days); // nobody released
        uint256 v0 = quote.balanceOf(address(rewardsVault));
        vm.recordLogs();
        (, uint256 bucket0) = lockedLP.compoundBucket(address(t));
        _graduate(c); // the graduating buy decides: past day 12 → LP + sniper tax to RewardsVault
        (uint256 lpRel, uint256 snRel, uint256 toLp) = _escrowEvents(c);
        assertGt(sn, 0);
        assertGt(lpRel, lpPre, "all LP: before day 12, after it, and the graduating buy's share");
        assertEq(snRel, sn, "sniper tax to community rewards too (lee 2026-11-10)");
        assertEq(quote.balanceOf(address(rewardsVault)) - v0, lpRel + sn, "vault got exactly LP fees + sniper tax");
        assertEq(toLp, 0, "nothing to the compound bucket");
        (, uint256 bucket1) = lockedLP.compoundBucket(address(t));
        // only the full-range add's unpaired rounding leftover (GraduationLeftover) can reach the bucket
        assertLt(bucket1 - bucket0, sn / 1e6, "neither escrow went to the compound bucket");
        assertEq(c.lpFeeEscrow(), 0);
        assertEq(c.sniperTaxEscrow(), 0);
        assertEq(quote.balanceOf(address(c)), c.rewardsHeld(), "everything moved, nothing paid twice");
        vm.expectRevert(BondingCurve.Graduated.selector);
        c.releaseSnipeEscrow();
    }

    function test_LP_graduatesLate_afterRelease_restToVault_noDoublePay() public {
        (BondingCurve c, Token t) = _launchWallet(0);
        _b(c, _w(), 10 ether);
        _warpPastSnipe();
        address w = _w();
        _b(c, w, 150 ether);
        vm.warp(c.launchTime() + c.snipeEscrowTimeout());
        uint256 sn = c.sniperTaxEscrow();
        uint256 lp1 = _lpHeld(c);
        uint256 v0 = quote.balanceOf(address(rewardsVault));
        vm.recordLogs();
        assertEq(c.releaseSnipeEscrow(), sn + lp1);
        _s(c, t, w, t.balanceOf(w) / 3);
        _graduate(c);
        (uint256 lpRel, uint256 snRel, uint256 toLp) = _escrowEvents(c);
        assertEq(snRel, sn);
        assertGt(lpRel, lp1, "release + graduation: every LP share");
        assertEq(toLp, 0, "nothing left for the bucket");
        assertEq(quote.balanceOf(address(rewardsVault)) - v0, sn + lpRel, "each share paid once");
        assertEq(quote.balanceOf(address(c)), c.rewardsHeld());
    }

    /// @dev Kept on purpose (COO): with FeeRouter.rewardsVault() unset, a late graduation still sends both escrows to the
    ///      compound bucket instead of reverting the graduating buy.
    function test_LP_graduatesLate_noVault_fallbackToBucket() public {
        (BondingCurve c,) = _launchWallet(0);
        _b(c, _w(), 10 ether);
        _warpPastSnipe();
        _b(c, _w(), 150 ether);
        vm.prank(owner);
        feeRouter.setRewardsVault(address(0));
        vm.warp(c.launchTime() + c.snipeEscrowTimeout() + 1 days);
        uint256 sn = c.sniperTaxEscrow();
        vm.recordLogs();
        _graduate(c);
        (uint256 lpRel, uint256 snRel, uint256 toLp) = _escrowEvents(c);
        assertEq(lpRel + snRel, 0, "no vault: nothing released");
        assertGt(toLp, sn, "sniper tax + LP to the bucket (old destination)");
        assertEq(quote.balanceOf(address(c)), c.rewardsHeld());
    }

    /// @dev Conservation over random sequences: every LP share ends in exactly one place (vault or bucket), the vault
    ///      only gets LP when the coin is past day 12, and the bucket only when it graduated within day 12.
    function testFuzz_LP_rule(uint96 a, uint96 b, uint96 x, bool releaseMid, bool late, bool grad, bool sniped) public {
        (BondingCurve c, Token t) = _launchWallet(0);
        if (sniped) _b(c, _w(), 10 ether); // sniper window → sniper tax
        uint256 sn = c.sniperTaxEscrow();
        _warpPastSnipe();
        address w = _w();
        _b(c, w, bound(uint256(a), 1 ether, 300 ether));
        _s(c, t, w, t.balanceOf(w) / 4);
        if (late) vm.warp(c.launchTime() + c.snipeEscrowTimeout());
        _b(c, w, bound(uint256(b), 1 ether, 200 ether));
        vm.recordLogs();
        if (late && releaseMid) c.releaseSnipeEscrow();
        _b(c, w, bound(uint256(x), 1 ether, 100 ether));
        if (grad) _graduate(c);
        else if (late) c.releaseSnipeEscrow();
        (uint256 lpRel, uint256 snRel, uint256 toLp) = _escrowEvents(c);
        if (!late && grad) {
            assertEq(lpRel + snRel, 0, "within day 12: nothing to the vault");
            assertGe(toLp, sn, "within day 12: sniper tax + LP to the bucket");
        }
        if (late) {
            assertEq(toLp, 0, "past day 12: nothing to the bucket");
            assertEq(snRel, sn, "past day 12: sniper tax to the vault exactly once");
        }
        if (grad || late) {
            assertEq(c.lpFeeEscrow(), 0, "nothing stranded");
            assertEq(quote.balanceOf(address(c)), c.quoteReserve() + c.rewardsHeld(), "every share moved once");
        }
    }

    // ───────── RewardsVault (lee 2026-11-10 7:44 AM CT): "a temporary wallet for now, but it should go to a multisig for mainnet" ─────────

    /// @dev script/rewards/DeployRewardsVault.s.sol (NOT run live): vault nominated to a temp wallet, wired by the
    ///      FeeRouter owner, receives a late graduation's escrows, then moves to a multisig with the Owned2Step steps.
    function test_RV_deployScript_tempOwner_thenMultisig() public {
        address temp = makeAddr("tempRewardsOwner");
        address multisig = makeAddr("multisigSafe");
        vm.etch(multisig, hex"00"); // stand-in for a Safe (has code)
        vm.setEnv("REWARDS_VAULT_OWNER", vm.toString(temp));
        vm.setEnv("LAUNCHPAD", vm.toString(address(launchpad)));
        vm.setEnv("WIRE", "false");
        RewardsVault old = rewardsVault;
        RewardsVault v = new DeployRewardsVault().run();
        assertEq(v.feeRouter(), address(feeRouter));
        assertEq(v.pendingOwner(), temp, "deploy only nominates the temp wallet");
        assertEq(feeRouter.rewardsVault(), address(old), "WIRE=false: FeeRouter untouched");
        vm.prank(temp);
        v.acceptOwnership();
        assertEq(v.owner(), temp);
        vm.prank(owner); // FeeRouter owner wires it
        feeRouter.setRewardsVault(address(v));

        (BondingCurve c,) = _launchWallet(0);
        _b(c, _w(), 10 ether);
        _warpPastSnipe();
        _b(c, _w(), 150 ether);
        vm.warp(c.launchTime() + c.snipeEscrowTimeout() + 1 days);
        uint256 sn = c.sniperTaxEscrow();
        uint256 oldBal = quote.balanceOf(address(old));
        _graduate(c);
        assertGt(quote.balanceOf(address(v)), sn, "late graduation: sniper tax + LP to the new vault");
        assertEq(quote.balanceOf(address(old)), oldBal, "old vault untouched");

        // later: temp wallet → multisig (two-step; temp keeps control until the multisig accepts)
        vm.prank(temp);
        v.transferOwnership(multisig);
        assertEq(v.owner(), temp);
        vm.prank(multisig);
        v.acceptOwnership();
        assertEq(v.owner(), multisig);
        address[] memory to = new address[](1);
        uint256[] memory amt = new uint256[](1);
        to[0] = makeAddr("recipient");
        amt[0] = 1 ether;
        vm.prank(multisig);
        v.distribute(address(quote), to, amt);
        assertEq(quote.balanceOf(to[0]), 1 ether);
    }

    function test_RV_deployScript_offTestnet_requiresMultisigOwner() public {
        DeployRewardsVault script = new DeployRewardsVault();
        vm.setEnv("LAUNCHPAD", vm.toString(address(launchpad)));
        vm.setEnv("WIRE", "false");
        vm.setEnv("REWARDS_VAULT_OWNER", vm.toString(makeAddr("eoaOwner")));
        vm.chainId(1);
        vm.expectRevert(bytes("mainnet: REWARDS_VAULT_OWNER must be the multisig (has code)"));
        script.run();
        address safe = makeAddr("safeOwner");
        vm.etch(safe, hex"00");
        vm.setEnv("REWARDS_VAULT_OWNER", vm.toString(safe));
        assertEq(script.run().pendingOwner(), safe);
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
