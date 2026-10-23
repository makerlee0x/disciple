// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CurveDeployer} from "../../src/CurveDeployer.sol";
import {QuotePricer} from "../../src/QuotePricer.sol";
import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Constants} from "../../src/libraries/Constants.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {CurveMath} from "../../src/libraries/CurveMath.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {AntiSnipe} from "../../src/AntiSnipe.sol";
import {ReferralRegistry} from "../../src/ReferralRegistry.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {Migration} from "../../src/Migration.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {V4Deploy} from "../helpers/V4Deploy.sol";
import {DiscipleHook} from "../../src/DiscipleHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPrice} from "../../src/libraries/SqrtPrice.sol";
import {QuoteProbe} from "../../src/QuoteProbe.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {RewardsVault} from "../../src/RewardsVault.sol";

contract MockUSDG is ERC20, ERC20Permit {
    constructor() ERC20("USD Mock", "USDG") ERC20Permit("USD Mock") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }
}

/// @dev Minimal deposit notifier for ReferralRegistry USDG gate.
contract DepositHookMock {
    ReferralRegistry public immutable registry;

    constructor(ReferralRegistry r) {
        registry = r;
    }

    function notifyDeposit(address wallet, uint256 amount) external {
        registry.onUsdgDeposit(wallet, amount);
    }
}

