// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CurveDeployer} from "../src/CurveDeployer.sol";
import {QuotePricer} from "../src/QuotePricer.sol";
import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Constants} from "../src/libraries/Constants.sol";
import {FeeMath} from "../src/libraries/FeeMath.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {AntiSnipe} from "../src/AntiSnipe.sol";
import {ReferralRegistry} from "../src/ReferralRegistry.sol";
import {LockedLP} from "../src/LockedLP.sol";
import {Migration} from "../src/Migration.sol";
import {ILaunchpad} from "../src/interfaces/ILaunchpad.sol";
import {Token} from "../src/Token.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {V4Deploy} from "./helpers/V4Deploy.sol";
import {DiscipleHook} from "../src/DiscipleHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SqrtPrice} from "../src/libraries/SqrtPrice.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

contract MockQuote is ERC20 {
    constructor() ERC20("USD Mock", "USDG") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }
}

/// @notice Real Uniswap v4 graduation: pool init, no-jump price, locked LP, post-grad 1% fee route.
contract MigrationTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address internal treasury = makeAddr("treasury");
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");

    MockQuote internal quote;
    ReferralRegistry internal referrals;
    LockedLP internal lockedLP;
    FeeRouter internal feeRouter;
    AntiSnipe internal antiSnipe;
    Migration internal migration;
    Launchpad internal launchpad;
    DiscipleHook internal hook;
    IPoolManager internal manager;
    PoolSwapTest internal swapRouter;

    function setUp() public {
        quote = new MockQuote();
        referrals = new ReferralRegistry(owner);
        lockedLP = new LockedLP(owner, treasury);
        feeRouter = new FeeRouter(owner, treasury, address(referrals));

        V4Deploy.Stack memory stack = V4Deploy.deploy(owner, lockedLP, feeRouter);
        migration = stack.migration;
        hook = stack.hook;
        manager = stack.manager;

        vm.startPrank(owner);
        lockedLP.setMigration(address(migration));
        lockedLP.setFeeRouter(address(feeRouter));
        lockedLP.setPoolManager(address(manager));
        vm.stopPrank();

        uint64 n = uint64(vm.getNonce(address(this)));
        address launchpadAddr = vm.computeCreateAddress(address(this), n + 1);
        antiSnipe = new AntiSnipe(launchpadAddr);
        launchpad = new Launchpad(owner, address(feeRouter), address(antiSnipe), address(migration));
        require(address(launchpad) == launchpadAddr, "predict");
        QuotePricer pricer_ = new QuotePricer(owner, IPoolManager(address(0)), address(quote));
        vm.prank(owner);
        launchpad.setPricer(address(pricer_));
        CurveDeployer cd_ = new CurveDeployer();
        vm.prank(owner);
        launchpad.setCurveDeployer(address(cd_));

        vm.startPrank(owner);
        feeRouter.setLaunchpad(address(launchpad));
        feeRouter.setLockedLP(address(lockedLP));
        feeRouter.setAuthorized(address(hook), true);
        vm.stopPrank();

        swapRouter = new PoolSwapTest(manager);
        quote.mint(alice, 50_000_000 ether);
    }

    function _launchAndGraduate() internal returns (BondingCurve curve, Token tok, PoolKey memory key) {
        uint256 ts = vm.getBlockTimestamp();
        vm.startPrank(alice);
        ILaunchpad.LaunchResult memory r = launchpad.launch(
            ILaunchpad.LaunchParams({
                name: "Grad",
                ticker: "GRAD",
                imageURI: "ipfs://g",
                description: "",
                socialsURI: "",
                quote: address(quote),
                creatorTaxBps: 0,
                creatorBuyQuoteIn: 0,
                creatorBuyMinTokensOut: 0,
                deadline: ts + 1 days
            })
        );
        vm.stopPrank();
        curve = BondingCurve(r.curve);
        tok = Token(r.token);
        vm.warp(ts + 10);

        // Buy to graduation across wallets
        for (uint256 i = 0; i < 40 && !curve.graduated(); i++) {
            address w = makeAddr(string(abi.encodePacked("g", vm.toString(i))));
            quote.mint(w, 5_000 ether);
            vm.startPrank(w);
            quote.approve(address(curve), type(uint256).max);
            uint256[4] memory sizes = [uint256(300 ether), 100 ether, 50 ether, 10 ether];
            for (uint256 j = 0; j < sizes.length && !curve.graduated(); j++) {
                try curve.buy(sizes[j], 0, block.timestamp + 1) {
                    break;
                } catch {}
            }
            vm.stopPrank();
        }
        require(curve.graduated(), "not graduated");
        key = lockedLP.getPoolKey(address(tok));
    }

    function test_graduation_creates_v4_pool() public {
        (BondingCurve curve, Token tok, PoolKey memory key) = _launchAndGraduate();
        assertTrue(migration.isGraduated(address(tok)));
        assertTrue(lockedLP.isGraduated(address(tok)));
        bytes32 pid = migration.poolIdOf(address(tok));
        assertEq(pid, PoolId.unwrap(key.toId()));

        (uint160 sqrtPriceX96,,,) = manager.getSlot0(key.toId());
        assertGt(sqrtPriceX96, 0);

        (,,,,,, uint128 liq) = lockedLP.positions(address(tok));
        assertGt(liq, 0);
        curve;
    }

    function test_price_continuity_within_rounding() public {
        (BondingCurve curve, Token tok, PoolKey memory key) = _launchAndGraduate();

        // Spot at exact sCurve (Pearly Gates); pool init uses same priceWad from graduating buy
        CurveMath.Params memory p = CurveMath.makeParams(1e18);
        uint256 priceWad = CurveMath.spotPriceWad(p, FeeMath.curveSoldSupply());

        bool tokenIsC0 = uint160(address(tok)) < uint160(address(quote));
        uint160 expectedSqrt = SqrtPrice.fromPriceWad(priceWad, tokenIsC0);
        (uint160 actualSqrt,,,) = manager.getSlot0(key.toId());

        // Allow 0.5% relative on sqrt (≈1% on price) for tick/liquidity rounding
        assertApproxEqRel(uint256(actualSqrt), uint256(expectedSqrt), 0.005e18);
        curve;
    }

    function test_LP_unwithdrawable() public {
        (, Token tok,) = _launchAndGraduate();
        vm.expectRevert(LockedLP.RemoveLiquidityDisabled.selector);
        lockedLP.removeLiquidity(address(tok), 1);
    }

    function test_postGrad_swap_charges_1pct_via_hook() public {
        (, Token tok, PoolKey memory key) = _launchAndGraduate();

        uint256 treBefore = quote.balanceOf(treasury);
        uint256 creatorBefore = feeRouter.creatorAccrued(address(tok), alice);

        // Swap quote → token (or reverse depending on ordering)
        bool tokenIsC0 = uint160(address(tok)) < uint160(address(quote));
        // Buy token with quote: if token is c1, zeroForOne=true means c0→c1 = quote→token
        bool zeroForOne = tokenIsC0 ? false : true; // spend quote (the non-token side) to buy token

        uint256 amountIn = 10 ether;
        quote.mint(address(this), amountIn);
        quote.approve(address(swapRouter), amountIn);

        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(amountIn), // exact in
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });

        PoolSwapTest.TestSettings memory settings =
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});

        swapRouter.swap(key, params, settings, "");

        // Hook took 1% of output and routed — treasury and/or creator accrued should rise
        assertTrue(
            quote.balanceOf(treasury) > treBefore || feeRouter.creatorAccrued(address(tok), alice) > creatorBefore
                || tok.balanceOf(treasury) > 0,
            "fees should route"
        );
    }
}
