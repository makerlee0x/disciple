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
import {Constants} from "../src/libraries/Constants.sol";
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
///   USDG                USDG address (RH mainnet: 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168, 6 decimals);
///                       unset → deploy a mintable DevToken "USDG" with USDG_DECIMALS (default 6, like mainnet)
///                       (+ a mock STRATEGY w/ STRATEGY/USDG pool at $0.00245 when DEFAULT_QUOTE is unset too)
///   USDG_DECIMALS       decimals of the mock USDG deployed when USDG is unset (default 6)
///   EXPECT_USDG_DECIMALS  revert unless USDG.decimals() equals this (default 6; set 18 only for a legacy mUSDG)
///   REFERRAL_SINK       FeeRouter.referralSink (default address(0) = today's routing: referrer / launch KOL get the
///                       1%). Non-zero redirects the WHOLE referral 1% incl. the launch-KOL 1% (lee, 2026-10-24).
///                       Owner can change it any time later with FeeRouter.setReferralSink(addr).
///   DEFAULT_QUOTE       default launch quote (RH: STRATEGY 0x168661C52E5922288dFb2b3f323b6Cf90eb21e18)
///   DEFAULT_QUOTE_POOL_FEE / DEFAULT_QUOTE_POOL_TICK_SPACING / DEFAULT_QUOTE_POOL_HOOKS
///                       reference DEFAULT_QUOTE/USDG v4 pool for the QuotePricer
///                       (RH STRATEGY/USDG deepest pool: 36900 / 369 / 0x0 → id 0x816b…245b)
///   MIN_LIQUIDITY       QuotePricer minimum in-range liquidity (default 0)
///   (UNIVERSAL_ROUTER is intentionally NOT trusted: audit #10 / SEC-05 — anyone can pass arbitrary hookData
///    through it and spoof the credited trader. Only DiscipleRouter is a trusted router.)
///   REWARDS_VAULT_OWNER community RewardsVault owner/multisig (default deployer); receives sniper escrows of coins
///                       not graduated within snipeEscrowTimeout (releaseSnipeEscrow)
///   ANON_LAUNCH_FEE     AnonLauncher USDG launch fee in USDG raw units (default 0.25 USDG at USDG's decimals;
///                       contract cap MAX_LAUNCH_FEE = 5e18 raw)
///   ERC5564_ANNOUNCER   ERC-5564 announcer (default 0x55649E01B5Df198D18D95b5cc5051630cfD45564)
///   DEPLOY_TEST_STRATEGY true → (DEFAULT_QUOTE unset) deploy a test STRATEGY and seed a STRATEGY/USDG pool at
///                       TEST_STRATEGY_PRICE_WAD (USDG raw per STRATEGY raw, WAD; default $0.00245 scaled to USDG's
///                       decimals: 2.45e15 for 18-dec, 2450 for 6-dec) with REF_POOL_LIQUIDITY full-range liquidity
///                       (default ≈ REF_POOL_USD per side, REF_POOL_USD default 1,000,000)
///   Chain guard: only chainid 46630 (RH testnet or an anvil fork of it) or 31337 (plain anvil / forge test).
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
        address migration;
        address launchpad;
        address probe;
        address pricer;
        address usdg;
        address defaultQuote;
        address depositNotifier;
        address rewardsVault;
        address anonLauncher;
        address marketLens;
        address loginGate;
    }

    function run() external returns (Out memory o) {
        address treasury = vm.envOr("TREASURY", address(0));
        o.manager = vm.envOr("POOL_MANAGER", address(0));
        o.quoter = vm.envOr("V4_QUOTER", address(0));
        o.usdg = vm.envOr("USDG", address(0));
        o.defaultQuote = vm.envOr("DEFAULT_QUOTE", address(0));
        require(block.chainid == 46630 || block.chainid == 31337, "Deploy: testnet/local only");

        vm.startBroadcast();
        // The broadcasting account (== msg.sender under `forge script`; also correct when run() is called from a test).
        (, address deployer,) = vm.readCallers();
        if (treasury == address(0)) treasury = deployer;

        if (o.manager == address(0)) {
            o.manager = address(new PoolManager(deployer));
        }
        IPoolManager manager = IPoolManager(o.manager);

        // USDG first: the referral gate is scaled by its decimals at construction.
        bool devUsdg = o.usdg == address(0);
        if (devUsdg) {
            uint8 dec = uint8(vm.envOr("USDG_DECIMALS", uint256(6)));
            o.usdg = address(new DevToken("Global Dollar (test)", "USDG", dec, deployer, 1e12 * 10 ** uint256(dec)));
        }
        uint8 usdgDec = ERC20(o.usdg).decimals();
        require(usdgDec == vm.envOr("EXPECT_USDG_DECIMALS", uint256(6)), "Deploy: unexpected USDG decimals");
        ReferralRegistry referrals = new ReferralRegistry(deployer, o.usdg);
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

        // Redeploy pack item 8: the legacy AntiSnipe is no longer deployed. Launchpad.antiSnipe is a never-read
        // immutable (v2 curves compute the sniper tax inline via FeeMath.snipeBps), so it is address(0).
        Launchpad launchpad = new Launchpad(deployer, address(feeRouter), address(0), address(migration));
        migration.setLaunchpad(address(launchpad)); // audit #1: migrate() only from launchpad.curveOf(token)

        feeRouter.setLaunchpad(address(launchpad));
        feeRouter.setLockedLP(address(lockedLP));
        feeRouter.setAuthorized(address(hook), true);

        // ── quote assets + oracle ──
        PoolKey memory refKey;
        bool hasRef;
        if (devUsdg) {
            // local: mock USDG (created above) + mock STRATEGY with a seeded STRATEGY/USDG pool at $0.0018
            if (o.defaultQuote == address(0)) {
                o.defaultQuote = address(new DevToken("Strategy Coin (dev)", "STRATEGY", 18, deployer, 1e30));
                refKey = _seedRefPool(manager, o.defaultQuote, o.usdg, _strategyPriceWad(usdgDec), usdgDec); // $0.00245
                hasRef = true;
            }
        }
        if (o.defaultQuote == address(0) && vm.envOr("DEPLOY_TEST_STRATEGY", false)) {
            o.defaultQuote = address(new DevToken("Strategy Coin (test)", "STRATEGY", 18, deployer, 1e27));
            refKey = _seedRefPool(
                manager, o.defaultQuote, o.usdg, vm.envOr("TEST_STRATEGY_PRICE_WAD", _strategyPriceWad(usdgDec)), usdgDec
            );
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
        feeRouter.setClaimRouter(address(router), true); // claimCreatorFeesToUsdg (separate allowlist, audit r121 Low)
        // PVE login gate: attester = backend key that signs Privy-login attestations (public address only).
        {
            address attester = vm.envOr("PVE_ATTESTER", address(0));
            LoginGate gate = new LoginGate(deployer, attester);
            launchpad.setLoginGate(address(gate));
            o.loginGate = address(gate);
        }
        if (hasRef) router.setUsdgPool(o.defaultQuote, refKey);
        // Sanity: oracle must price the default quote now, else launches would revert.
        require(pricer.quotePriceUsd(o.defaultQuote) > 0, "Deploy: default quote unpriced");

        // Real round-trip probe through the pricer's base/USDG pool; probes the default base too (no allowlist).
        QuoteProbe probe = new QuoteProbe(
            deployer, manager, o.usdg, address(pricer), uint256(vm.envOr("PROBE_USDG", 10 ** uint256(pricer.usdgDecimals())))
        );

        launchpad.setPricer(address(pricer));
        o.curveDeployer = address(new CurveDeployer());
        launchpad.setCurveDeployer(o.curveDeployer);
        launchpad.setQuoteProbe(address(probe));
        launchpad.setDefaultQuote(o.defaultQuote);

        // ── Combined redeploy additions (flow/anon-launch + flow/snipe-split) ──
        // Mode rules v2: sniper tax → curve snipeEscrow → LockedLP compound bucket at graduation (RewardsVault after timeout).
        (o.rewardsVault, o.anonLauncher, o.marketLens) =
            _addons(deployer, treasury, feeRouter, hook, launchpad, migration, pricer, o.usdg, usdgDec);
        // referralSink: address(0) = today's routing (default). Non-zero takes the whole referral 1% incl. launch KOL.
        {
            address sink = vm.envOr("REFERRAL_SINK", address(0));
            if (sink != address(0)) feeRouter.setReferralSink(sink);
        }

        vm.stopBroadcast();

        o.hook = address(hook);
        o.router = address(router);
        o.lockedLP = address(lockedLP);
        o.feeRouter = address(feeRouter);
        o.referrals = address(referrals);
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
        console2.log("Migration", o.migration);
        console2.log("Launchpad", o.launchpad);
        console2.log("QuoteProbe", o.probe);
        console2.log("QuotePricer", o.pricer);
        console2.log("UsdgDepositNotifier", o.depositNotifier);
        console2.log("USDG", o.usdg);
        console2.log("DefaultQuote", o.defaultQuote);
        console2.log("DefaultQuoteUsdWad", pricer.quotePriceUsd(o.defaultQuote));
        console2.log("LoginGate", o.loginGate);
        // Config echo (checked by the runbook pre-flight / smoke): steep curve #1, floor, sniper tax, referral sink.
        console2.log("cfg USDG decimals", usdgDec);
        console2.log("cfg CURVE_SOLD_BPS", Constants.CURVE_SOLD_BPS);
        console2.log("cfg START_MCAP_USD", Constants.START_MCAP_USD / 1e18);
        console2.log("cfg GRADUATION_MCAP_USD", Constants.GRADUATION_MCAP_USD / 1e18);
        console2.log("cfg ANTI_SNIPE_START_BPS", Constants.ANTI_SNIPE_START_BPS);
        console2.log("cfg ANTI_SNIPE_DURATION", Constants.ANTI_SNIPE_DURATION);
        console2.log("cfg MAX_FLOOR_BANDS", Constants.MAX_FLOOR_BANDS);
        console2.log("cfg referralSink", feeRouter.referralSink());
    }

    /// @dev $0.00245 per STRATEGY (18 dec) as USDG raw per STRATEGY raw, WAD, for a USDG with `usdgDec` decimals.
    function _strategyPriceWad(uint8 usdgDec) internal pure returns (uint256) {
        return (245e13 * 10 ** uint256(usdgDec)) / 1e18;
    }

    function _addons(
        address deployer,
        address treasury,
        FeeRouter feeRouter,
        DiscipleHook hook,
        Launchpad launchpad,
        Migration migration,
        QuotePricer pricer,
        address usdg,
        uint8 usdgDec
    ) internal returns (address, address, address) {
        RewardsVault vault = new RewardsVault(deployer);
        vault.setFeeRouter(address(feeRouter));
        feeRouter.setRewardsVault(address(vault));
        address vOwner = vm.envOr("REWARDS_VAULT_OWNER", deployer);
        // Owned2Step: this only nominates; REWARDS_VAULT_OWNER must call vault.acceptOwnership() afterwards.
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
            vm.envOr("ANON_LAUNCH_FEE", 25 * 10 ** uint256(usdgDec) / 100)
        );
        MarketLens lens = new MarketLens(address(launchpad), address(migration));
        console2.log("RewardsVault", address(vault));
        console2.log("AnonLauncher", address(anon));
        console2.log("MarketLens", address(lens));
        return (address(vault), address(anon), address(lens));
    }

    /// @dev price = usdg raw per quote raw, WAD. Default liquidity ≈ REF_POOL_USD per side (full range):
    ///      L = sqrt(usdgRaw * quoteRaw) with usdgRaw = USD·10^usdgDec, quoteRaw = usdgRaw·1e18/price.
    function _seedRefPool(IPoolManager manager, address q, address usdg, uint256 priceWad, uint8 usdgDec)
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
                liquidityDelta: int256(vm.envOr("REF_POOL_LIQUIDITY", _refLiquidity(priceWad, usdgDec))),
                salt: 0
            }),
            ""
        );
    }

    function _refLiquidity(uint256 priceWad, uint8 usdgDec) internal view returns (uint256) {
        uint256 usdgRaw = vm.envOr("REF_POOL_USD", uint256(1_000_000)) * 10 ** uint256(usdgDec);
        return Math.sqrt(usdgRaw * Math.mulDiv(usdgRaw, 1e18, priceWad));
    }
}
