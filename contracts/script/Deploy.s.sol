// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReferralRegistry} from "../src/ReferralRegistry.sol";
import {LockedLP} from "../src/LockedLP.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {AntiSnipe} from "../src/AntiSnipe.sol";
import {Migration} from "../src/Migration.sol";
import {LoginGate} from "../src/LoginGate.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {CurveDeployer} from "../src/CurveDeployer.sol";
import {TrampWallManager} from "../src/TrampWallManager.sol";
import {QuoteProbe} from "../src/QuoteProbe.sol";
import {QuotePricer} from "../src/QuotePricer.sol";
import {DiscipleRouter} from "../src/DiscipleRouter.sol";
import {DiscipleHook} from "../src/DiscipleHook.sol";
import {RewardsVault} from "../src/RewardsVault.sol";
import {UsdgDepositNotifier} from "../src/UsdgDepositNotifier.sol";
import {AnonLauncher} from "../src/addons/AnonLauncher.sol";
import {MarketLens} from "../src/addons/MarketLens.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

/// @dev Local-only mintable quote (anvil). Has EIP-2612 permit like real STRATEGY/USDG.
contract DevToken is ERC20, ERC20Permit {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d, address to, uint256 amt) ERC20(n, s) ERC20Permit(n) {
        _dec = d;
        _mint(to, amt);
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @title Deploy DISCIPLE to Robinhood Chain or local anvil.
/// @notice Env (all optional):
///   TREASURY            fee treasury (default: deployer)
///   POOL_MANAGER        existing v4 PoolManager (RH mainnet+testnet: 0x8366a39cc670b4001a1121b8f6a443a643e40951);
///                       unset → deploy a fresh PoolManager (local). Quotes: DiscipleRouter.quoteExactIn
///   V4_QUOTER           official V4Quoter (RH: 0x8dc178efb8111bb0973dd9d722ebeff267c98f94) — logged only
///   USDG                USDG address (RH mainnet: 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
///                       unset → deploy 18-dec DevToken "USDG" + mock STRATEGY w/ STRATEGY/USDG pool at $0.00245
///   DEFAULT_QUOTE       default launch quote (RH: STRATEGY 0x168661C52E5922288dFb2b3f323b6Cf90eb21e18)
///   DEFAULT_QUOTE_POOL_FEE / DEFAULT_QUOTE_POOL_TICK_SPACING / DEFAULT_QUOTE_POOL_HOOKS
///                       reference DEFAULT_QUOTE/USDG v4 pool for the QuotePricer
///                       (RH STRATEGY/USDG deepest pool: 36900 / 369 / 0x0 → id 0x816b…245b)
///   MIN_LIQUIDITY       QuotePricer minimum in-range liquidity (default 0)
///   (UNIVERSAL_ROUTER is intentionally NOT trusted: audit #10 / SEC-05 — anyone can pass arbitrary hookData
///    through it and spoof the credited trader. Only DiscipleRouter is a trusted router.)
///   REWARDS_VAULT_OWNER community RewardsVault owner/multisig (default deployer); 70% of anti-snipe tax
///   ANON_LAUNCH_FEE     AnonLauncher USDG launch fee (default 0.25e18, cap 5e18)
///   ERC5564_ANNOUNCER   ERC-5564 announcer (default 0x55649E01B5Df198D18D95b5cc5051630cfD45564)
///   DEPLOY_TEST_STRATEGY true → (with USDG set, DEFAULT_QUOTE unset) deploy a test STRATEGY and seed a
///                       STRATEGY/USDG pool at TEST_STRATEGY_PRICE_WAD (default 2.45e15 = $0.00245)
///                       with REF_POOL_LIQUIDITY (default 1e24) full-range liquidity from the deployer
contract Deploy is Script {
    /// @dev forge script routes `new X{salt: s}` through this deterministic CREATE2 factory.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    struct Out {
        address manager;
        address quoter;
        address hook;
        address router;
        address trampWall;
        address curveDeployer;
        address lockedLP;
        address feeRouter;
        address referrals;
        address antiSnipe;
        address migration;
        address launchpad;
        address probe;
        address pricer;
        address usdg;
        address defaultQuote;
        address depositNotifier;
    }

    function run() external returns (Out memory o) {
        address treasury = vm.envOr("TREASURY", address(0));
        o.manager = vm.envOr("POOL_MANAGER", address(0));
        o.quoter = vm.envOr("V4_QUOTER", address(0));
        o.usdg = vm.envOr("USDG", address(0));
        o.defaultQuote = vm.envOr("DEFAULT_QUOTE", address(0));

        vm.startBroadcast();
        // The broadcasting account (== msg.sender under `forge script`; also correct when run() is called from a test).
        (, address deployer,) = vm.readCallers();
        if (treasury == address(0)) treasury = deployer;

        if (o.manager == address(0)) {
            o.manager = address(new PoolManager(deployer));
        }
        IPoolManager manager = IPoolManager(o.manager);

        ReferralRegistry referrals = new ReferralRegistry(deployer);
        LockedLP lockedLP = new LockedLP(deployer, treasury);
        FeeRouter feeRouter = new FeeRouter(deployer, treasury, address(referrals));

        // Hook salt is mined against the CREATE2 factory that actually deploys it (not the EOA).
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        bytes memory ctorArgs = abi.encode(manager, feeRouter, address(0), deployer);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(DiscipleHook).creationCode, ctorArgs);
        DiscipleHook hook = new DiscipleHook{salt: salt}(manager, feeRouter, address(0), deployer);
        require(address(hook) == hookAddr, "Deploy: hook address mismatch");

        Migration migration = new Migration(deployer, address(lockedLP), o.manager, address(hook));
        hook.setMigration(address(migration));
        lockedLP.setMigration(address(migration));
        lockedLP.setFeeRouter(address(feeRouter));
        lockedLP.setPoolManager(o.manager);

        DiscipleRouter router = new DiscipleRouter(manager, lockedLP, address(hook));
        o.trampWall = address(new TrampWallManager(manager, lockedLP, address(hook)));
        // SEC-02: only LockedLP + TrampWallManager may add liquidity to DISCIPLE pools.
        hook.setLiquidityManager(address(lockedLP), true);
        hook.setLiquidityManager(o.trampWall, true);
        // LP auto-compound: hook calls LockedLP after fee routing; LockedLP trusts only this hook.
        hook.setCompounder(address(lockedLP), 250_000);
        lockedLP.setHook(address(hook));
        hook.setTrustedRouter(address(router), true);
        // Audit #10 (SEC-05): only our DiscipleRouter is trusted for hookData trader attribution.

        uint64 n = uint64(vm.getNonce(deployer));
        address launchpadAddr = vm.computeCreateAddress(deployer, n + 1);
        AntiSnipe antiSnipe = new AntiSnipe(launchpadAddr);
        Launchpad launchpad = new Launchpad(deployer, address(feeRouter), address(antiSnipe), address(migration));
        require(address(launchpad) == launchpadAddr, "Deploy: launchpad address mismatch");
        migration.setLaunchpad(address(launchpad)); // audit #1: migrate() only from launchpad.curveOf(token)

        feeRouter.setLaunchpad(address(launchpad));
        feeRouter.setLockedLP(address(lockedLP));
        feeRouter.setAuthorized(address(hook), true);

        // ── quote assets + oracle ──
        PoolKey memory refKey;
        bool hasRef;
        if (o.usdg == address(0)) {
            // local: mock USDG + mock STRATEGY with a seeded STRATEGY/USDG pool at $0.0018
            o.usdg = address(new DevToken("Global Dollar (dev)", "USDG", 18, deployer, 1e30));
            if (o.defaultQuote == address(0)) {
                o.defaultQuote = address(new DevToken("Strategy Coin (dev)", "STRATEGY", 18, deployer, 1e30));
                refKey = _seedRefPool(manager, o.defaultQuote, o.usdg, 245e13); // $0.00245
                hasRef = true;
            }
        }
        if (o.defaultQuote == address(0) && vm.envOr("DEPLOY_TEST_STRATEGY", false)) {
            o.defaultQuote = address(new DevToken("Strategy Coin (test)", "STRATEGY", 18, deployer, 1e27));
            refKey = _seedRefPool(manager, o.defaultQuote, o.usdg, vm.envOr("TEST_STRATEGY_PRICE_WAD", uint256(245e13)));
            hasRef = true;
        }
        if (o.defaultQuote == address(0)) o.defaultQuote = o.usdg;

        // Audit #5: the referral USDG gate needs a deposit notifier, else onUsdgDeposit always reverts.
        o.depositNotifier = address(new UsdgDepositNotifier(deployer, referrals, IERC20(o.usdg)));
        referrals.setDepositHook(o.depositNotifier);

        QuotePricer pricer = new QuotePricer(deployer, manager, o.usdg);
        // Default floor is set by the constructor (1e4 * 10^((18 + usdgDecimals) / 2)); MIN_LIQUIDITY overrides it.
        pricer.setMinLiquidity(uint128(vm.envOr("MIN_LIQUIDITY", uint256(pricer.minLiquidity()))));
        if (!hasRef && o.defaultQuote != o.usdg) {
            (address c0, address c1) =
                uint160(o.defaultQuote) < uint160(o.usdg) ? (o.defaultQuote, o.usdg) : (o.usdg, o.defaultQuote);
            refKey = PoolKey({
                currency0: Currency.wrap(c0),
                currency1: Currency.wrap(c1),
                fee: uint24(vm.envUint("DEFAULT_QUOTE_POOL_FEE")),
                tickSpacing: int24(int256(vm.envUint("DEFAULT_QUOTE_POOL_TICK_SPACING"))),
                hooks: IHooks(vm.envOr("DEFAULT_QUOTE_POOL_HOOKS", address(0)))
            });
            hasRef = true;
        }
        if (hasRef) pricer.setPricePool(o.defaultQuote, refKey);
        // USDG-in/out routing (buyWithUsdg / sellToUsdg): USDG + curve registry, and the USDG/defaultQuote hop pool.
        router.setUsdgRouting(o.usdg, address(launchpad));
        // Curve trades via the router act for the real trader (bonding modes: caps / cost basis / attribution).
        launchpad.setTrustedRouter(address(router), true);
        // PVE login gate: attester = backend key that signs Privy-login attestations (public address only).
        {
            address attester = vm.envOr("PVE_ATTESTER", address(0));
            LoginGate gate = new LoginGate(deployer, attester);
            launchpad.setLoginGate(address(gate));
        }
        if (hasRef) router.setUsdgPool(o.defaultQuote, refKey);
        // Sanity: oracle must price the default quote now, else launches would revert.
        require(pricer.quotePriceUsd(o.defaultQuote) > 0, "Deploy: default quote unpriced");

        QuoteProbe probe = new QuoteProbe(deployer);
        probe.setAlwaysPass(o.defaultQuote, true);
        probe.setAlwaysPass(o.usdg, true);

        launchpad.setPricer(address(pricer));
        o.curveDeployer = address(new CurveDeployer());
        launchpad.setCurveDeployer(o.curveDeployer);
        launchpad.setQuoteProbe(address(probe));
        launchpad.setDefaultQuote(o.defaultQuote);

        // ── Combined redeploy additions (flow/anon-launch + flow/snipe-split) ──
        // LOCKED #9 rev.: anti-snipe tax 70% community RewardsVault / 30% treasury.
        _addons(deployer, treasury, feeRouter, hook, launchpad, migration, pricer, o.usdg);

        vm.stopBroadcast();

        o.hook = address(hook);
        o.router = address(router);
        o.lockedLP = address(lockedLP);
        o.feeRouter = address(feeRouter);
        o.referrals = address(referrals);
        o.antiSnipe = address(antiSnipe);
        o.migration = address(migration);
        o.launchpad = address(launchpad);
        o.probe = address(probe);
        o.pricer = address(pricer);

        console2.log("PoolManager", o.manager);
        console2.log("V4Quoter", o.quoter);
        console2.log("DiscipleHook", o.hook);
        console2.log("DiscipleRouter", o.router);
        console2.log("TrampWallManager", o.trampWall);
        console2.log("CurveDeployer", o.curveDeployer);
        console2.log("ReferralRegistry", o.referrals);
        console2.log("LockedLP", o.lockedLP);
        console2.log("FeeRouter", o.feeRouter);
        console2.log("AntiSnipe", o.antiSnipe);
        console2.log("Migration", o.migration);
        console2.log("Launchpad", o.launchpad);
        console2.log("QuoteProbe", o.probe);
        console2.log("QuotePricer", o.pricer);
        console2.log("UsdgDepositNotifier", o.depositNotifier);
        console2.log("USDG", o.usdg);
        console2.log("DefaultQuote", o.defaultQuote);
        console2.log("DefaultQuoteUsdWad", pricer.quotePriceUsd(o.defaultQuote));
    }

    function _addons(
        address deployer,
        address treasury,
        FeeRouter feeRouter,
        DiscipleHook hook,
        Launchpad launchpad,
        Migration migration,
        QuotePricer pricer,
        address usdg
    ) internal {
        RewardsVault vault = new RewardsVault(deployer);
        vault.setFeeRouter(address(feeRouter));
        feeRouter.setRewardsVault(address(vault));
        address vOwner = vm.envOr("REWARDS_VAULT_OWNER", deployer);
        if (vOwner != deployer) vault.transferOwnership(vOwner);
        // mcapNow / Trade-event mcap fix: live QuotePricer on the hook (curves read Launchpad.pricer()).
        hook.setPricer(address(pricer));
        AnonLauncher anon = new AnonLauncher(
            deployer,
            address(launchpad),
            address(feeRouter),
            usdg,
            treasury,
            vm.envOr("ERC5564_ANNOUNCER", address(0x55649E01B5Df198D18D95b5cc5051630cfD45564)),
            vm.envOr("ANON_LAUNCH_FEE", uint256(0.25 ether))
        );
        MarketLens lens = new MarketLens(address(launchpad), address(migration));
        console2.log("RewardsVault", address(vault));
        console2.log("AnonLauncher", address(anon));
        console2.log("MarketLens", address(lens));
    }

    /// @dev price = usdg raw per quote raw, WAD.
    function _seedRefPool(IPoolManager manager, address q, address usdg, uint256 priceWad)
        internal
        returns (PoolKey memory key)
    {
        bool qIsC0 = uint160(q) < uint160(usdg);
        key = PoolKey({
            currency0: Currency.wrap(qIsC0 ? q : usdg),
            currency1: Currency.wrap(qIsC0 ? usdg : q),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        uint256 ratioX192 = qIsC0 ? Math.mulDiv(priceWad, 1 << 192, 1e18) : Math.mulDiv(1e18, 1 << 192, priceWad);
        manager.initialize(key, uint160(Math.sqrt(ratioX192)));
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        IERC20(q).approve(address(lp), type(uint256).max);
        IERC20(usdg).approve(address(lp), type(uint256).max);
        lp.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: int256(vm.envOr("REF_POOL_LIQUIDITY", uint256(1e24))),
                salt: 0
            }),
            ""
        );
    }
}
