// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {NetworkConfig} from "./config/NetworkConfig.sol";
import {MainnetRoutes} from "./whitelist/MainnetRoutes.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReferralRegistry} from "../src/ReferralRegistry.sol";
import {LockedLP} from "../src/LockedLP.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {Migration} from "../src/Migration.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {CurveDeployer} from "../src/CurveDeployer.sol";
import {CurveFeeVault} from "../src/CurveFeeVault.sol";
import {TrampWallManager} from "../src/TrampWallManager.sol";
import {QuoteProbe} from "../src/QuoteProbe.sol";
import {QuotePricer} from "../src/QuotePricer.sol";
import {DiscipleRouter} from "../src/DiscipleRouter.sol";
import {DiscipleHook} from "../src/DiscipleHook.sol";
import {RewardsVault} from "../src/RewardsVault.sol";
import {AnonLauncher} from "../src/addons/AnonLauncher.sol";
import {CreatorFeeHarvest} from "../src/addons/CreatorFeeHarvest.sol";
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

interface IOwnable {
    function transferOwnership(address newOwner) external;
}

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
///   REFERRAL_SINK       FeeRouter.referralSink. Forced to TREASURY on 4663 (env ignored) (maker 2026-11-16: the referral 1% goes
///                       to treasury, referrers are paid by hand), address(0) elsewhere (referrer / launch KOL get
///                       the 1%). Non-zero redirects the WHOLE referral 1% incl. the launch-KOL 1% (lee, 2026-10-24).
///                       Fixed for good on 4663 by lockSettings().
///   DEFAULT_QUOTE       default launch quote (RH: STRATEGY 0x168661C52E5922288dFb2b3f323b6Cf90eb21e18)
///   DEFAULT_QUOTE_POOL_FEE / DEFAULT_QUOTE_POOL_TICK_SPACING / DEFAULT_QUOTE_POOL_HOOKS (not read on 4663: there all
///                       12 pair coins, the default quote included, get the script/whitelist/MainnetRoutes.sol routes)
///                       reference DEFAULT_QUOTE/USDG v4 pool for the QuotePricer
///                       (RH STRATEGY/USDG deepest pool: 36900 / 369 / 0x0 → id 0x816b…245b)
///   MIN_LIQUIDITY       QuotePricer minimum in-range liquidity (default: the constructor floor)
///   RENOUNCE_HARVEST    renounce CreatorFeeHarvest ownership at the end of deploy (always on mainnet 4663)
///   RENOUNCE_HOOK_ADMIN drop the DiscipleHook admin once wired (always on 4663)
///   RENOUNCE_LOCKED_LP  renounce LockedLP ownership (treasury + compound caps fixed) at the end (always on 4663)
///   KOL_CREATOR_SHARE_BPS launch-KOL slice of the creator share, bps (forced 0 on 4663, env ignored; maker 2026-11-17: KOLs
///                       are paid by hand; elsewhere the FeeRouter default 200). Fixed for good on 4663 by lockSettings().
///   LOCK_FEE_SETTINGS   FeeRouter.lockSettings(): KOL share, referral sink and claim routers fixed (always on 4663)
///   SAFE                protocol Safe (optional). Set: every contract that keeps an owner is NOMINATED to it
///                       (two-step) and the Safe calls acceptOwnership() on each (one batched Safe tx); it is also the
///                       default TREASURY and REWARDS_VAULT_OWNER. Unset (maker 2026-11-17: the Safe comes after
///                       mainnet): the deployer keeps those roles; run script/HandoverToSafe.s.sol later (mainnet: 2-of-3 Safe, no timelock
///                       at launch, maker 2026-11-17). The renounces
///                       and the FeeRouter lock still happen at deploy on 4663. Audit 2026-11-17 R461-05 / (g).
///   PRICER_POKER        QuotePricer keeper (required on 4663): launches revert StalePrice without fresh pokes
///   REWARDS_VAULT_OWNER community RewardsVault owner (default deployer): TEMP wallet on testnet, multisig (Safe) on
///                       mainnet (lee 2026-11-10). Receives the sniper tax + curve LP fees of coins not graduated
///                       within snipeEscrowTimeout (releaseSnipeEscrow, or a late graduation). Nominated only
///                       (Owned2Step): it must acceptOwnership(). Existing stack: script/rewards/DeployRewardsVault.s.sol;
///                       steps in docs/rewards-vault-runbook.md.
///   DEPLOY_TRAMP_WALL   true → also deploy TrampWallManager (testnet/local only; off for launch, maker 2026-11-17)
///   ERC5564_ANNOUNCER   ERC-5564 announcer (default 0x55649E01B5Df198D18D95b5cc5051630cfD45564)
///   DEPLOY_TEST_STRATEGY true → (DEFAULT_QUOTE unset) deploy a test STRATEGY and seed a STRATEGY/USDG pool at
///                       TEST_STRATEGY_PRICE_WAD (USDG raw per STRATEGY raw, WAD; default $0.00245 scaled to USDG's
///                       decimals: 2.45e15 for 18-dec, 2450 for 6-dec) with REF_POOL_LIQUIDITY full-range liquidity
///                       (default ≈ REF_POOL_USD per side, REF_POOL_USD default 1,000,000)
///   Chain guard: testnet/local, or explicitly confirmed mainnet with complete owner-supplied config (NetworkConfig).
contract Deploy is NetworkConfig {
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
        address rewardsVault;
        address anonLauncher;
        address marketLens;
        address creatorFeeHarvest;
    }

    function run() external returns (Out memory o) {
        _checkCoreConfig(); // fail closed before broadcast, including all mainnet address/config placeholders
        address treasury = vm.envOr("TREASURY", address(0));
        o.manager = vm.envOr("POOL_MANAGER", address(0));
        o.quoter = vm.envOr("V4_QUOTER", address(0));
        o.usdg = vm.envOr("USDG", address(0));
        o.defaultQuote = vm.envOr("DEFAULT_QUOTE", address(0));

        vm.startBroadcast();
        // The broadcasting account (== msg.sender under `forge script`; also correct when run() is called from a test).
        (, address deployer,) = vm.readCallers();
        bool mainnet = block.chainid == 4663;
        address safe = vm.envOr("SAFE", address(0));
        // SAFE may come after deploy (maker 2026-11-17): unset → the deployer keeps the remaining owner roles until
        // script/HandoverToSafe.s.sol nominates the Safe. Set → it must be a contract and is nominated below.
        require(safe == address(0) || safe.code.length != 0, "Deploy: SAFE has no code");
        if (treasury == address(0)) treasury = safe != address(0) ? safe : deployer;

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
        ReferralRegistry referrals = new ReferralRegistry(deployer);
        CreatorFeeHarvest harvest = new CreatorFeeHarvest(deployer);
        LockedLP lockedLP = new LockedLP(deployer, treasury, address(harvest));
        FeeRouter feeRouter = new FeeRouter(deployer, treasury, address(referrals));

        // Hook salt is mined against the CREATE2 factory that actually deploys it (not the EOA).
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
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
        // Tramps & walls are off for launch (maker 2026-11-17: "just remove the tramps and walls for now").
        // DEPLOY_TRAMP_WALL=true still deploys the manager off mainnet for testing.
        if (block.chainid != 4663 && vm.envOr("DEPLOY_TRAMP_WALL", false)) {
            o.trampWall = address(new TrampWallManager(manager, lockedLP, address(hook)));
        }
        // Slim hook (2026-11-17): no LP gate, no trader credit, no in-swap compounding. LockedLP.flush and the harvest's
        // route are permissionless; the site's cron calls them on a schedule.

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
                manager,
                o.defaultQuote,
                o.usdg,
                vm.envOr("TEST_STRATEGY_PRICE_WAD", _strategyPriceWad(usdgDec)),
                usdgDec
            );
            hasRef = true;
        }
        if (o.defaultQuote == address(0)) o.defaultQuote = o.usdg;


        QuotePricer pricer = new QuotePricer(deployer, manager, o.usdg);
        // Default floor is set by the constructor (1e4 * 10^((18 + usdgDecimals) / 2)); MIN_LIQUIDITY overrides it.
        pricer.setMinLiquidity(uint128(vm.envOr("MIN_LIQUIDITY", uint256(pricer.minLiquidity()))));
        if (!hasRef && o.defaultQuote != o.usdg && !mainnet) {
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
        // Only USDG and listed quotes can launch (maker 2026-11-14), so the default quote must be listed. The other
        // listed coins go through script/whitelist. The poke-pricer cron (relayer EOA) is the only TWAP writer (HK-02).
        if (o.defaultQuote != o.usdg) pricer.setAllowedQuote(o.defaultQuote, true);
        address poker = vm.envOr("PRICER_POKER", address(0));
        require(!mainnet || poker != address(0), "Deploy: PRICER_POKER required on mainnet"); // audit 2026-11-18 R461b-05
        if (poker != address(0)) pricer.setPoker(poker, true);
        // USDG-in/out routing (buyWithUsdg / sellToUsdg): USDG + curve registry, and the USDG/defaultQuote hop pool.
        router.setUsdgRouting(o.usdg, address(launchpad));
        // Curve trades via the router act for the real trader (bonding modes: caps / cost basis / attribution).
        launchpad.setTrustedRouter(address(router), true);
        feeRouter.setClaimRouter(address(router), true); // claimCreatorFeesToUsdg (separate allowlist, audit r121 Low)
        // Later send for creator-fee destinations 1 and 2. Trades do not call this. Destination 0 does not use it.
        harvest.wire(
            address(launchpad), address(feeRouter), address(lockedLP), address(router), address(manager)
        );
        launchpad.setTrustedRouter(address(harvest), true);
        // curveRouter is the first trusted router (DiscipleRouter, above); later trusts no longer move it (review N-2).
        require(launchpad.curveRouter() == address(router), "curveRouter");
        feeRouter.setClaimRouter(address(harvest), true);
        // Self-claims read this pointer. Trades do not. Destination 1 or 2 then cannot be claimed by the launcher.
        feeRouter.setCreatorFeeHarvest_51(address(harvest));
        o.creatorFeeHarvest = address(harvest);
        if (hasRef) router.setUsdgPool(o.defaultQuote, refKey);
        // Mainnet: list and route all 12 pair coins (default quote included) on the fork-tested USDG-first routes.
        if (mainnet) {
            require(o.defaultQuote == o.usdg || MainnetRoutes.isListed(o.defaultQuote), "Deploy: default quote not listed");
            _wireMainnetRoutes(pricer, router);
        }
        // Sanity: oracle must price the default quote now, else launches would revert.
        require(pricer.quotePriceUsd(o.defaultQuote) > 0, "Deploy: default quote unpriced");

        // Real round-trip probe through the pricer's base/USDG pool; probes the default base too (no allowlist).
        QuoteProbe probe = new QuoteProbe(
            deployer,
            manager,
            o.usdg,
            address(pricer),
            uint256(vm.envOr("PROBE_USDG", 10 ** uint256(pricer.usdgDecimals())))
        );

        launchpad.setPricer(address(pricer));
        // ── Combined redeploy additions (flow/anon-launch + flow/snipe-split) ──
        // Mode rules v2: sniper tax → curve snipeEscrow → LockedLP compound bucket at graduation (RewardsVault after timeout).
        // Deployed before the CurveDeployer: the CurveFeeVault takes the AnonLauncher (AUDIT H1 stealth-owner claim).
        (o.rewardsVault, o.anonLauncher, o.marketLens) =
            _addons(deployer, treasury, feeRouter, hook, launchpad, migration, pricer, o.usdg, usdgDec);
        CurveFeeVault feeVault = new CurveFeeVault(address(feeRouter), o.anonLauncher);
        o.curveDeployer = address(new CurveDeployer(address(feeVault)));
        launchpad.setCurveDeployer(o.curveDeployer);
        launchpad.setQuoteProbe(address(probe));
        launchpad.setDefaultQuote(o.defaultQuote);
        AnonLauncher(o.anonLauncher).setCreatorFeeHarvest(address(harvest));
        // Private dest 1/2 launches go through the harvest and need this pointer. The tests already set it.
        harvest.setAnonLauncher(o.anonLauncher);
        // Curve-phase creator fees settle here. route() pulls them. Trades do not call the harvest.
        harvest.setFeeVault(address(feeVault));
        // maker 2026-11-17: the fee contract is renounced once set up, so none of its pointers can change.
        // Audit 2026-11-17 L-32 / R461-05: on mainnet the renounces and locks cannot be turned off by env.
        if (mainnet || vm.envOr("RENOUNCE_HARVEST", false)) harvest.renounceOwnership();
        // maker 2026-11-17: LockedLP too (treasury + compound caps fixed for good). Its wiring setters are write-once.
        if (mainnet || vm.envOr("RENOUNCE_LOCKED_LP", false)) lockedLP.renounceOwnership();
        // referralSink: address(0) = today's routing (default). Non-zero takes the whole referral 1% incl. launch KOL.
        {
            // maker 2026-11-16: the referral 1% goes to treasury on mainnet (team pays referrers by hand). It must be
            // set before lockSettings() below, so mainnet defaults the sink to the treasury.
            // audit 2026-11-18 R461b-04: on 4663 the env is ignored (sink = treasury, KOL = 0 are forced, then locked).
            address sink = mainnet ? treasury : vm.envOr("REFERRAL_SINK", address(0));
            if (sink != address(0)) feeRouter.setReferralSink(sink);
            // maker 2026-11-17: no automatic KOL cut either ("pay it by hand"). Mainnet sets the launch-KOL slice of
            // the creator share to 0 before lockSettings(), so creators keep their full 33% and KOLs are paid by hand.
            uint256 kolBps = mainnet ? 0 : vm.envOr("KOL_CREATOR_SHARE_BPS", uint256(feeRouter.kolCreatorShareBps()));
            if (kolBps != feeRouter.kolCreatorShareBps()) feeRouter.setKolCreatorShareBps(kolBps);
        }
        if (mainnet || vm.envOr("LOCK_FEE_SETTINGS", false)) feeRouter.lockSettings();
        if (safe != address(0)) {
            _nominate(address(launchpad), safe);
            _nominate(address(feeRouter), safe);
            _nominate(address(pricer), safe);
            _nominate(address(probe), safe);
            _nominate(address(migration), safe);
            _nominate(address(router), safe);
            if (o.trampWall != address(0)) _nominate(o.trampWall, safe);
            _nominate(address(referrals), safe);
            _nominate(o.anonLauncher, safe);
            if (lockedLP.owner() != address(0)) _nominate(address(lockedLP), safe);
            if (harvest.owner() != address(0)) _nominate(address(harvest), safe);
        }
        require(router.usdg() == o.usdg, "verify: router.usdg"); // round 5: the write-once USDG half
        _verify(mainnet, feeRouter, hook, lockedLP, harvest, launchpad, router, AnonLauncher(o.anonLauncher));

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
        console2.log("USDG", o.usdg);
        console2.log("DefaultQuote", o.defaultQuote);
        console2.log("DefaultQuoteUsdWad", pricer.quotePriceUsd(o.defaultQuote));
        console2.log("CreatorFeeHarvest", o.creatorFeeHarvest);
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

    /// @dev Two-step: only nominates. The Safe then calls acceptOwnership() on each contract.
    function _nominate(address c, address safe) internal {
        IOwnable(c).transferOwnership(safe);
    }

    /// @dev Post-deploy read-back (audit 2026-11-17 L-3 / L-7 / L-32 / Q13). The read-back, not the script, is the
    ///      evidence; the runbook repeats these checks on-chain before the first launch.
    function _verify(
        bool mainnet,
        FeeRouter feeRouter,
        DiscipleHook hook,
        LockedLP lockedLP,
        CreatorFeeHarvest harvest,
        Launchpad launchpad,
        DiscipleRouter router,
        AnonLauncher anon
    ) internal view {
        require(feeRouter.authorizedCallers(address(hook)) && feeRouter.ownerAuthorizationUsed(), "verify: hook auth");
        require(feeRouter.creatorFeeHarvest_16() == address(harvest), "verify: harvest pointer");
        require(anon.creatorFeeHarvest() == address(harvest), "verify: anon harvest");
        require(address(harvest.anon()) == address(anon) && address(harvest.feeVault()) != address(0), "verify: harvest");
        require(launchpad.curveRouter() == address(router), "verify: curveRouter");
        require(address(launchpad.curveDeployer()) != address(0), "verify: curve deployer");
        // audit 2026-11-18 C-N3 / C-R2: write-once wiring pointers read back
        require(feeRouter.launchpad() == address(launchpad), "verify: feeRouter.launchpad");
        require(address(feeRouter.lockedLP()) == address(lockedLP), "verify: feeRouter.lockedLP");
        require(router.launchpad() == address(launchpad), "verify: router.launchpad");
        // round 5 (C-N1): claim routers must be set before lockSettings freezes the list
        require(feeRouter.isClaimRouter(address(router)) && feeRouter.isClaimRouter(address(harvest)), "verify: claim routers");
        if (mainnet) {
            // audit 2026-11-18 E-L3: the locked values, not just the lock (env overrides could lock wrong values)
            require(feeRouter.kolCreatorShareBps() == 0, "verify: KOL share 0");
            require(feeRouter.referralSink() == feeRouter.treasury(), "verify: referral sink = treasury");
            require(harvest.owner() == address(0), "verify: harvest renounced");
            require(lockedLP.owner() == address(0), "verify: lockedLP renounced");
            require(hook.admin() == address(0), "verify: hook admin");
            require(feeRouter.settingsLocked(), "verify: fee settings locked");
        }
    }

    /// @dev setUsdgRoute + setAllowedQuote + setPriceRoute for each of the 12 pair coins (script/whitelist/MainnetRoutes),
    ///      then requires each one to price (QuotePricer.quotePriceUsd: route TWAP, min liquidity, per-side depth).
    function _wireMainnetRoutes(QuotePricer pricer, DiscipleRouter router) internal {
        address[12] memory q = MainnetRoutes.quotes();
        for (uint256 i; i < 12; ++i) {
            (PoolKey[] memory keys,,,) = MainnetRoutes.routeOf(q[i]);
            router.setUsdgRoute(q[i], keys);
            pricer.setAllowedQuote(q[i], true);
            pricer.setPriceRoute(q[i], keys);
            // Audit delta L-01: price every route now (min liquidity + $10k per-side depth run at pricing time),
            // so a listed pair coin that can't launch fails the deploy instead of failing its first launch.
            require(pricer.quotePriceUsd(q[i]) > 0, "Deploy: pair route unpriced");
            console2.log("PairRoute", q[i], keys.length);
        }
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
        address vOwner = vm.envOr("REWARDS_VAULT_OWNER", vm.envOr("SAFE", deployer));
        // Owned2Step: this only nominates; REWARDS_VAULT_OWNER must call vault.acceptOwnership() afterwards.
        if (vOwner != deployer) vault.transferOwnership(vOwner);
        // mcapNow / Trade-event mcap fix: live QuotePricer on the hook (curves read Launchpad.pricer()).
        hook.setPricer(address(pricer));
        // maker 2026-11-17: the hook keeps no admin once wired (setMigration above, setPricer here).
        if (block.chainid == 4663 || vm.envOr("RENOUNCE_HOOK_ADMIN", false)) hook.renounceAdmin();
        AnonLauncher anon = new AnonLauncher(
            deployer,
            address(launchpad),
            address(feeRouter),
            usdg,
            vm.envOr("ERC5564_ANNOUNCER", address(0x55649E01B5Df198D18D95b5cc5051630cfD45564))
        ); // hidden launches are free forever (maker 2026-11-17): no fee setting exists
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
