// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Audit report 2/4 (2026-11-17) proof-of-concept tests. They reproduced every finding at 71ff3f9; each one now
// asserts the fix.

import {console2} from "forge-std/console2.sol";
import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {CreatorFeeRoutingTest} from "../CreatorFeeRouting.t.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {CurveFeeVault} from "../../src/CurveFeeVault.sol";
import {CurveMath} from "../../src/libraries/CurveMath.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract EvilCurve {
    address public immutable quote;
    FeeRouter public immutable fr;

    constructor(address quote_, address feeRouter_) {
        quote = quote_;
        fr = FeeRouter(feeRouter_);
    }

    function forgeRouter(address token, address creator_, uint256 amount) external {
        fr.routeTradeFee(token, quote, address(this), creator_, 0, amount);
    }

    function forgeVault(CurveFeeVault v, address token, uint256 amount) external {
        v.settleCurveFee(token, quote, address(0), 0, amount);
    }

    function settleFees() external pure returns (uint256, uint256) {
        return (0, 0);
    }
}

contract EvilDeployer {
    address public immutable q;

    constructor(address q_) {
        q = q_;
    }

    function deploy(
        address,
        address,
        address,
        address feeRouter,
        address,
        uint256,
        CurveMath.Params calldata,
        uint256,
        uint8,
        address,
        address,
        uint256,
        uint256
    ) external returns (address) {
        return address(new EvilCurve(q, feeRouter));
    }
}

