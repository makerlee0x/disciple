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
}

/// @title Quote (base) probe: buy → transfer-out → transfer-back round trip through the base/USDG v4 pool (§6 / #31–#32)
/// @notice Runs inside `PoolManager.unlock` and ALWAYS reverts at the end, so nothing settles: no funds, no state change.
///         1. swap exact-in `probeUsdg` USDG → base in the pool the QuotePricer uses (registered or discovered);
///         2. `take` the base out of the PoolManager to this contract (a buy-side transfer);
///         3. transfer it back to the PoolManager and `settle` (a sell-side transfer, measured by the PM's balance delta).
///         A revert/false in 2 or 3, or no output in 1 → RejectHoneypot. Received < sent in 2 or 3 → RejectFeeOnTransfer.
/// @dev Limits (documented): a token can special-case this contract's address, `tx.origin`, time or amounts, so
///      this catches generic honeypots / transfer taxes, not a token written to evade this exact probe.
///      USDG always passes. `alwaysPass` is an owner override (e.g. a base with no v4 USDG pool yet).
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
        (bool ok, PoolKey memory key) = pricer.poolKeyFor(quote);
        // No pool: nothing to probe here; the pricer reverts the launch (no price) unless overridden.
        if (!ok) return (ProbeResult.SoftWarnThinDepth, "no usdg pool");
        uint8 code = HONEYPOT;
        try poolManager.unlock(abi.encode(quote, key)) {}
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

    /// @dev Never returns normally: always reverts with ProbeOutcome(code).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (address base, PoolKey memory key) = abi.decode(data, (address, PoolKey));
        bool usdgIs0 = Currency.unwrap(key.currency0) == usdg;
        BalanceDelta d = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: usdgIs0,
                amountSpecified: -int256(probeUsdg),
                sqrtPriceLimitX96: usdgIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 out = usdgIs0 ? d.amount1() : d.amount0();
        if (out <= 0) revert ProbeOutcome(HONEYPOT);
        uint256 sent = uint256(uint128(out));
        // 2. buy-side transfer: PoolManager → this
        uint256 b0 = _bal(base);
        try poolManager.take(Currency.wrap(base), address(this), sent) {}
        catch {
            revert ProbeOutcome(HONEYPOT);
        }
        uint256 got = _bal(base) - b0;
        if (got < sent) revert ProbeOutcome(got == 0 ? HONEYPOT : FOT);
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
