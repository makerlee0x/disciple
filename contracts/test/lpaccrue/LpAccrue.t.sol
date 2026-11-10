// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase, MockUSDG} from "../integration/IntegrationBase.sol";
import {console2} from "forge-std/console2.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {CurveFeeVault} from "../../src/CurveFeeVault.sol";
import {CurveDeployer} from "../../src/CurveDeployer.sol";
import {LoginGate} from "../../src/LoginGate.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {Constants} from "../../src/libraries/Constants.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CurveDeployerV1} from "./legacy/CurveDeployerV1.sol";
import {BondingCurveV1} from "./legacy/BondingCurveV1.sol";

interface ICurveLite {
    function buy(uint256 quoteIn, uint256 minTokensOut, uint256 deadline) external returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, uint256 deadline) external returns (uint256);
    function quoteReserve() external view returns (uint256);
    function tokensSold() external view returns (uint256);
    function graduated() external view returns (bool);
    function snipeEscrow() external view returns (uint256);
    function token() external view returns (address);
}

/// @notice lp-accrue (Uniswap v3 accrue-then-collect) + 12-day release + no on-chain LoginGate on NEW curves, against
///         a verbatim copy of the pre-change curve (BondingCurveV1) on the same FeeRouter / LockedLP / Migration.
contract LpAccrueTest is IntegrationBase {
    CurveDeployerV1 internal v1Deployer;
    CurveDeployer internal v2Deployer;
    LoginGate internal gate;
    uint256 internal attesterPk = 0xA77E57;
    uint256 internal nonce_;

    function setUp() public override {
        super.setUp();
        v2Deployer = CurveDeployer(address(launchpad.curveDeployer()));
        v1Deployer = new CurveDeployerV1();
        gate = new LoginGate(owner, vm.addr(attesterPk));
        vm.prank(owner);
        launchpad.setLoginGate(address(gate));
    }

    // ───────── helpers ─────────

    function _launchOn(bool legacy, uint8 mode, uint256 taxBps) internal returns (address c, Token t) {
        vm.prank(owner);
        launchpad.setCurveDeployer(legacy ? address(v1Deployer) : address(v2Deployer));
        vm.startPrank(creator);
        ILaunchpad.LaunchResult memory r = launchpad.launchWithMode(
            ILaunchpad.LaunchParams({
                name: "Acc",
                ticker: "ACC",
                imageURI: "ipfs://img",
                description: "",
                socialsURI: "",
                quote: address(quote),
                creatorTaxBps: taxBps,
                creatorBuyQuoteIn: 0,
                creatorBuyMinTokensOut: 0,
                deadline: vm.getBlockTimestamp() + 1 days
            }),
            mode
        );
        vm.stopPrank();
        c = r.curve;
        t = Token(r.token);
    }

    function _w() internal returns (address w) {
        w = makeAddr(string(abi.encodePacked("lpw", vm.toString(++nonce_))));
        quote.mint(w, 10_000_000 ether);
    }

    function _buyC(address c, address w, uint256 q) internal returns (uint256 out) {
        vm.startPrank(w);
        quote.approve(c, q);
        out = ICurveLite(c).buy(q, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
    }

    function _sellC(address c, address w, uint256 n) internal returns (uint256 out) {
        vm.startPrank(w);
        IERC20(ICurveLite(c).token()).approve(c, n);
        out = ICurveLite(c).sell(n, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
    }

    function _escrowQuote(address token) internal view returns (uint256 e) {
        (,,,, e,,) = lockedLP.positions(token);
    }

    function _verify(address w) internal {
        uint64 exp = uint64(vm.getBlockTimestamp() + 24 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPk, gate.digest(w, exp));
        gate.attest(w, exp, abi.encodePacked(r, s, v));
    }

    // ───────── 1. per-trade accrual ─────────

    function test_perTradeAccrual_unreferred() public {
        (address ca, Token t) = _launchOn(false, Constants.MODE_TRENCH, 100); // 1% creator tax
        BondingCurve c = BondingCurve(ca);
        _warpPastSnipe();
        uint256 frQ = quote.balanceOf(address(feeRouter));
        uint256 lpQ = quote.balanceOf(address(lockedLP));
        address w = _w();
        _buyC(ca, w, 100 ether);
        uint256 p1 = FeeMath.protocolFee(100 ether);
        uint256 x1 = FeeMath.creatorTax(100 ether, 100);
        assertEq(c.protoFeesOwed(), p1, "proto owed");
        assertEq(c.creatorTaxOwed(), x1, "tax owed");
        _sellC(ca, w, t.balanceOf(w) / 2);
        assertGt(c.protoFeesOwed(), p1, "sell accrues too");
        assertEq(quote.balanceOf(address(feeRouter)), frQ, "no per-trade FeeRouter transfer");
        assertEq(quote.balanceOf(address(lockedLP)), lpQ, "no per-trade LockedLP transfer");
        assertEq(quote.balanceOf(address(feeVault)), 0, "nothing settled yet");
        assertEq(
            quote.balanceOf(ca),
            c.quoteReserve() + c.sniperTaxEscrow() + c.lpFeeEscrow() + c.protoFeesOwed() + c.creatorTaxOwed()
                + c.rewardsHeld(),
            "curve holds exactly reserve + escrows + owed"
        );
    }

    function test_referredTrader_settlesInTrade_exactAttribution() public {
        (address ca,) = _launchOn(false, Constants.MODE_TRENCH, 0);
        BondingCurve c = BondingCurve(ca);
        _warpPastSnipe();
        _bindReferral(referred, kol, 100 ether);
        assertEq(referrals.referrerOf(referred), kol);
        _buyC(ca, referred, 100 ether);
        uint256 p = FeeMath.protocolFee(100 ether);
        (uint256 cr, uint256 lp, uint256 tr, uint256 rf) = FeeMath.splitTradeFee(p);
        assertEq(c.protoFeesOwed(), 0, "referred: settled in the trade");
        assertEq(feeVault.referrerAccrued(kol, address(quote)), rf, "referrer 1% exact");
        assertEq(feeVault.creatorAccrued(address(c.token()), creator), cr);
        assertEq(feeVault.treasuryAccrued(address(quote)), tr);
        assertEq(c.lpFeeEscrow(), lp, "LP share kept in curve escrow");
        assertEq(quote.balanceOf(address(feeVault)), cr + tr + rf, "vault backed");
    }

    // ───────── 2. settle-at-ascension → LockedLP compound bucket (vs old curve) ─────────

    function _driveToGraduation(address c) internal {
        for (uint256 i; i < 120 && !ICurveLite(c).graduated(); ++i) {
            address w = makeAddr(string(abi.encodePacked("g", vm.toString(i), c)));
            quote.mint(w, 1_000_000 ether);
            uint256[5] memory sizes = [uint256(300 ether), 100 ether, 30 ether, 10 ether, 1 ether];
            for (uint256 j; j < 5 && !ICurveLite(c).graduated(); ++j) {
                vm.startPrank(w);
                quote.approve(c, sizes[j]);
                try ICurveLite(c).buy(sizes[j], 0, block.timestamp + 1) {
                    vm.stopPrank();
                    break;
                } catch {
                    vm.stopPrank();
                }
            }
        }
        require(ICurveLite(c).graduated(), "not graduated");
    }

    function test_settleAtAscension_lpLandsInCompoundBucket_sameAsOld() public {
        (address oldC, Token oldT) = _launchOn(true, Constants.MODE_TRENCH, 0);
        (address newC, Token newT) = _launchOn(false, Constants.MODE_TRENCH, 0);
        // same sniper-window buy on both (sniper tax → escrow), then drive both to graduation
        address s1 = _w();
        _buyC(oldC, s1, 10 ether);
        address s2 = _w();
        _buyC(newC, s2, 10 ether);
        uint256 newSnipe = BondingCurve(newC).sniperTaxEscrow();
        assertEq(BondingCurveV1(oldC).snipeEscrow(), newSnipe, "same sniper tax");
        _warpPastSnipe();
        _driveToGraduation(oldC);
        uint256 lpOld = _escrowQuote(address(oldT)); // old: per-trade LP share in LockedLP escrow (pre-seed read n/a)
        lpOld; // escrow is folded at migration; compare final compound buckets instead
        _driveToGraduation(newC);
        assertEq(BondingCurve(newC).protoFeesOwed(), 0, "owed settled at graduation");
        assertEq(BondingCurve(newC).lpFeeEscrow(), 0, "LP escrow passed to migration");
        assertEq(BondingCurve(newC).sniperTaxEscrow(), 0);
        (, uint256 bOld) = lockedLP.compoundBucket(address(oldT));
        (, uint256 bNew) = lockedLP.compoundBucket(address(newT));
        console2.log("compound bucket quote old/new", bOld, bNew);
        assertGt(bNew, newSnipe, "bucket holds sniper tax + LP share");
        // identical trade sequences: buckets equal up to per-trade floor dust (aggregate split rounds once)
        assertApproxEqAbs(bNew, bOld, 1e6, "LP share lands in the same compound bucket");
        // creator / treasury: old in FeeRouter, new in the vault; same totals up to rounding dust
        assertApproxEqAbs(
            feeVault.creatorAccrued(address(newT), creator), feeRouter.creatorAccrued(address(oldT), creator), 1e6
        );
    }

    // ───────── 3. claim mid-curve (settle first, then pay, exact) ─────────

    function test_claimMidCurve_creatorTreasuryKol() public {
        _bindReferral(creator, kol, 100 ether); // creator referred ⇒ launch KOL coin
        (address ca, Token t) = _launchOn(false, Constants.MODE_TRENCH, 50);
        BondingCurve c = BondingCurve(ca);
        assertEq(feeRouter.tokenLaunchKol(address(t)), kol);
        _warpPastSnipe();
        address w = _w();
        _buyC(ca, w, 200 ether);
        _sellC(ca, w, t.balanceOf(w) / 3);
        uint256 P = c.protoFeesOwed();
        uint256 X = c.creatorTaxOwed();
        (uint256 cr, uint256 lp, uint256 tr, uint256 rf) = FeeMath.splitTradeFee(P);
        uint256 kolCut = (cr * feeRouter.kolCreatorShareBps()) / Constants.BPS_DENOM;

        uint256 c0 = quote.balanceOf(creator);
        vm.prank(creator);
        uint256 got = feeVault.claimCreatorFees(address(t));
        assertEq(got, cr - kolCut + X, "creator: 33% - KOL cut + tax, settled first");
        assertEq(quote.balanceOf(creator) - c0, got);
        assertEq(c.protoFeesOwed(), 0, "claim settled the coin");
        assertEq(c.lpFeeEscrow(), lp, "LP share stays in curve");

        address[] memory toks = new address[](1);
        toks[0] = address(t);
        uint256 t0 = quote.balanceOf(treasury);
        feeVault.claimTreasury(address(quote), toks);
        assertEq(quote.balanceOf(treasury) - t0, tr, "treasury 33% exact");

        uint256 k0 = quote.balanceOf(kol);
        vm.prank(kol);
        feeVault.claimReferrerFees(address(quote), toks);
        assertEq(quote.balanceOf(kol) - k0, rf + kolCut, "KOL: 1% + creator-share cut");
        assertEq(quote.balanceOf(address(feeVault)), 0, "vault fully paid out, no dust lost");

        // owed accrues again after a claim and a second claim settles it first
        _buyC(ca, w, 50 ether);
        vm.prank(creator);
        assertGt(feeVault.claimCreatorFees(address(t)), 0);
        vm.prank(creator);
        vm.expectRevert(CurveFeeVault.NothingToClaim.selector);
        feeVault.claimCreatorFees(address(t));
    }

    function test_vaultSettle_onlyRegisteredCurve() public {
        (address ca, Token t) = _launchOn(false, Constants.MODE_TRENCH, 0);
        ca;
        vm.expectRevert(CurveFeeVault.OnlyCurve.selector);
        feeVault.settle(address(t), address(quote), address(0), 1 ether, 0);
    }

    // ───────── 4. totals invariant vs the old split ─────────

    function testFuzz_totalsMatchOldSplit(uint96 a, uint96 b, uint16 taxBps) public {
        uint256 qa = bound(uint256(a), 1 ether, 400 ether);
        uint256 qb = bound(uint256(b), 1 ether, 400 ether);
        uint256 tax = bound(uint256(taxBps), 0, Constants.CREATOR_TAX_MAX_BPS);
        (address oldC, Token oldT) = _launchOn(true, Constants.MODE_TRENCH, tax);
        (address newC, Token newT) = _launchOn(false, Constants.MODE_TRENCH, tax);
        _warpPastSnipe();
        address w1 = _w();
        address w2 = _w();
        _buyC(oldC, w1, qa);
        _buyC(newC, w2, qa);
        _sellC(oldC, w1, oldT.balanceOf(w1) / 2);
        _sellC(newC, w2, newT.balanceOf(w2) / 2);
        _buyC(oldC, w1, qb);
        _buyC(newC, w2, qb);
        BondingCurve(newC).settleFees();
        uint256 oldCreator = feeRouter.creatorAccrued(address(oldT), creator);
        uint256 oldLp = _escrowQuote(address(oldT));
        uint256 newCreator = feeVault.creatorAccrued(address(newT), creator);
        uint256 newLp = BondingCurve(newC).lpFeeEscrow();
        uint256 newTr = feeVault.treasuryAccrued(address(quote));
        // old treasury accrued = FeeRouter.treasuryAccrued (only this coin traded in this test)
        uint256 oldTr = feeRouter.treasuryAccrued(address(quote));
        assertEq(newCreator + newLp + newTr, oldCreator + oldLp + oldTr, "total fee identical");
        assertApproxEqAbs(newCreator, oldCreator, 3, "creator within per-trade floor dust");
        assertApproxEqAbs(newLp, oldLp, 3, "LP within dust");
        assertApproxEqAbs(newTr, oldTr, 6, "treasury within dust");
        assertEq(BondingCurve(newC).quoteReserve(), BondingCurveV1(oldC).quoteReserve(), "reserves identical");
    }

    // ───────── 5. old curves unaffected ─────────

    function test_oldCurve_unchanged_perTradeRouting() public {
        (address oldC, Token oldT) = _launchOn(true, Constants.MODE_TRENCH, 0);
        _warpPastSnipe();
        address w = _w();
        _buyC(oldC, w, 100 ether);
        (uint256 cr, uint256 lp,,) = FeeMath.splitTradeFee(FeeMath.protocolFee(100 ether));
        assertEq(feeRouter.creatorAccrued(address(oldT), creator), cr, "old: FeeRouter credited per trade");
        assertEq(_escrowQuote(address(oldT)), lp, "old: LP pushed to LockedLP per trade");
        assertEq(feeVault.creatorAccrued(address(oldT), creator), 0, "vault untouched");
        assertEq(BondingCurveV1(oldC).snipeEscrowTimeout(), 12 days, "new default snapshotted (fresh Launchpad)");
    }

    function test_oldPveCurve_stillRequiresLogin_newPveCurveDoesNot() public {
        (address oldC,) = _launchOn(true, Constants.MODE_PVE, 0);
        (address newC, Token newT) = _launchOn(false, Constants.MODE_PVE, 0);
        _warpPastSnipe();
        address w = _w(); // never attested on LoginGate
        vm.startPrank(w);
        quote.approve(oldC, 10 ether);
        vm.expectRevert(BondingCurveV1.NotVerified.selector);
        ICurveLite(oldC).buy(10 ether, 0, block.timestamp + 1);
        vm.stopPrank();
        uint256 out = _buyC(newC, w, 10 ether); // new curve: no on-chain login (app-level gating)
        assertGt(out, 0);
        assertGt(_sellC(newC, w, newT.balanceOf(w) / 2), 0, "sell ok too");
        assertEq(BondingCurve(newC).verifiedUntilOf(w), 0, "nothing recorded on-chain");
        _verify(w);
        assertGt(_buyC(oldC, w, 10 ether), 0, "old curve: works once verified (unchanged)");
    }

    // ───────── 6. 12-day release (sniper tax + LP share → RewardsVault) ─────────

    function test_release_before12d_reverts_after_works_reservesUntouched() public {
        (address ca, Token t) = _launchOn(false, Constants.MODE_TRENCH, 0);
        BondingCurve c = BondingCurve(ca);
        assertEq(c.snipeEscrowTimeout(), 12 days, "12-day default");
        address s = _w();
        _buyC(ca, s, 10 ether); // sniper window
        _warpPastSnipe();
        address w = _w();
        _buyC(ca, w, 100 ether);
        _sellC(ca, w, t.balanceOf(w) / 4);
        uint256 sn = c.sniperTaxEscrow();
        assertGt(sn, 0);

        vm.warp(c.launchTime() + 12 days - 1);
        vm.expectRevert(BondingCurve.EscrowLocked.selector);
        c.releaseSnipeEscrow();

        vm.warp(c.launchTime() + 12 days);
        uint256 P = c.protoFeesOwed();
        (uint256 cr,, uint256 tr, uint256 rf) = FeeMath.splitTradeFee(P);
        uint256 lpTotal = c.lpFeeEscrow() + (P * 33) / 100;
        uint256 reserve = c.quoteReserve();
        uint256 sold = c.tokensSold();
        uint256 inv = t.balanceOf(ca);
        uint256 v0 = quote.balanceOf(address(rewardsVault));
        uint256 got = c.releaseSnipeEscrow();
        assertEq(got, sn + lpTotal, "sniper tax + LP share");
        assertEq(quote.balanceOf(address(rewardsVault)) - v0, sn + lpTotal, "to RewardsVault");
        assertEq(c.quoteReserve(), reserve, "quoteReserve unchanged");
        assertEq(c.tokensSold(), sold, "tokensSold unchanged");
        assertEq(t.balanceOf(ca), inv, "inventory unchanged");
        assertEq(quote.balanceOf(ca), reserve + c.rewardsHeld(), "curve still backs its reserve exactly");
        // creator / treasury / 1% unaffected: settled to the vault, claimable
        assertEq(feeVault.creatorAccrued(address(t), creator), cr);
        assertEq(feeVault.treasuryAccrued(address(quote)), tr + rf);

        // second release: nothing to move (reverts ZeroAmount, no state change)
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        c.releaseSnipeEscrow();

        // L2 (lee 2026-11-09): later LP shares stay in the curve for the compound bucket; never released
        _buyC(ca, w, 50 ether);
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        c.releaseSnipeEscrow();
        c.settleFees();
        assertEq(c.lpFeeEscrow(), (FeeMath.protocolFee(50 ether) * 33) / 100, "post-release LP share kept");
    }

    function test_graduationBefore12d_goesToCompoundBucket_notVault() public {
        (address ca, Token t) = _launchOn(false, Constants.MODE_TRENCH, 0);
        address s = _w();
        _buyC(ca, s, 10 ether);
        uint256 sn = BondingCurve(ca).sniperTaxEscrow();
        _warpPastSnipe();
        uint256 v0 = quote.balanceOf(address(rewardsVault));
        _driveToGraduation(ca);
        assertLt(block.timestamp, BondingCurve(ca).launchTime() + 12 days);
        (, uint256 b) = lockedLP.compoundBucket(address(t));
        assertGt(b, sn, "sniper tax + LP share in compound bucket");
        assertEq(quote.balanceOf(address(rewardsVault)), v0, "nothing to the vault");
        vm.warp(BondingCurve(ca).launchTime() + 13 days);
        vm.expectRevert(BondingCurve.Graduated.selector);
        BondingCurve(ca).releaseSnipeEscrow();
    }

    // ───────── 7. gas: old vs new curve, buy + sell (cold, per trade) ─────────

    function _cool(address c, address t) internal {
        address[9] memory a =
            [c, t, address(quote), address(feeRouter), address(lockedLP), address(launchpad), address(referrals), address(feeVault), address(gate)];
        for (uint256 i; i < a.length; ++i) {
            vm.cool(a[i]);
        }
    }

    function _gasPair(address c, Token t, address w) internal returns (uint256 gb, uint256 gs) {
        return _gasPairGap(c, t, w, 0);
    }

    /// @dev `gap` > PVE_LOGIN_CACHE_TTL makes the old PVE curve re-read LoginGate on the measured buy (cache miss).
    function _gasPairGap(address c, Token t, address w, uint256 gap) internal returns (uint256 gb, uint256 gs) {
        _buyC(c, w, 50 ether); // warm-up trade so slots are non-zero (steady state, like a live coin)
        if (gap != 0) {
            vm.warp(block.timestamp + gap);
            _verify(w);
        }
        vm.startPrank(w);
        quote.approve(c, 10 ether);
        t.approve(c, type(uint256).max);
        _cool(c, address(t));
        uint256 g = gasleft();
        ICurveLite(c).buy(10 ether, 0, block.timestamp + 1);
        gb = g - gasleft();
        uint256 n = t.balanceOf(w) / 10;
        _cool(c, address(t));
        g = gasleft();
        ICurveLite(c).sell(n, 0, block.timestamp + 1);
        gs = g - gasleft();
        vm.stopPrank();
    }

    function test_gas_oldVsNew() public {
        (address oT, Token oTt) = _launchOn(true, Constants.MODE_TRENCH, 0);
        (address nT, Token nTt) = _launchOn(false, Constants.MODE_TRENCH, 0);
        (address oP, Token oPt) = _launchOn(true, Constants.MODE_PVE, 0);
        (address nP, Token nPt) = _launchOn(false, Constants.MODE_PVE, 0);
        _warpPastSnipe();
        address w = _w();
        _verify(w);
        address w2 = _w();
        _verify(w2);
        (uint256 ob, uint256 os) = _gasPair(oT, oTt, w);
        (uint256 nb, uint256 ns) = _gasPair(nT, nTt, w);
        (uint256 opb, uint256 ops) = _gasPair(oP, oPt, w2);
        (uint256 npb, uint256 nps) = _gasPair(nP, nPt, w2);
        console2.log("TRENCH buy  old/new", ob, nb);
        console2.log("TRENCH sell old/new", os, ns);
        console2.log("PVE    buy  old/new", opb, npb);
        console2.log("PVE    sell old/new", ops, nps);
        // PVE login-cache miss (old curve re-reads LoginGate after PVE_LOGIN_CACHE_TTL = 10 min): the ~13k item
        (uint256 opb2,) = _gasPairGap(oP, oPt, w2, 11 minutes);
        (uint256 npb2,) = _gasPairGap(nP, nPt, w2, 11 minutes);
        console2.log("PVE    buy  old/new, login cache expired (old re-reads LoginGate)", opb2, npb2);
        _bindReferral(referred, kol, 100 ether);
        quote.mint(referred, 1_000 ether);
        (uint256 rb, uint256 rs) = _gasPair(nT, nTt, referred);
        console2.log("TRENCH referred trader buy/sell (new, settles in trade)", rb, rs);
        assertLt(nb, ob);
        assertLt(ns, os);
        assertLt(npb, opb);
    }
}