contract AuditPoC3 is IntegrationBase {
    function _snipedGrad(uint256 snipe) internal returns (Token tok) {
        BondingCurve c;
        (c, tok) = _launch(0, 0);
        quote.mint(sniper, snipe);
        _buy(c, sniper, snipe, 0);
        _graduate(c);
        _refReady(tok);
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _holdPump(Token tok, uint256 pump, uint256 windows, bool doFlush) internal returns (int256) {
        address att = makeAddr("holder");
        _swapExactInQuoteForToken(tok, att, pump);
        uint256 added;
        for (uint256 i; i < windows; ++i) {
            vm.warp(vm.getBlockTimestamp() + 61);
            vm.roll(vm.getBlockNumber() + 1);
            if (doFlush) added += lockedLP.flush(address(tok));
        }
        _swapExactInTokenForQuote(tok, att, tok.balanceOf(att));
        console2.log("windows / liquidity added", windows, added);
        return int256(quote.balanceOf(att)) - int256(pump);
    }

    function test_A1_heldPump_flushEveryWindow_beatsTheFees() public {
        Token tok = _snipedGrad(3_000 ether);
        vm.prank(owner);
        lockedLP.setCompoundParams(1_000, 5_000);
        (uint256 bt, uint256 bq) = lockedLP.compoundBucket(address(tok));
        console2.log("bucket token / quote", bt, bq);

        uint256 pump = 50_000 ether;
        uint256 n = 8;
        uint256 snap = vm.snapshotState();
        int256 atk = _holdPump(tok, pump, n, true);
        (, uint256 bqAfter) = lockedLP.compoundBucket(address(tok));
        vm.revertToState(snap);
        int256 ctl = _holdPump(tok, pump, n, false);
        console2.log("attacker PnL (quote wei)");
        console2.logInt(atk);
        console2.log("control PnL, no flush");
        console2.logInt(ctl);
        console2.log("quote bucket before / after", bq, bqAfter);
        assertLt(ctl, 0, "without flushes the round trip loses the fees");
        // Fixed: the reference-tick band stops flushes while the pump is held, so flushing gains nothing.
        assertLt(atk, 0, "held pump + flushes is no longer profitable");
        assertGe(bqAfter, bq, "bucket never spent at the dislocated price");
    }

    function test_A2_ownerCurveDeployer_drainsFeeRouterAndVault() public {
        (BondingCurve c, Token tok) = _launch(500, 0);
        _graduate(c);
        _refReady(tok);
        _swapExactInQuoteForToken(tok, trader1, 2_000 ether);
        _swapExactInTokenForQuote(tok, trader1, tok.balanceOf(trader1));
        c.settleFees();
        uint256 frBal = quote.balanceOf(address(feeRouter));
        uint256 vBal = quote.balanceOf(address(feeVault));
        uint256 victimOwed = feeRouter.creatorAccrued(address(tok), creator);
        assertGt(frBal, 0);
        assertGt(vBal, 0);
        assertGt(victimOwed, 0);

        address evil = address(new EvilDeployer(address(quote)));
        // Fixed: the curve deployer is write-once, so the fake-curve path is closed.
        vm.prank(launchpad.owner());
        vm.expectRevert(Launchpad.CurveDeployerUnset.selector);
        launchpad.setCurveDeployer(evil);
        // And once fee settings are locked no new claim router can be added (R461-01b).
        vm.prank(feeRouter.owner());
        feeRouter.lockSettings();
        vm.prank(feeRouter.owner());
        vm.expectRevert(FeeRouter.SettingsLocked.selector);
        feeRouter.setClaimRouter(makeAddr("mallory"), true);
        assertEq(feeRouter.creatorAccrued(address(tok), creator), victimOwed);
    }
}

contract AuditPoC3Harvest is CreatorFeeRoutingTest {
    function test_A5_pveBurnRoute_notBlockedByDeadCap() public {
        vm.prank(creator);
        ILaunchpad.LaunchResult memory r = harvest.launchWithMode(_params(TAX, 0), 1, 2);
        BondingCurve c = BondingCurve(r.curve);
        Token tok = Token(r.token);
        _warpPastSnipe();
        quote.mint(creator, 1_000 ether);
        _buy(c, creator, 20 ether, 0);
        address g = makeAddr("griefer");
        quote.mint(g, 1_000 ether);
        _buy(c, g, 1_000 ether, 0);
        uint256 room = c.netCapNow() - c.balanceOnCurve(BURN);
        uint256 gb = tok.balanceOf(g);
        vm.prank(g);
        tok.transfer(BURN, room < gb ? room : gb);
        uint256 cb = tok.balanceOf(creator);
        vm.startPrank(creator);
        tok.approve(address(harvest), cb / 2);
        harvest.depositRocketTokens(address(tok), cb / 2);
        vm.stopPrank();
        _buy(c, trader1, 50 ether, 0);
        uint256 burnedBefore = tok.balanceOf(BURN);
        harvest.route(address(tok)); // fixed: a transfer to dEaD is a burn, never capped
        assertGt(tok.balanceOf(BURN), burnedBefore, "rocket tokens burned");
        assertEq(c.balanceOnCurve(BURN), 0, "dEaD holds no NET position");
    }
}

import {PermitForwarderTest, USDG, TipTarget} from "../security/PermitForwarder.t.sol";
import {DisciplePermitForwarder, IPermit2SignatureTransfer} from "../../src/addons/DisciplePermitForwarder.sol";

contract AuditPoC3Fwd is PermitForwarderTest {
    uint256 malKey = 0xBAD;

    function _signAs(
        uint256 key,
        IPermit2SignatureTransfer.PermitTransferFrom memory p,
        string memory witnessType,
        bytes32 witness
    ) internal view returns (bytes memory) {
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                witnessType
            )
        );
        bytes32 sh = keccak256(
            abi.encode(
                typeHash,
                keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, p.permitted.token, p.permitted.amount)),
                address(fwd),
                p.nonce,
                p.deadline,
                witness
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", _domain(), sh)));
        return abi.encodePacked(r, s, v);
    }

    function test_A6_forwarderIsASharedIdentity() public {
        DisciplePermitForwarder.Call[] memory c = _calls(3e18);
        DisciplePermitForwarder.Action memory a =
            DisciplePermitForwarder.Action({feeTo: relayer, callsHash: keccak256(abi.encode(c))});
        IPermit2SignatureTransfer.PermitTransferFrom memory p = _permit(1e18, 77);
        bytes memory sig = _sign(p, fwd.ACTION_WITNESS_TYPE(), fwd.hashAction(a), address(fwd));
        vm.prank(relayer);
        uint256 relayerBefore = usdg.balanceOf(relayer);
        fwd.action(p, a, c, alice, sig, _noApproval(), new address[](0));
        // Fixed: the fee token's gains go to the signed fee recipient even with an empty sweep list.
        assertEq(usdg.balanceOf(address(fwd)), 0, "nothing stranded");
        assertGt(usdg.balanceOf(relayer), relayerBefore + 2e18, "tip reached feeTo");

        address mal = vm.addr(malKey);
        USDG dummy = new USDG();
        DisciplePermitForwarder.Call[] memory mc = new DisciplePermitForwarder.Call[](2);
        mc[0] = DisciplePermitForwarder.Call({
            target: address(usdg), data: abi.encodeCall(IERC20.transfer, (mal, 3e18))
        });
        mc[1] = DisciplePermitForwarder.Call({
            target: address(usdg), data: abi.encodeCall(IERC20.approve, (mal, type(uint256).max))
        });
        DisciplePermitForwarder.Action memory ma =
            DisciplePermitForwarder.Action({feeTo: mal, callsHash: keccak256(abi.encode(mc))});
        IPermit2SignatureTransfer.PermitTransferFrom memory mp;
        mp.permitted = IPermit2SignatureTransfer.TokenPermissions({token: address(dummy), amount: 0});
        mp.nonce = 1;
        mp.deadline = block.timestamp + 1 hours;
        bytes memory msig = _signAs(malKey, mp, fwd.ACTION_WITNESS_TYPE(), fwd.hashAction(ma));
        vm.prank(mal);
        vm.expectRevert(abi.encodeWithSelector(DisciplePermitForwarder.ForbiddenTarget.selector, address(usdg)));
        fwd.action(mp, ma, mc, mal, msig, _noApproval(), new address[](0));
        assertEq(usdg.allowance(address(fwd), mal), 0, "no allowance from the forwarder");
    }
}
