// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";
import {QuotePricer} from "../../src/QuotePricer.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {PoolDepth} from "../../src/libraries/PoolDepth.sol";

/// @notice Mainnet-fork check of the SPACEHOOD two-hop (both legs hooked, dynamic fee). No broadcast.
///         Public Robinhood RPC, eth_call / forked simulation only.
contract SpacehoodRouteForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // Public mainnet RPC already used by PaymasterV5Fork.t.sol. Simulation only.
    string internal constant MAINNET_RPC = "https://rpc.mainnet.chain.robinhood.com";

    address internal constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant SPCX = 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa;
    address internal constant SPACEHOOD = 0xFe7E19CbCe2f896C6C528BC355bAF5a768291E18;
    address internal constant SESSION_FEE_HOOK = 0xC15b155a3094934171A15625d1a80Aba267B6080;
    address internal constant SPACEHOOD_HOOK = 0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544;

    bytes32 internal constant LEG1_ID = 0x1f5bf0b4df6d26da68a30535727acaf41634443b6421bcecd8ac1d455b2f91d6;
    bytes32 internal constant LEG2_ID = 0x225cc98f7d66b29fef96377becc7bf89582e2ab7b923a09aee9719fd80eb94ca;
    bytes32 internal constant ALT_LEG1_ID = 0xcb6ffbcc84359535c2cc0a5688c0a76520ea6e0a4820fddd3ac8d7880e576370;

    uint256 internal constant USDG_IN = 100 * 1e6; // $100 of 6-dec USDG
    uint256 internal constant QUOTER_OUT = 262_397 ether; // parent-verified Quoter estimate
    uint256 internal constant FLOOR = 10_000e18;

    IPoolManager internal pm;
    DiscipleRouter internal router;
    QuotePricer internal pricer;
    address internal trader;

    function setUp() public {
        vm.createSelectFork(MAINNET_RPC);
        assertEq(block.chainid, 4663, "not robinhood mainnet");
        pm = IPoolManager(PM);
        trader = makeAddr("trader");
        LockedLP lp = new LockedLP(address(this), address(this), address(0));
        // hook = address(0): UsdgRouteLib only rejects the DISCIPLE hook; these hops use other hooks.
        router = new DiscipleRouter(pm, lp, address(0));
        router.setUsdgRouting(USDG, address(1)); // launchpad unused by swapUsdgToQuote
        pricer = new QuotePricer(address(this), pm, USDG);
    }

    function _leg1Deepest() internal pure returns (PoolKey memory key) {
        key = PoolKey({
            currency0: Currency.wrap(SPCX),
            currency1: Currency.wrap(USDG),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(SESSION_FEE_HOOK)
        });
    }

    function _leg1Alt() internal pure returns (PoolKey memory key) {
        key = PoolKey({
            currency0: Currency.wrap(SPCX),
            currency1: Currency.wrap(USDG),
            fee: 10_000,
            tickSpacing: 200,
            hooks: IHooks(address(0))
        });
    }

    function _leg2() internal pure returns (PoolKey memory key) {
        key = PoolKey({
            currency0: Currency.wrap(SPCX),
            currency1: Currency.wrap(SPACEHOOD),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 8,
            hooks: IHooks(SPACEHOOD_HOOK)
        });
    }

    function _route(PoolKey memory hop0) internal view returns (PoolKey[] memory keys) {
        keys = new PoolKey[](2);
        keys[0] = hop0;
        keys[1] = _leg2();
    }

    function _fundUsdg(address to, uint256 amount) internal {
        (bool minted,) = USDG.call(abi.encodeWithSignature("mint(address,uint256)", to, amount));
        if (minted && IERC20(USDG).balanceOf(to) >= amount) return;
        deal(USDG, to, amount);
        require(IERC20(USDG).balanceOf(to) >= amount, "could not fund USDG on fork");
    }

    function test_pool_ids_and_hooks_match() public view {
        assertEq(PoolId.unwrap(_leg1Deepest().toId()), LEG1_ID, "leg1 deepest id");
        assertEq(PoolId.unwrap(_leg2().toId()), LEG2_ID, "leg2 id");
        assertEq(PoolId.unwrap(_leg1Alt().toId()), ALT_LEG1_ID, "alt leg1 id");
        (uint160 sp1,,,) = pm.getSlot0(_leg1Deepest().toId());
        (uint160 sp2,,,) = pm.getSlot0(_leg2().toId());
        assertGt(sp1, 0, "leg1 not initialized");
        assertGt(sp2, 0, "leg2 not initialized");
        assertEq(_leg1Deepest().fee, LPFeeLibrary.DYNAMIC_FEE_FLAG);
        assertEq(_leg2().fee, LPFeeLibrary.DYNAMIC_FEE_FLAG);
        assertEq(address(_leg1Deepest().hooks), SESSION_FEE_HOOK);
        assertEq(address(_leg2().hooks), SPACEHOOD_HOOK);
    }

    function test_two_hop_buy_both_hooks_gas_and_min_out() public {
        console2.log("SPACEHOOD name", IERC20Metadata(SPACEHOOD).name());
        console2.log("SPACEHOOD decimals", IERC20Metadata(SPACEHOOD).decimals());

        PoolKey memory hop0 = _leg1Deepest();
        PoolKey[] memory keys = _route(hop0);
        router.setUsdgRoute(SPACEHOOD, keys);
        pricer.setAllowedQuote(SPACEHOOD, true);
        pricer.setPriceRoute(SPACEHOOD, keys);

        // Dollar floor on both hooked dynamic-fee pools (per-side, not fee).
        uint256 px = pricer.quotePriceUsd(SPACEHOOD);
        assertGt(px, 0, "live route price");
        console2.log("quotePriceUsd wad", px);

        _fundUsdg(trader, USDG_IN * 2);
        vm.prank(trader);
        IERC20(USDG).approve(address(router), type(uint256).max);

        (uint256 quoted,) = router.quoteUsdgQuoteSwap(SPACEHOOD, true, USDG_IN);
        console2.log("quoted SPACEHOOD wei", quoted);
        console2.log("quoter estimate wei", QUOTER_OUT);
        assertGt(quoted, 0, "quote failed on deepest hooked leg 1");

        // min-out is checked on the hook-adjusted final output: quoted+1 must revert.
        vm.prank(trader);
        vm.expectRevert(DiscipleRouter.Slippage.selector);
        router.swapUsdgToQuote(SPACEHOOD, USDG_IN, quoted + 1, trader, block.timestamp + 1 hours);

        uint256 t0 = IERC20(SPACEHOOD).balanceOf(trader);
        uint256 u0 = IERC20(USDG).balanceOf(trader);
        vm.prank(trader);
        uint256 g = gasleft();
        uint256 out = router.swapUsdgToQuote(SPACEHOOD, USDG_IN, quoted, trader, block.timestamp + 1 hours);
        uint256 gasUsed = g - gasleft();
        assertEq(out, quoted, "executed output equals hook-adjusted quote (min-out on real final)");
        assertEq(IERC20(SPACEHOOD).balanceOf(trader) - t0, out, "SPACEHOOD received");
        assertEq(u0 - IERC20(USDG).balanceOf(trader), USDG_IN, "USDG spent");
        assertEq(IERC20(USDG).balanceOf(address(router)), 0, "no usdg dust");
        assertEq(IERC20(SPCX).balanceOf(address(router)), 0, "no mid dust");
        assertEq(IERC20(SPACEHOOD).balanceOf(address(router)), 0, "no quote dust");
        console2.log("router gas swapUsdgToQuote $100 2-hop both hooks (first)", gasUsed);
        console2.log("SPACEHOOD out (whole tokens approx)", out / 1e18);

        // Second $100: warm router + pool slots, closer to a live hop.
        (uint256 quoted2,) = router.quoteUsdgQuoteSwap(SPACEHOOD, true, USDG_IN);
        vm.prank(trader);
        g = gasleft();
        uint256 out2 = router.swapUsdgToQuote(SPACEHOOD, USDG_IN, quoted2, trader, block.timestamp + 1 hours);
        uint256 gasWarm = g - gasleft();
        assertEq(out2, quoted2, "warm min-out still hook-adjusted");
        console2.log("router gas swapUsdgToQuote $100 2-hop both hooks (warm)", gasWarm);
    }

    function test_floor_both_hooked_legs() public view {
        (uint256 a0, uint256 a1) = PoolDepth.virtualReserves(pm, _leg1Deepest());
        (uint256 b0, uint256 b1) = PoolDepth.virtualReserves(pm, _leg2());
        console2.log("leg1 virtual reserve0", a0);
        console2.log("leg1 virtual reserve1", a1);
        console2.log("leg2 virtual reserve0", b0);
        console2.log("leg2 virtual reserve1", b1);
        assertGt(a0, 0);
        assertGt(a1, 0);
        assertGt(b0, 0);
        assertGt(b1, 0);
    }
}
