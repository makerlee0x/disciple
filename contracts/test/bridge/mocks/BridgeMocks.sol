// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory name_, string memory symbol_, uint8 dec_) ERC20(name_, symbol_) {
        _dec = dec_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice ERC-4626 whose `withdraw` can be switched off. Donations (raw transfers in) raise the share price.
contract MockVault is ERC4626 {
    bool public live = true;
    bool public redeemLive = true;
    /// @dev Raw assets still available to `withdraw`. `type(uint256).max` means the whole position.
    ///      A finite budget falls as withdrawals land, so one unwind cannot drain more than this call's cash.
    uint256 public cash = type(uint256).max;

    constructor(IERC20 usdg_) ERC20("Steakhouse USDG", "stUSDG") ERC4626(usdg_) {}

    function setLive(bool v) external {
        live = v;
    }

    function setRedeemLive(bool v) external {
        redeemLive = v;
    }

    function setCash(uint256 assets) external {
        cash = assets;
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 m = super.maxWithdraw(owner);
        return m > cash ? cash : m;
    }

    function redeem(uint256 shares, address receiver, address owner) public override returns (uint256) {
        require(redeemLive, "redeem-down");
        return super.redeem(shares, receiver, owner);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override returns (uint256) {
        require(live, "vault-down");
        uint256 out = super.withdraw(assets, receiver, owner);
        if (cash != type(uint256).max) cash -= assets;
        return out;
    }

    /// @dev Destroy assets so `previewRedeem` falls. Simulates a vault that cannot pay in full.
    function slash(uint256 assets) external {
        IERC20(asset()).transfer(address(0xdead), assets);
    }
}

/// @notice Stand-in for a Uniswap v2 factory. Tests register the pair they want `getPair` to return.
contract MockV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function setPair(address a, address b, address pair) external {
        getPair[a][b] = pair;
        getPair[b][a] = pair;
    }
}

/// @notice Minimal v2 pair. Reserves set the tick. Token balances set the TVL the hook reads.
contract MockV2Pair {
    address public immutable token0;
    address public immutable token1;
    uint112 public reserve0;
    uint112 public reserve1;

    constructor(address a, address b) {
        require(a != address(0) && b != address(0) && a != b, "pair");
        token0 = a < b ? a : b;
        token1 = a < b ? b : a;
    }

    function setReserves(uint112 r0, uint112 r1) external {
        reserve0 = r0;
        reserve1 = r1;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, uint32(block.timestamp));
    }
}

/// @notice Stand-in for a Uniswap v3 factory. Tests register the pool they want `getPool` to return.
contract MockV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;

    function setPool(address a, address b, uint24 fee, address pool) external {
        getPool[a][b][fee] = pool;
        getPool[b][a][fee] = pool;
    }
}

/// @notice Minimal Uniswap v3 pool. `observe` is the cumulative tick. `slot0` is the spot, which the hook must ignore.
///         Two points exist at construction so cardinality is 2, but both are at `block.timestamp`, so a
///         30-minute `observe` still reverts until `pin` rewrites the window.
contract MockV3Pool {
    struct Point {
        uint32 t;
        int56 cum;
        int24 tick;
    }

    address public immutable token0;
    address public immutable token1;
    int24 public spotTick;
    bool public broken;
    bool public absurd;
    Point[] internal points;

    error OldObservation();

    constructor(address token0_, address token1_, int24 tick_) {
        require(token0_ != address(0) && token1_ != address(0) && token0_ != token1_, "pair");
        token0 = token0_;
        token1 = token1_;
        spotTick = tick_;
        uint32 nowT = uint32(block.timestamp);
        points.push(Point({t: nowT, cum: 0, tick: tick_}));
        points.push(Point({t: nowT, cum: 0, tick: tick_}));
    }

    /// @dev Leave a single observation so `slot0` cardinality is below the hook's minimum.
    function dropToOne() external {
        while (points.length > 1) points.pop();
    }

    function setBroken(bool on) external {
        broken = on;
    }

    /// @dev `observe` returns a cumulative the hook cannot turn into a tick.
    function setAbsurd(bool on) external {
        absurd = on;
    }

    /// @dev Rewrite history so the whole 31-minute window is `tick_`. The TWAP is that tick immediately.
    function pin(int24 tick_) external {
        while (points.length > 0) points.pop();
        uint32 nowT = uint32(block.timestamp);
        uint32 start = nowT - uint32(31 minutes);
        points.push(Point({t: start, cum: 0, tick: tick_}));
        int56 cumNow;
        unchecked {
            cumNow = int56(tick_) * int56(uint56(nowT - start));
        }
        points.push(Point({t: nowT, cum: cumNow, tick: tick_}));
        spotTick = tick_;
        broken = false;
        absurd = false;
    }

    /// @dev Full Uniswap v3 `slot0`. Cardinality is the number of stored points.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        uint16 card = uint16(points.length);
        return (TickMath.getSqrtPriceAtTick(spotTick), spotTick, 0, card, card, 0, true);
    }

    /// @notice Move the spot. A change in the same timestamp has zero duration, so the TWAP does not move.
    function setTick(int24 tick_) external {
        uint256 n = points.length;
        Point memory last = points[n - 1];
        uint32 nowT = uint32(block.timestamp);
        int56 cumNow;
        unchecked {
            cumNow = last.cum + int56(last.tick) * int56(uint56(nowT - last.t));
        }
        if (nowT == last.t) points[n - 1].tick = tick_;
        else points.push(Point({t: nowT, cum: cumNow, tick: tick_}));
        spotTick = tick_;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        if (broken) revert OldObservation();
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        if (absurd) {
            for (uint256 i; i < secondsAgos.length; ++i) {
                tickCumulatives[i] = i == 0 ? type(int56).min : type(int56).max;
            }
            return (tickCumulatives, secondsPerLiquidityCumulativeX128s);
        }
        uint32 nowT = uint32(block.timestamp);
        for (uint256 i; i < secondsAgos.length; ++i) {
            if (secondsAgos[i] > nowT) revert OldObservation();
            tickCumulatives[i] = _cumAt(nowT - secondsAgos[i]);
        }
    }

    function _cumAt(uint32 t) internal view returns (int56) {
        uint256 n = points.length;
        if (n == 0 || t < points[0].t) revert OldObservation();
        uint256 lo;
        uint256 hi = n - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) >> 1;
            if (points[mid].t <= t) lo = mid;
            else hi = mid - 1;
        }
        Point memory pt = points[lo];
        unchecked {
            return pt.cum + int56(pt.tick) * int56(uint56(t - pt.t));
        }
    }
}
