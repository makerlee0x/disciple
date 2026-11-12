// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IQuoteProbe} from "./interfaces/IQuoteProbe.sol";
import {Owned2Step} from "./utils/Owned2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

interface IPricerPools {
    function poolKeyFor(address base) external view returns (bool ok, PoolKey memory key);
    function routeFor(address quote) external view returns (bool ok, PoolKey[] memory keys);
}

/// @title Quote probe: buy through the USDG-first route, then transfer-out / transfer-back on the quote token.
/// @notice Runs inside `PoolManager.unlock` and ALWAYS reverts at the end, so nothing settles: no funds, no state change.
///         1. swap exact-in `probeUsdg` USDG along the QuotePricer's route (1 or 2 v4 hops, hook + fee left as-is);
///         2. `take` the quote out of the PoolManager to this contract (a buy-side transfer);
///         3. transfer it back to the PoolManager and `settle` (a sell-side transfer, measured by the PM's balance delta).
///         A revert/false in 2 or 3, or no output in 1 → RejectHoneypot. Received < sent in 2 or 3 → RejectFeeOnTransfer.
/// @dev A quote with no route still soft-warns (launch then reverts on no price). The first-hop / full-route buy
///      means a quote that only has a mid-token USDG pool is actually tested, not just soft-warned.
///      Limits (documented): a token can special-case this contract's address, `tx.origin`, time or amounts, so
///      this catches generic honeypots / transfer taxes, not a token written to evade this exact probe.
///      USDG always passes. `alwaysPass` is an owner override.
contract QuoteProbe is IQuoteProbe, IUnlockCallback, Owned2Step {
    IPoolManager public immutable poolManager;
    address public immutable usdg;
    IPricerPools public immutable pricer;
    /// @notice USDG raw amount bought in the simulated round trip (≈ $1). Owner-settable.
    uint256 public probeUsdg;

    mapping(address => bool) public alwaysPass;

    error OnlyPoolManager();
    /// @dev Carries the round-trip outcome out of `unlockCallback` (always reverts).
    error ProbeOutcome(uint8 code);

    event AlwaysPassSet(address indexed token, bool ok);
    event ProbeUsdgSet(uint256 amount);

    uint8 internal constant OK = 0;
    uint8 internal constant HONEYPOT = 2;
    uint8 internal constant FOT = 3;

    constructor(address owner_, IPoolManager pm, address usdg_, address pricer_, uint256 probeUsdg_) Owned2Step(owner_) {
        poolManager = pm;
        usdg = usdg_;
        pricer = IPricerPools(pricer_);
        probeUsdg = probeUsdg_;
    }

    function setAlwaysPass(address token, bool ok) external {
        _checkOwner();
        alwaysPass[token] = ok;
        emit AlwaysPassSet(token, ok);
    }

    function setProbeUsdg(uint256 amount) external {
        _checkOwner();
        require(amount != 0, "probe: amount");
        probeUsdg = amount;
        emit ProbeUsdgSet(amount);
    }

    /// @inheritdoc IQuoteProbe
    function probe(address quote) external override returns (ProbeResult result, string memory detail) {
        if (quote == address(0)) return (ProbeResult.RejectHoneypot, "zero quote");
        if (quote == usdg) return (ProbeResult.Pass, "usdg");
        if (alwaysPass[quote]) return (ProbeResult.Pass, "allowlisted");
        (bool ok, PoolKey[] memory keys) = _route(quote);
        // No route: nothing to probe here; the pricer reverts the launch (no price) unless overridden.
        if (!ok) return (ProbeResult.SoftWarnThinDepth, "no usdg pool");
        uint8 code = HONEYPOT;
        try poolManager.unlock(abi.encode(quote, keys)) {}
        catch (bytes memory r) {
            if (r.length == 36 && bytes4(r) == ProbeOutcome.selector) {
                assembly ("memory-safe") {
                    code := mload(add(r, 36))
                }
            }
        }
        if (code == OK) return (ProbeResult.Pass, "round trip ok");
        if (code == FOT) return (ProbeResult.RejectFeeOnTransfer, "fee on transfer");
        return (ProbeResult.RejectHoneypot, "honeypot");
    }

    /// @dev Prefer `routeFor` (1 or 2 hops). Fall back to `poolKeyFor` so an older pricer still probes a single pool.
    function _route(address quote) internal view returns (bool ok, PoolKey[] memory keys) {
        try pricer.routeFor(quote) returns (bool found, PoolKey[] memory r) {
            return (found && r.length > 0, r);
        } catch {
            (bool found, PoolKey memory key) = pricer.poolKeyFor(quote);
            if (!found) return (false, keys);
            keys = new PoolKey[](1);
            keys[0] = key;
            return (true, keys);
        }
    }

    /// @dev Never returns normally: always reverts with ProbeOutcome(code).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (address base, PoolKey[] memory keys) = abi.decode(data, (address, PoolKey[]));
        uint256 amt = probeUsdg;
        address cur = usdg;
        uint256 n = keys.length;
        for (uint256 i; i < n; ++i) {
            PoolKey memory key = keys[i];
            address c0 = Currency.unwrap(key.currency0);
            bool zfo = c0 == cur;
            if (!zfo && Currency.unwrap(key.currency1) != cur) revert ProbeOutcome(HONEYPOT);
            BalanceDelta d = poolManager.swap(
                key,
                IPoolManager.SwapParams({
                    zeroForOne: zfo,
                    amountSpecified: -int256(amt),
                    sqrtPriceLimitX96: zfo ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                ""
            );
            int128 out = zfo ? d.amount1() : d.amount0();
            if (out <= 0) revert ProbeOutcome(HONEYPOT);
            amt = uint256(uint128(out));
            cur = zfo ? Currency.unwrap(key.currency1) : c0;
        }
        if (cur != base || amt == 0) revert ProbeOutcome(HONEYPOT);
        // 2. buy-side transfer: PoolManager → this (hook-adjusted output of the last hop)
        uint256 b0 = _bal(base);
        try poolManager.take(Currency.wrap(base), address(this), amt) {}
        catch {
            revert ProbeOutcome(HONEYPOT);
        }
        uint256 got = _bal(base) - b0;
        if (got < amt) revert ProbeOutcome(got == 0 ? HONEYPOT : FOT);
        // 3. sell-side transfer: this → PoolManager, measured by the PM's own balance delta
        poolManager.sync(Currency.wrap(base));
        (bool s, bytes memory ret) = base.call(abi.encodeCall(IERC20.transfer, (address(poolManager), got)));
        if (!s || (ret.length != 0 && (ret.length < 32 || !abi.decode(ret, (bool))))) revert ProbeOutcome(HONEYPOT);
        uint256 paid = poolManager.settle();
        if (paid < got) revert ProbeOutcome(paid == 0 ? HONEYPOT : FOT);
        revert ProbeOutcome(OK);
    }

    function _bal(address token) internal view returns (uint256 b) {
        (bool s, bytes memory r) = token.staticcall(abi.encodeCall(IERC20.balanceOf, (address(this))));
        if (!s || r.length < 32) revert ProbeOutcome(HONEYPOT);
        b = abi.decode(r, (uint256));
    }
}
