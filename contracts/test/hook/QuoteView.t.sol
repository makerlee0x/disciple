// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {DiscipleTest} from "./Disciple.t.sol";

/// @notice The read-only quote (quoteView) equals the revert-style quote and what the swap pays and receives, in
///         every state a router meets: first touch of a block (anchor step + settle with a jar skim), same block,
///         exact in and out, after a source move, cross chain, and cross chain entering local mode.
contract QuoteViewTest is DiscipleTest {
    function _z(PoolKey memory key, bool buy) internal view returns (bool) {
        bool coinIs0 = Currency.unwrap(key.currency0) == address(coin);
        return buy ? !coinIs0 : coinIs0;
    }

    function _three(PoolKey memory key, PoolId id, bool buy, int256 amt) internal {
        bool z = _z(key, buy);
        (uint256 vi, uint256 vo) = hook.quoteView(id, z, amt);
        (uint256 qi, uint256 qo) = _quote(id, z, amt);
        assertEq(vi, qi, "view in = quote in");
        assertEq(vo, qo, "view out = quote out");
        MockERC20 inT = buy ? usd : coin;
        MockERC20 outT = buy ? coin : usd;
        uint256 i0 = inT.balanceOf(address(this));
        uint256 o0 = outT.balanceOf(address(this));
        _swap(key, buy, amt);
        assertEq(i0 - inT.balanceOf(address(this)), vi, "view in = paid");
        assertEq(outT.balanceOf(address(this)) - o0, vo, "view out = received");
    }

    function _jar(PoolId id) internal view returns (uint256) {
        DiscipleHook.PoolView memory v = hook.poolState(id);
        return v.jarX + v.jarY;
    }

    function test_quoteView_sameChainEveryState() public {
        vm.fee(0.01 gwei);
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        _nextBlock();
        _three(key, id, true, -20e18); // first touch, nothing to settle yet
        _three(key, id, false, -5e18); // same block
        _three(key, id, true, 3e18); // exact out
        _three(key, id, false, 2e18); // exact out sell
        // round trips leave earnings in the open interval; the next block's first touch settles and skims them
        uint256 c0 = coin.balanceOf(address(this));
        _three(key, id, true, -100e18);
        _three(key, id, false, -int256(coin.balanceOf(address(this)) - c0));
        _nextBlock();
        uint256 j0 = _jar(id);
        _three(key, id, true, -50e18);
        assertGt(_jar(id), j0, "this first touch skimmed into the jar (the view had to include it)");
        _three(key, id, false, -10e18);
        // a source move, sampled, then a first touch that steps the anchor
        pair.set(1_000_000e18, 2_060_000e18);
        _nextBlock();
        hook.sample(id);
        _nextBlock();
        _three(key, id, true, -50e18);
        // a sample, then a swap in the SAME block: no second step, but the settle is still due
        _three(key, id, false, -int256(coin.balanceOf(address(this)) - c0));
        pair.set(1_000_000e18, 2_090_000e18);
        _nextBlock();
        hook.sample(id);
        uint256 j1 = _jar(id);
        _three(key, id, true, -20e18);
        emit log_named_uint("jar grew on sample-then-swap (0 = no skim due)", _jar(id) - j1);
        // many blocks of one-way flow, each first touch checked both ways
        for (uint256 i; i < 6; i++) {
            _nextBlock();
            pair.set(1_000_000e18, uint112(2_060_000e18 + i * 15_000e18));
            _three(key, id, i % 2 == 0, i % 2 == 0 ? -int256(30e18) : int256(4e18));
        }
        uint256 a = hook.poolState(id).anchorX128;
        hook.quoteView(id, true, -1e18);
        assertEq(hook.poolState(id).anchorX128, a, "a view changes nothing");
    }

    function testFuzz_quoteView_matchesSwap(uint256 seed) public {
        vm.fee(0.01 gwei);
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        for (uint256 i; i < 5; i++) {
            seed = uint256(keccak256(abi.encode(seed)));
            if (seed & 1 == 0) _nextBlock();
            if ((seed >> 1) & 3 == 0) pair.set(1_000_000e18, uint112(1_900_000e18 + (seed >> 8) % 200_000e18));
            if ((seed >> 6) & 3 == 0) hook.sample(id);
            bool buy = (seed >> 3) & 1 == 0;
            bool exactIn = (seed >> 4) & 1 == 0;
            uint256 amt = 1e17 + (seed >> 16) % (exactIn ? 200e18 : 60e18);
            _three(key, id, buy, exactIn ? -int256(amt) : int256(amt));
        }
    }

    function test_quoteView_crossChainAndLocalMode() public {
        (PoolKey memory key, PoolId id) = _createPush(HOME_EID, 0.05 ether);
        _lzPush(id, address(0xC0FFEE), 40, HOME_EID);
        _nextBlock();
        _three(key, id, true, -5e18);
        _three(key, id, false, 2e18);
        // the feed goes quiet: the next swap enters local mode and re-centres, which the view must foresee
        vm.warp(block.timestamp + 2 hours + 1);
        assertFalse(hook.poolState(id).local);
        _three(key, id, false, -3e18);
        assertTrue(hook.poolState(id).local);
        _three(key, id, true, -3e18);
    }

    function test_quoteView_rejectsWhatSwapRejects() public {
        (, PoolId id) = _createSame(1000e18, 2000e18);
        vm.expectRevert(DiscipleHook.BadParams.selector);
        hook.quoteView(id, true, 0);
        vm.expectRevert(DiscipleHook.BadParams.selector);
        hook.quoteView(id, true, type(int256).min);
    }

    // ---- graduated pools: the first-touch settle pays LPs / the creator out of the reserves (audit v0.2 M-1) ----

    /// @dev A pool at ~15% of a small source, warmed up and graduated.
    function _graduated(bool compounds) internal returns (PoolKey memory key, PoolId id) {
        vm.fee(0.01 gwei);
        pair.set(1000e18, 2000e18); // source TVL 4000 quote
        (key, id) = _createSame(150e18, 300e18); // ~600 quote = 15%
        hook.setCreator(id, address(this), compounds);
        for (uint256 i; i < 40 && !hook.poolState(id).graduated; i++) {
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + 1 hours);
            uint256 c0 = coin.balanceOf(address(this));
            _swap(key, true, -int256(5e18));
            _swap(key, false, -int256(coin.balanceOf(address(this)) - c0));
        }
        assertTrue(hook.poolState(id).graduated, "graduated");
    }

    function _gradCase(bool compounds) internal {
        (PoolKey memory key, PoolId id) = _graduated(compounds);
        // load the interval one way, then the next block's first touch settles it (skim + payout)
        _nextBlock();
        _three(key, id, true, -60e18);
        _nextBlock();
        _three(key, id, true, -50e18);
        _three(key, id, false, 3e18);
        _nextBlock();
        _three(key, id, true, 20e18); // exact out after a buy-loaded interval
        _nextBlock();
        _three(key, id, false, -int256(10e18));
        _nextBlock();
        _three(key, id, false, -int256(10e18)); // sell after a sell-loaded interval
        emit log_named_uint("creator cut on (1/0)", hook.poolState(id).creatorOn ? 1 : 0);
    }

    function test_quoteView_graduatedCreatorPaid() public {
        _gradCase(false);
    }

    function test_quoteView_graduatedCreatorCompounds() public {
        _gradCase(true);
    }

    function test_quoteView_unknownPool() public {
        vm.expectRevert(DiscipleHook.UnknownPool.selector);
        hook.quoteView(PoolId.wrap(bytes32(uint256(1))), true, -1e18);
    }
}