/// @notice Shared actors + v4 stack for end-to-end integration tests.
abstract contract IntegrationBase is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal sniper = makeAddr("sniper");
    address internal trader1 = makeAddr("trader1");
    address internal trader2 = makeAddr("trader2");
    address internal kol = makeAddr("kol");
    address internal referred = makeAddr("referred");

    MockUSDG internal quote;
    RewardsVault internal rewardsVault;
    ReferralRegistry internal referrals;
    DepositHookMock internal depositHook;
    LockedLP internal lockedLP;
    FeeRouter internal feeRouter;
    AntiSnipe internal antiSnipe;
    Migration internal migration;
    Launchpad internal launchpad;
    DiscipleHook internal hook;
    IPoolManager internal manager;
    PoolSwapTest internal swapRouter;
    QuoteProbe internal quoteProbe;
    MockUSDG internal strategy; // mock STRATEGY default quote
    QuotePricer internal pricer;
    DiscipleRouter internal router;
    PoolKey internal strategyUsdgKey; // reference STRATEGY/USDG pool priced 1:1 ($1)
    uint256 internal refPoolQuoteSeed; // USDG seeded into the reference pool (excluded from accounting)

    // Accounting trackers (quote wei paid by users into the system)
    uint256 internal totalQuoteIn;

    function setUp() public virtual {
        quote = new MockUSDG();
        referrals = new ReferralRegistry(owner, address(quote));
        lockedLP = new LockedLP(owner, treasury);
        feeRouter = new FeeRouter(owner, treasury, address(referrals));

        V4Deploy.Stack memory stack = V4Deploy.deploy(owner, lockedLP, feeRouter);
        migration = stack.migration;
        hook = stack.hook;
        manager = stack.manager;
        router = stack.router;

        vm.startPrank(owner);
        lockedLP.setMigration(address(migration));
        lockedLP.setFeeRouter(address(feeRouter));
        lockedLP.setPoolManager(address(manager));
        lockedLP.setHook(address(hook));
        depositHook = new DepositHookMock(referrals);
        referrals.setDepositHook(address(depositHook));
        vm.stopPrank();

        uint64 n = uint64(vm.getNonce(address(this)));
        address launchpadAddr = vm.computeCreateAddress(address(this), n + 1);
        antiSnipe = new AntiSnipe(launchpadAddr);
        launchpad = new Launchpad(owner, address(feeRouter), address(antiSnipe), address(migration));
        require(address(launchpad) == launchpadAddr, "predict");

        strategy = new MockUSDG(); // treat as STRATEGY
        // Rename via nothing — MockUSDG is fine as STRATEGY stand-in

        vm.startPrank(owner);
        feeRouter.setLaunchpad(address(launchpad));
        migration.setLaunchpad(address(launchpad));
        feeRouter.setLockedLP(address(lockedLP));
        feeRouter.setAuthorized(address(hook), true);
        rewardsVault = new RewardsVault(owner);
        rewardsVault.setFeeRouter(address(feeRouter));
        feeRouter.setRewardsVault(address(rewardsVault));
        launchpad.setDefaultQuote(address(strategy));
        vm.stopPrank();

        // Launch-time oracle: USDG ($1) + STRATEGY priced from a STRATEGY/USDG v4 pool at 1:1
        pricer = new QuotePricer(owner, manager, address(quote));
        strategyUsdgKey = _initRefPool(address(strategy), address(quote), uint160(1) << 96);
        refPoolQuoteSeed = quote.balanceOf(address(manager));
        vm.startPrank(owner);
        pricer.setPricePool(address(strategy), strategyUsdgKey);
        // Real round-trip probe ($1 of USDG); the default (strategy) is probed too, no allowlist.
        quoteProbe = new QuoteProbe(owner, manager, address(quote), address(pricer), 1e18);
        launchpad.setQuoteProbe(address(quoteProbe));
        launchpad.setPricer(address(pricer));
        launchpad.setCurveDeployer(address(new CurveDeployer()));
        launchpad.setTrustedRouter(address(router), true);
        vm.stopPrank();

        strategy.mint(creator, 50_000_000 ether);
        strategy.mint(trader1, 50_000_000 ether);
        strategy.mint(trader2, 50_000_000 ether);
        strategy.mint(sniper, 50_000_000 ether);

        swapRouter = new PoolSwapTest(manager);

        // Fund actors
        address[7] memory actors = [creator, sniper, trader1, trader2, kol, referred, address(this)];
        for (uint256 i = 0; i < actors.length; i++) {
            quote.mint(actors[i], 50_000_000 ether);
        }
    }

    function _bindReferral(address wallet, address referrer, uint256 usdgDeposit) internal {
        vm.prank(wallet); // audit #3: only the wallet (or an attestor) may attribute itself
        referrals.tryAttribute(wallet, referrer);
        if (usdgDeposit > 0) {
            depositHook.notifyDeposit(wallet, usdgDeposit);
        }
    }

    function _launch(uint256 taxBps, uint256 creatorBuyQuote) internal returns (BondingCurve curve, Token tok) {
        return _launchWithQuote(address(quote), taxBps, creatorBuyQuote);
    }

    function _launchWithQuote(address quoteToken, uint256 taxBps, uint256 creatorBuyQuote)
        internal
        returns (BondingCurve curve, Token tok)
    {
        uint256 ts = vm.getBlockTimestamp();
        address pay = quoteToken == address(0) ? address(strategy) : quoteToken;
        vm.startPrank(creator);
        if (creatorBuyQuote > 0) {
            IERC20(pay).approve(address(launchpad), creatorBuyQuote);
            totalQuoteIn += creatorBuyQuote;
        }
        ILaunchpad.LaunchResult memory r = launchpad.launchCoin(
            ILaunchpad.LaunchParams({
                name: "DiscipleCoin",
                ticker: "DSPL",
                imageURI: "ipfs://img",
                description: "e2e",
                socialsURI: "",
                quote: quoteToken,
                creatorTaxBps: taxBps,
                creatorBuyQuoteIn: creatorBuyQuote,
                creatorBuyMinTokensOut: 0,
                deadline: ts + 1 days
            })
        );
        vm.stopPrank();
        curve = BondingCurve(r.curve);
        tok = Token(r.token);
    }

    function _buy(BondingCurve curve, address buyer, uint256 quoteIn, uint256 minOut) internal returns (uint256) {
        uint256 b0 = quote.balanceOf(buyer);
        vm.startPrank(buyer);
        quote.approve(address(curve), quoteIn);
        uint256 out = curve.buy(quoteIn, minOut, block.timestamp + 1 hours);
        vm.stopPrank();
        totalQuoteIn += b0 - quote.balanceOf(buyer); // mode rules v2: a capped buy refunds the unused input
        return out;
    }

    function _sell(BondingCurve curve, Token tok, address seller, uint256 tokensIn, uint256 minOut)
        internal
        returns (uint256)
    {
        vm.startPrank(seller);
        tok.approve(address(curve), tokensIn);
        uint256 out = curve.sell(tokensIn, minOut, block.timestamp + 1 hours);
        vm.stopPrank();
        return out;
    }

    /// @dev DiscipleHook compound reference needs REF_MIN_AGE (60 s) of history after graduation.
    function _warpRefReady() internal {
        vm.warp(vm.getBlockTimestamp() + 61);
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// @dev Make the hook's compound reference ready (audit round 3: >= 3 observations, last >= 60 s after the
    ///      seed): two dust buys in distinct blocks by a throwaway wallet, then a fresh block.
    function _refReady(Token tok) internal {
        address w = makeAddr("refObserver");
        vm.warp(vm.getBlockTimestamp() + 31);
        vm.roll(vm.getBlockNumber() + 1);
        _swapExactInQuoteForToken(tok, w, 1e12);
        vm.warp(vm.getBlockTimestamp() + 31);
        vm.roll(vm.getBlockNumber() + 1);
        _swapExactInQuoteForToken(tok, w, 1e12);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// @dev mode rules v2: the sniper tax decays 99% → 0 over ANTI_SNIPE_DURATION (60 s).
    function _warpPastSnipe() internal {
        vm.warp(block.timestamp + Constants.ANTI_SNIPE_DURATION + 1);
    }

    /// @dev Drive curve to graduation with many wallets under 7% cap.
    function _graduate(BondingCurve curve) internal {
        _graduateWith(curve, quote);
    }

    function _graduateWith(BondingCurve curve, MockUSDG q) internal {
        _warpPastSnipe();
        for (uint256 i = 0; i < 80 && !curve.graduated(); i++) {
            address w = makeAddr(string(abi.encodePacked("gradW", vm.toString(i), address(q))));
            q.mint(w, 50_000 ether);
            uint256[6] memory sizes = [uint256(400 ether), 200 ether, 100 ether, 50 ether, 10 ether, 1 ether];
            for (uint256 j = 0; j < sizes.length && !curve.graduated(); j++) {
                vm.startPrank(w);
                q.approve(address(curve), sizes[j]);
                uint256 qb = q.balanceOf(w);
                try curve.buy(sizes[j], 0, block.timestamp + 1) {
                    totalQuoteIn += qb - q.balanceOf(w);
                    vm.stopPrank();
                    break;
                } catch {
                    vm.stopPrank();
                }
            }
        }
        require(curve.graduated(), "IntegrationBase: not graduated");
    }

    function _initRefPool(address a, address b, uint160 sqrtP) internal returns (PoolKey memory key) {
        (address c0, address c1) = uint160(a) < uint160(b) ? (a, b) : (b, a);
        key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        manager.initialize(key, sqrtP);
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        MockUSDG(a).mint(address(this), 1e30);
        MockUSDG(b).mint(address(this), 1e30);
        IERC20(a).approve(address(lp), type(uint256).max);
        IERC20(b).approve(address(lp), type(uint256).max);
        lp.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: -887220, tickUpper: 887220, liquidityDelta: 100_000 ether, salt: 0
            }),
            ""
        );
    }

    function _poolKey(Token tok) internal view returns (PoolKey memory) {
        return lockedLP.getPoolKey(address(tok));
    }

    function _swapExactInQuoteForToken(Token tok, address trader, uint256 amountIn) internal {
        PoolKey memory key = _poolKey(tok);
        bool tokenIsC0 = uint160(address(tok)) < uint160(address(quote));
        bool zeroForOne = !tokenIsC0; // spend quote → buy token
        quote.mint(trader, amountIn);
        vm.startPrank(trader);
        quote.approve(address(swapRouter), amountIn);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        totalQuoteIn += amountIn;
    }

    function _swapExactInTokenForQuote(Token tok, address trader, uint256 tokenAmount) internal {
        PoolKey memory key = _poolKey(tok);
        bool tokenIsC0 = uint160(address(tok)) < uint160(address(quote));
        bool zeroForOne = tokenIsC0; // spend token → buy quote
        vm.startPrank(trader);
        tok.approve(address(swapRouter), tokenAmount);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(tokenAmount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    /// @dev Quote held in protocol buckets (curve reserve / LP escrow / accrued / treasury).
    function _quoteDistributed(address token, address creator_) internal view returns (uint256) {
        uint256 sum = (quote.balanceOf(treasury) + feeRouter.treasuryAccrued(address(quote)));
        sum += feeRouter.creatorAccrued(token, creator_);
        sum += feeRouter.referrerAccrued(kol, address(quote));
        sum += feeRouter.referrerAccrued(referred, address(quote));
        // LockedLP may hold quote (escrow + leftovers)
        sum += quote.balanceOf(address(lockedLP));
        // Curve may still hold quote if not graduated
        address curve = launchpad.curveOf(token);
        if (curve != address(0)) sum += quote.balanceOf(curve);
        // FeeRouter may hold unclaimed briefly (should be 0 after routes)
        sum += quote.balanceOf(address(feeRouter));
        // PoolManager holds seeded quote liquidity
        sum += quote.balanceOf(address(manager)) - refPoolQuoteSeed;
        return sum;
    }
}
