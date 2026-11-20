// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {Constants} from "./libraries/Constants.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IQuotePricer} from "./interfaces/IQuotePricer.sol";
import {McapMath} from "./libraries/McapMath.sol";

interface IMigrationLockedLP {
    function lockedLP() external view returns (address);
    function launchpad() external view returns (address);
}

interface IHookLaunchpad {
    function creatorOf(address token) external view returns (address);
}

interface IHookLockedLP {
    function creditLockedLiquidity(address token, address quote, uint256 tokenAmount, uint256 quoteAmount)
        external
        returns (bool compoundReady);
}

interface IHookCreatorFeeDestination {
    function creatorFeeDestinationOf(address token) external view returns (uint8);
    function creatorFeeRecipientOf(address token, address creator) external view returns (address);
}

/// @title Post-grad 1% trade-fee hook (§3 / LOCKED #11, maker 2026-11-19: the hook keeps the fee, claims later)
/// @notice Pool LP fee is 0. During a swap this hook does one thing: it keeps 1% of the swap's unspecified
///         (output-side) amount for ITSELF and adds it to the pool's running fee total. The fee is held as the hook's
///         PoolManager balance (ERC-6909 `mint`, no ERC-20 transfer during the swap, so a token that froze the hook's
///         address could not block trading). No other contract is called during a swap (no FeeRouter, no Launchpad,
///         no LockedLP, no referral lookup). A claim burns that balance and the PoolManager pays the recipient.
///         The 33/33/33/1 split happens only when someone claims. Claims are public (any wallet, keeper or bot) and
///         always pay the fixed recipient, never the caller:
///           - 33% creator: the coin's current creator (Launchpad.creatorOf at claim time), or, when the launcher
///             picked locked LP / burn on CreatorFeeHarvest, LockedLP / the dead address.
///           - 33% locked liquidity: LockedLP's compound bucket for the coin.
///           - 33% treasury: `treasury`, fixed at deploy.
///           - 1% community rewards: `communitySafe`, fixed at deploy.
///         beforeInitialize: only LockedLP (via Migration at graduation) may create a pool on this hook.
///         Nothing here is adjustable: the fee, the split and both Safes are fixed at deploy; the admin only wires
///         the set-once pointers and is then renounced.
/// @dev Must be mined to an address with BEFORE_INITIALIZE_FLAG | AFTER_SWAP_FLAG | AFTER_SWAP_RETURNS_DELTA_FLAG.
///      Accounting is cumulative: `feesOf[pool]` only grows; each share's claimable amount is its fixed fraction of
///      the running total minus what that share already claimed, so nothing can be paid twice. Each share rounds
///      down on its own (at most 3 wei per pool and currency stays in the hook).
///      The view helpers (metaOf, quoteUsdOf, mcapUsdFromSqrt, impactBpsFromSqrt) are read by DiscipleRouter quotes and
///      MarketLens only; none of them runs on the swap path.
contract DiscipleHook is IHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using SafeCast for uint256;
    using CurrencyLibrary for Currency;

    /// @notice Share ids for `claimable` / `claimedOf` (33 / 33 / 33 / 1 of every fee).
    uint8 public constant SHARE_CREATOR = 0;
    uint8 public constant SHARE_LOCKED_LP = 1;
    uint8 public constant SHARE_TREASURY = 2;
    uint8 public constant SHARE_COMMUNITY = 3;
    /// @notice CreatorFeeHarvest destinations (same values as CreatorFeeHarvest.DEST_*).
    uint8 internal constant DEST_LOCKED_LP = 1;
    uint8 internal constant DEST_BURN = 2;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    IPoolManager public immutable poolManager;
    /// @notice 33% treasury share recipient (the treasury Safe). Fixed at deploy.
    address public immutable treasury;
    /// @notice 1% community rewards share recipient (the community rewards Safe). Fixed at deploy.
    address public immutable communitySafe;

    struct PoolMeta {
        address token;
        address quote;
        address creator; // creator at graduation (fallback only; claims pay Launchpad.creatorOf)
        bool registered;
        uint256 quotePriceUsd; // launch-time USD WAD per 1e18 raw quote (quoteUsdOf fallback)
    }

    /// @notice Running fee totals of one pool, in currency0 / currency1 raw units. Only ever grows.
    struct Fees {
        uint128 amount0;
        uint128 amount1;
    }

    mapping(PoolId => PoolMeta) public metaOf;
    /// @notice Graduated pool of a launch token (set at registration).
    mapping(address token => PoolId) public poolOf;
    /// @notice Lifetime fees taken by the hook per pool (the only storage a swap writes).
    mapping(PoolId => Fees) public feesOf;
    /// @notice Lifetime amount already paid out per pool and share (SHARE_*).
    mapping(PoolId => mapping(uint8 share => Fees)) public claimedOf;
    /// @notice Lifetime quote-side creator fees paid to `payee` for `token`. AnonLauncher holds many hidden coins'
    ///         quote in one balance, so it reads this to know how much of a public claim belongs to which coin.
    mapping(address token => mapping(address payee => uint256)) public creatorQuotePaidTo;

    address public admin;
    address public pendingAdmin;
    address public migration;
    /// @notice Live quote/USD oracle, read only by the view `quoteUsdOf`. Never called during a swap.
    IQuotePricer public pricer;
    /// @notice CreatorFeeHarvest (launcher's keep / lock / burn pick). Set once by the admin; read at claim only.
    address public creatorFeeHarvest;

    event AdminTransferred(address indexed admin);
    /// @notice One share of one pool was paid out. `to` is the fixed recipient (LockedLP / dEaD for routed creator
    ///         fees). Amounts are raw token / quote units.
    event FeesClaimed(
        address indexed token, uint8 indexed share, address indexed to, uint256 quoteAmount, uint256 tokenAmount
    );

    error OnlyPoolManager();
    error OnlyMigration();
    error HookNotImplemented();
    error NotRegistered();
    error OnlyAdmin();
    error OnlyLockedLP();
    error ZeroAddress();
    error NothingToClaim();
    event ClaimFailed(address indexed token, uint8 share);

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        _;
    }

    constructor(
        IPoolManager poolManager_,
        address migration_,
        address admin_,
        address treasury_,
        address communitySafe_
    ) {
        if (treasury_ == address(0) || communitySafe_ == address(0)) revert ZeroAddress();
        admin = admin_;
        poolManager = poolManager_;
        migration = migration_;
        treasury = treasury_;
        communitySafe = communitySafe_;
        Hooks.validateHookPermissions(this, getHookPermissions());
    }

    /// @notice One-time wire when constructed with migration == address(0). Audit #12: admin-only (the deployer,
    ///         set in the constructor) so it cannot be front-run between hook deploy and wiring.
    function setMigration(address m) external {
        if (msg.sender != admin) revert OnlyAdmin();
        require(migration == address(0) && m.code.length != 0, "DiscipleHook: mig"); // F-L11: contract only
        migration = m;
    }

    /// @notice One-time wire of CreatorFeeHarvest (the launcher's lock / burn pick for the creator share).
    function setCreatorFeeHarvest(address h) external {
        if (msg.sender != admin) revert OnlyAdmin();
        require(creatorFeeHarvest == address(0) && h.code.length != 0, "DiscipleHook: harvest");
        creatorFeeHarvest = h;
    }

    function setPricer(address p) external {
        if (msg.sender != admin) revert OnlyAdmin();
        pricer = IQuotePricer(p);
    }

    /// @notice maker 2026-11-17: once wired, the admin is dropped for good, so the hook has no privileged role at all.
    function renounceAdmin() external {
        if (msg.sender != admin) revert OnlyAdmin();
        require(migration != address(0), "DiscipleHook: mig");
        require(creatorFeeHarvest != address(0), "DiscipleHook: harvest"); // audit delta-2 D2-I1
        admin = address(0);
        delete pendingAdmin;
        emit AdminTransferred(address(0));
    }

    /// @notice Two-step (audit 2026-11-17 L-27): nominates `a`, who must call acceptAdmin.
    function transferAdmin(address a) external {
        if (msg.sender != admin) revert OnlyAdmin();
        pendingAdmin = a;
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin || msg.sender == address(0) || admin == address(0)) revert OnlyAdmin();
        admin = msg.sender;
        delete pendingAdmin;
        emit AdminTransferred(msg.sender);
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @notice Called by Migration at graduation to bind pool → token/quote/creator (claims + view helpers).
    function registerPool(PoolKey calldata key, address token, address quote, address creator, uint256 quotePriceUsd)
        external
    {
        if (msg.sender != migration) revert OnlyMigration();
        PoolId id = key.toId();
        metaOf[id] =
            PoolMeta({token: token, quote: quote, creator: creator, registered: true, quotePriceUsd: quotePriceUsd});
        poolOf[token] = id;
    }

    /// @dev Only LockedLP (seeding at graduation, called by Migration) may initialize.
    function beforeInitialize(address sender, PoolKey calldata, uint160)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        address m = migration;
        if (m == address(0) || sender != IMigrationLockedLP(m).lockedLP()) revert OnlyLockedLP();
        return IHooks.beforeInitialize.selector;
    }

    /// @dev 1% of the unspecified (output for exact-in) amount, minted to this hook as a PoolManager (ERC-6909) balance
    ///      and returned as the hook delta, so the swapper's BalanceDelta already shows the net amount. The only other
    ///      effect is one storage write (the pool's running fee total). No external call besides PoolManager.mint.
    function afterSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        PoolId id = key.toId();
        if (!metaOf[id].registered) revert NotRegistered();

        bool specifiedTokenIs0 = (params.amountSpecified < 0 == params.zeroForOne);
        (Currency feeCurrency, int128 swapAmount) =
            specifiedTokenIs0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        if (swapAmount < 0) swapAmount = -swapAmount;

        uint256 feeAmount = uint256(uint128(swapAmount)) * Constants.TRADE_FEE_BPS / Constants.BPS_DENOM;
        if (feeAmount > 0) {
            poolManager.mint(address(this), feeCurrency.toId(), feeAmount);
            Fees storage f = feesOf[id];
            if (specifiedTokenIs0) f.amount1 += uint128(feeAmount);
            else f.amount0 += uint128(feeAmount);
        }
        return (IHooks.afterSwap.selector, feeAmount.toInt128());
    }

    // ── claims (public; pay the fixed recipient, never the caller) ──────────

    /// @notice Pay this coin's creator share (quote and rocket-token sides, one transaction).
    function claimCreatorFees(address token) public returns (uint256 quoteAmount, uint256 tokenAmount) {
        (PoolId id, PoolMeta memory m, bool tokenIsC0) = _pool(token);
        (quoteAmount, tokenAmount) = _take(id, SHARE_CREATOR, tokenIsC0);
        address h = creatorFeeHarvest;
        uint8 dest = h == address(0) ? 0 : IHookCreatorFeeDestination(h).creatorFeeDestinationOf(token);
        address to;
        if (dest == DEST_LOCKED_LP) {
            to = _toLockedLP(token, m.quote, tokenAmount, quoteAmount);
        } else if (dest == DEST_BURN) {
            to = BURN;
            _pay(m.quote, token, to, quoteAmount, tokenAmount);
        } else {
            to = IHookLaunchpad(IMigrationLockedLP(migration).launchpad()).creatorOf(token);
            if (to == address(0)) to = m.creator;
            if (h != address(0)) to = IHookCreatorFeeDestination(h).creatorFeeRecipientOf(token, to); // Pays to
            if (to == address(0)) revert ZeroAddress(); // audit delta-2 D2-I2
            if (quoteAmount != 0) creatorQuotePaidTo[token][to] += quoteAmount;
            _pay(m.quote, token, to, quoteAmount, tokenAmount);
        }
        emit FeesClaimed(token, SHARE_CREATOR, to, quoteAmount, tokenAmount);
    }

    /// @notice Pay this coin's 33% locked-liquidity share into LockedLP (compound bucket; LockedLP.flush adds it).
    function claimLockedLiquidityFees(address token) public returns (uint256 quoteAmount, uint256 tokenAmount) {
        (PoolId id, PoolMeta memory m, bool tokenIsC0) = _pool(token);
        (quoteAmount, tokenAmount) = _take(id, SHARE_LOCKED_LP, tokenIsC0);
        address to = _toLockedLP(token, m.quote, tokenAmount, quoteAmount);
        emit FeesClaimed(token, SHARE_LOCKED_LP, to, quoteAmount, tokenAmount);
    }

    /// @notice Pay this coin's 33% treasury share to `treasury`.
    function claimTreasuryFees(address token) public returns (uint256 quoteAmount, uint256 tokenAmount) {
        (quoteAmount, tokenAmount) = _claimTo(token, SHARE_TREASURY, treasury);
    }

    /// @notice Pay this coin's 1% community rewards share to `communitySafe`.
    function claimCommunityFees(address token) public returns (uint256 quoteAmount, uint256 tokenAmount) {
        (quoteAmount, tokenAmount) = _claimTo(token, SHARE_COMMUNITY, communitySafe);
    }

    /// @notice Pay every share of every listed coin that has something owed (skips empty shares, never reverts
    ///         NothingToClaim). For keepers / bots.
    function claimAll(address[] calldata tokens) external {
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            for (uint8 s; s < 4; ++s) {
                (uint256 q, uint256 k) = claimable(t, s);
                if (q == 0 && k == 0) continue;
                // audit delta-2 L-02: best effort. One reverting recipient (e.g. a blacklisted payee) skips only that
                // share; every other share and coin in the batch still pays. Each share stays claimable on its own.
                bool ok;
                if (s == SHARE_CREATOR) (ok,) = address(this).call(abi.encodeCall(this.claimCreatorFees, (t)));
                else if (s == SHARE_LOCKED_LP) (ok,) = address(this).call(abi.encodeCall(this.claimLockedLiquidityFees, (t)));
                else if (s == SHARE_TREASURY) (ok,) = address(this).call(abi.encodeCall(this.claimTreasuryFees, (t)));
                else (ok,) = address(this).call(abi.encodeCall(this.claimCommunityFees, (t)));
                if (!ok) emit ClaimFailed(t, s);
            }
        }
    }

    /// @notice What `share` (SHARE_*) of `token`'s pool can claim now, split into quote and rocket-token amounts.
    function claimable(address token, uint8 share) public view returns (uint256 quoteAmount, uint256 tokenAmount) {
        PoolId id = poolOf[token];
        PoolMeta memory m = metaOf[id];
        if (!m.registered || m.token != token) return (0, 0);
        (uint256 a0, uint256 a1) = _owed(id, share);
        bool tokenIsC0 = uint160(token) < uint160(m.quote);
        return tokenIsC0 ? (a1, a0) : (a0, a1);
    }

    function _claimTo(address token, uint8 share, address to) internal returns (uint256 quoteAmount, uint256 tokenAmount) {
        (PoolId id, PoolMeta memory m, bool tokenIsC0) = _pool(token);
        (quoteAmount, tokenAmount) = _take(id, share, tokenIsC0);
        _pay(m.quote, token, to, quoteAmount, tokenAmount);
        emit FeesClaimed(token, share, to, quoteAmount, tokenAmount);
    }

    function _pool(address token) internal view returns (PoolId id, PoolMeta memory m, bool tokenIsC0) {
        id = poolOf[token];
        m = metaOf[id];
        if (!m.registered || m.token != token) revert NotRegistered();
        tokenIsC0 = uint160(token) < uint160(m.quote);
    }

    /// @dev Book `share`'s owed amounts as claimed (effects before any transfer) and return them as quote / token.
    function _take(PoolId id, uint8 share, bool tokenIsC0) internal returns (uint256 quoteAmount, uint256 tokenAmount) {
        (uint256 a0, uint256 a1) = _owed(id, share);
        if (a0 == 0 && a1 == 0) revert NothingToClaim();
        Fees storage c = claimedOf[id][share];
        c.amount0 += uint128(a0);
        c.amount1 += uint128(a1);
        (quoteAmount, tokenAmount) = tokenIsC0 ? (a1, a0) : (a0, a1);
    }

    /// @dev share of the running total (33/33/33/1, each rounded down) minus what it already claimed.
    /// @dev Cumulative-total minus claimed per share (the MasterChef "reward debt" pattern).
    ///      Audit delta-2 L-03 (accepted): each share's target is floor(total * pct / DENOM) on the running total, so
    ///      the four targets sum to at most `total` and the unpaid remainder is the sum of four fractional parts: under
    ///      4 raw units per currency per pool at any time. It does not grow with volume (it is recomputed from the
    ///      cumulative total) and no share can over-claim. Computing one share as the remainder was rejected: it makes
    ///      that share's target non-monotonic, which could put `claimedOf` above the target and revert the subtraction.
    function _owed(PoolId id, uint8 share) internal view returns (uint256 a0, uint256 a1) {
        Fees memory f = feesOf[id];
        Fees memory c = claimedOf[id][share];
        uint256 pct = share == SHARE_CREATOR
            ? Constants.FEE_SHARE_CREATOR
            : share == SHARE_LOCKED_LP
                ? Constants.FEE_SHARE_LP_LOCK
                : share == SHARE_TREASURY ? Constants.FEE_SHARE_TREASURY : Constants.FEE_SHARE_REFERRAL;
        if (share > SHARE_COMMUNITY) return (0, 0);
        a0 = uint256(f.amount0) * pct / Constants.FEE_SHARE_DENOM - c.amount0;
        a1 = uint256(f.amount1) * pct / Constants.FEE_SHARE_DENOM - c.amount1;
    }

    function _toLockedLP(address token, address quote, uint256 tokenAmount, uint256 quoteAmount)
        internal
        returns (address lp)
    {
        lp = IMigrationLockedLP(migration).lockedLP();
        _pay(quote, token, lp, quoteAmount, tokenAmount);
        IHookLockedLP(lp).creditLockedLiquidity(token, quote, tokenAmount, quoteAmount);
    }

    /// @dev Burn the hook's PoolManager balance and have the PoolManager send the tokens straight to `to`.
    function _pay(address quote, address token, address to, uint256 quoteAmount, uint256 tokenAmount) internal {
        poolManager.unlock(abi.encode(quote, token, to, quoteAmount, tokenAmount));
    }

    /// @dev PoolManager callback for `_pay` only (claims). burn credits the hook, take debits it: net zero.
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (address quote, address token, address to, uint256 quoteAmount, uint256 tokenAmount) =
            abi.decode(data, (address, address, address, uint256, uint256));
        _burnTake(Currency.wrap(quote), to, quoteAmount);
        _burnTake(Currency.wrap(token), to, tokenAmount);
        return "";
    }

    function _burnTake(Currency c, address to, uint256 amount) internal {
        if (amount == 0) return;
        poolManager.burn(address(this), c.toId(), amount);
        poolManager.take(c, to, amount);
    }

    // ── views (not on the swap path) ────────────────────────────────────────

    /// @notice Live quote/USD price (falls back to launch-time). DiscipleRouter.quoteExactIn's mcapAfterUsd uses it.
    function quoteUsdOf(PoolId id) external view returns (uint256) {
        PoolMeta memory m = metaOf[id];
        if (address(pricer) != address(0)) {
            try pricer.quotePriceUsd(m.quote) returns (uint256 p) {
                if (p > 0) return p;
            } catch {}
        }
        return m.quotePriceUsd;
    }

    /// @notice Full-precision spot mcap (USD WAD) from sqrtPriceX96; qUsd = USD WAD per 1e18 raw quote.
    function mcapUsdFromSqrt(uint160 sqrtP, bool tokenIsC0, uint256 qUsd) public pure returns (uint256) {
        return McapMath.mcapUsdFromSqrt(sqrtP, tokenIsC0, Constants.TOTAL_SUPPLY, qUsd);
    }

    /// @notice quote raw * 1e18 / token raw from a v4 sqrtPriceX96.
    function priceX18FromSqrt(uint160 sqrtP, bool tokenIsC0) public pure returns (uint256) {
        if (sqrtP == 0) return 0;
        uint256 pX128 = Math.mulDiv(sqrtP, sqrtP, 1 << 64); // c1 per c0, X128
        return tokenIsC0 ? Math.mulDiv(pX128, 1e18, 1 << 128) : Math.mulDiv(1 << 128, 1e18, pX128);
    }

    /// @notice |Δprice|/price in bps, price = quote per token, from sqrt prices (full precision).
    function impactBpsFromSqrt(uint160 sb, uint160 sa, bool tokenIsC0) public pure returns (uint256) {
        if (sb == 0 || sa == 0) return 0;
        uint256 d = sa > sb ? uint256(sa - sb) : uint256(sb - sa);
        uint256 sum = uint256(sa) + uint256(sb);
        // token c0: p ∝ s² → |sa²-sb²|/sb² ; token c1: p ∝ 1/s² → |sa²-sb²|/sa²
        uint256 denomRoot = tokenIsC0 ? sb : sa;
        return Math.mulDiv(Math.mulDiv(d, sum, denomRoot), Constants.BPS_DENOM, denomRoot);
    }

    // ── unused hooks revert ──────────────────────────────────────────────────
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, bytes calldata)
        external
        pure
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
