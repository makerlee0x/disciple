// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ILzRead, ILzReadConsumer} from "../../../src/bridge/interfaces/ILzRead.sol";

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

    constructor(IERC20 usdg_) ERC20("Steakhouse USDG", "stUSDG") ERC4626(usdg_) {}

    function setLive(bool v) external {
        live = v;
    }

    function withdraw(uint256 assets, address receiver, address owner) public override returns (uint256) {
        require(live, "vault-down");
        return super.withdraw(assets, receiver, owner);
    }

    /// @dev Destroy assets so `previewRedeem` falls. Simulates a vault that cannot pay in full.
    function slash(uint256 assets) external {
        IERC20(asset()).transfer(address(0xdead), assets);
    }
}

/// @notice Async lzRead. `sendRead` does not call back; tests call `fulfill` in a later transaction.
contract MockLzRead is ILzRead {
    uint256 public fee = 0.001 ether;
    bytes32 public lastGuid;
    bytes public lastCallData;
    address public lastTarget;
    uint32 public lastEid;
    address public consumer;
    uint256 public n;

    function quoteRead(EvmRead calldata) external view returns (uint256 nativeFee) {
        return fee;
    }

    function sendRead(EvmRead calldata read, address) external payable returns (bytes32 guid) {
        require(msg.value >= fee, "lz fee");
        n += 1;
        guid = bytes32(n);
        lastGuid = guid;
        lastCallData = read.callData;
        lastTarget = read.target;
        lastEid = read.targetEid;
        consumer = msg.sender;
    }

    function fulfill(bytes32 guid, uint256 priceWad, uint256 tvlWad) external {
        require(guid == lastGuid, "guid");
        ILzReadConsumer(consumer).onLzRead(guid, abi.encode(priceWad, tvlWad));
    }
}

/// @notice Minimal Uniswap v3 pool. `observe` is the cumulative tick. `slot0` is the spot, which the hook must ignore.
///         History starts at construction. A query older than that reverts, the same way a short cardinality does.
contract MockV3Pool {
    struct Point {
        uint32 t;
        int56 cum;
        int24 tick;
    }

    address public immutable token0;
    address public immutable token1;
    int24 public spotTick;
    Point[] internal points;

    error OldObservation();

    constructor(address token0_, address token1_, int24 tick_) {
        require(token0_ != address(0) && token1_ != address(0) && token0_ != token1_, "pair");
        token0 = token0_;
        token1 = token1_;
        spotTick = tick_;
        points.push(Point({t: uint32(block.timestamp), cum: 0, tick: tick_}));
    }

    /// @dev Spot price. The hook does not call this.
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick) {
        return (TickMath.getSqrtPriceAtTick(spotTick), spotTick);
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
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
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
