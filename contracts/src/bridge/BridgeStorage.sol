// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BridgeCurve} from "./libraries/BridgeCurve.sol";
import {BridgeV4Anchor} from "./libraries/BridgeV4Anchor.sol";

/// @title Disciple storage, errors, and events
/// @notice One storage root at slot 0 of `DiscipleHook`. The hook declares no storage of its own.
///         Libraries reach this layout through `delegatecall`, so the tokens and the state stay in
///         the hook. Nothing here is an admin slot, and no address in the layout is a swappable role.
library BridgeStorage {
    uint8 internal constant OP_SEED = 1;
    uint8 internal constant OP_DEPOSIT = 2;
    uint8 internal constant OP_REDEEM = 3;
    uint8 internal constant OP_CLAIM = 4;

    struct Pool {
        bool exists;
        bool coinIs0;
        bool graduated;
        uint8 coinDec;
        address coin;
        address creator;
        uint8 anchorKind;
        /// @dev v2 pair or v3 pool. Zero for a v4 anchor.
        address refPool;
        uint24 refFee;
        int24 refTickSpacing;
        address refHooks;
        bool refCoinIs0;
        bytes32 refPoolId;
        uint256 updatedAt;
        uint256 ethTvl;
        uint256 usdgHeld;
        uint256 creatorAccrued;
        uint256 totalShares;
        uint256 feeIndex;
        uint64 openBlock;
        uint256 openSpot;
        uint256 openLpX;
        uint256 openLpY;
        uint256 openShares;
        uint256 openTakenX;
        uint256 openTakenY;
        uint256 blockFee;
        uint256 redeemedEligible;
        /// @dev Remaining Dutch gap, wad, after the last fill. Time since `dutchAt` accrues both sides
        ///      up to `DUTCH_GAP_CAP`. A buy consumes `askGap` and clears `bidGap`. A sell does the opposite.
        uint256 bidGap;
        uint256 askGap;
        uint64 dutchAt;
        uint64 smoothAt;
        uint256 smoothedTvl;
        BridgeCurve.S curve;
        PoolKey key;
    }

    struct CreateParams {
        address coin;
        address creator;
        uint16 floorBps;
        uint16 discountBps;
        uint16 outflowCapBps;
        uint32 outflowWindow;
        uint8 anchorKind;
        /// @dev v2 pair or v3 pool. Zero for v4.
        address refPool;
        uint256 coinSeed;
        uint64 dutchDrift;
        bytes32 refPoolId;
        int24 tickSpacing;
        /// @dev v3 fee tier, or the v4 pool's fee.
        uint24 refFee;
        int24 refTickSpacing;
        address refHooks;
    }

    /// @dev Prior-block v2 cumulative checkpoint. Not a spot reserve reading.
    struct V2Sample {
        uint32 ts;
        uint256 price0Cum;
        uint256 price1Cum;
        bool init;
    }

    struct ArbQuote {
        bool buyCoin;
        uint256 amountIn;
        uint256 amountOut;
        uint256 profitWad;
    }

    struct BridgeQuote {
        uint256 anchorPriceWad;
        uint256 poolPriceWad;
        int256 priceGapBps;
        int256 imbalanceBps;
        uint256 suggestedFeeBps;
        bool stale;
        bool graduated;
    }

    /// @dev Slot 0 of the hook. The hook contract declares no state variables, so this is the whole layout.
    struct Layout {
        mapping(PoolId => Pool) pools;
        mapping(PoolId => mapping(address => uint256)) sharesOf;
        mapping(PoolId => mapping(address => uint256)) feeIndexOf;
        mapping(PoolId => mapping(address => uint256)) feeCreditOf;
        mapping(PoolId => mapping(address => uint256)) freshShares;
        mapping(PoolId => mapping(address => uint256)) freshCoin;
        mapping(PoolId => mapping(address => uint256)) freshUsdg;
        mapping(PoolId => mapping(address => uint64)) freshBlock;
        mapping(PoolId => mapping(uint64 => uint256)) indexAtBlock;
        mapping(bytes32 => BridgeV4Anchor.Ring) rings;
        mapping(bytes32 => mapping(uint16 => uint256)) obs;
        /// @dev First successful `witnessSource`. v2 and v4 have no onchain birthday, so create requires
        ///      this to be at least 7 days old. A caller can only start the clock, not skip it.
        mapping(bytes32 => uint64) seenAt;
        /// @dev Last v2 cumulative sample. One per block. The ring stores the tick of the completed interval.
        mapping(bytes32 => V2Sample) v2Sample;
        uint256 usdgClaimsNorm;
        bool locked;
    }

    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := 0
        }
    }

    error OnlyPoolManager();
    error Reentrancy();
    error ExternalInit();
    error LiquidityDisabled();
    error HookNotImplemented();
    error UnknownPool();
    error NoAnchor();
    error BadPrice();
    error ExceedsCap();
    error ZeroOutput();
    error ExactOutUnsupported();
    error BadCreate();
    error OnlyCreator();
    error Amount();
    error Dust();
    error Invariant();
    error Stale();

    event PoolCreated(
        PoolId indexed id,
        address indexed coin,
        address indexed creator,
        uint16 floorBps,
        uint16 discountBps,
        uint256 coinSeed,
        uint8 anchorKind
    );
    event Swapped(
        PoolId indexed id,
        address indexed sender,
        bool buy,
        uint256 coinAmount,
        uint256 usdgAmount,
        uint256 fee,
        uint256 spotAfter
    );
    event MintedLp(PoolId indexed id, address indexed to, uint256 shares, uint256 coin, uint256 usdg);
    event Deposited(PoolId indexed id, address indexed lp, uint256 shares, uint256 coin, uint256 usdg);
    event Redeemed(PoolId indexed id, address indexed lp, uint256 shares, uint256 coin, uint256 usdg, uint256 fee);
    event PriceUpdated(PoolId indexed id, uint256 anchor, uint256 ethTvl);
    event Graduated(PoolId indexed id, uint256 poolTvl, uint256 ethTvl);
    event Ungraduated(PoolId indexed id, uint256 poolTvl, uint256 target);
    event CreatorClaimed(PoolId indexed id, address indexed to, uint256 amount);
    event CreatorTransferred(PoolId indexed id, address indexed previous, address indexed next);
    event SourceWitnessed(bytes32 indexed key, uint64 seenAt);
}
