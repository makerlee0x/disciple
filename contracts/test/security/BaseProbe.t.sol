// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./BaseDiscovery.t.sol";
import {IQuoteProbe} from "../../src/interfaces/IQuoteProbe.sol";

/// @dev Buys work (PoolManager → anyone), sells/transfers to the PoolManager revert unless the sender is exempt.
contract HoneypotToken is MockUSDG {
    address public immutable pm;
    mapping(address => bool) public exempt;

    constructor(address pm_, address seeder) {
        pm = pm_;
        exempt[seeder] = true;
    }

    function _update(address from, address to, uint256 v) internal override {
        if (from != address(0) && to == pm && !exempt[from]) revert("honeypot: no sells");
        super._update(from, to, v);
    }
}

/// @dev 2% burned on every transfer unless the sender or receiver is exempt (the liquidity seeder).
contract FeeOnTransferToken is MockUSDG {
    mapping(address => bool) public exempt;

    constructor(address seeder) {
        exempt[seeder] = true;
    }

    function _update(address from, address to, uint256 v) internal override {
        if (from != address(0) && to != address(0) && !exempt[from] && !exempt[to]) {
            uint256 fee = v / 50;
            super._update(from, address(0), fee);
            v -= fee;
        }
        super._update(from, to, v);
    }
}

/// @notice (f) real QuoteProbe: buy → take → transfer-back round trip through the base/USDG v4 pool, always reverted.
contract BaseProbeTest is BaseTestBase {
    // ───────────── (f) probe ─────────────

    function test_probe_passes_honest_base_and_default() public {
        (IQuoteProbe.ProbeResult res,) = quoteProbe.probe(address(strategy));
        assertEq(uint8(res), uint8(IQuoteProbe.ProbeResult.Pass));
        (res,) = quoteProbe.probe(address(quote));
        assertEq(uint8(res), uint8(IQuoteProbe.ProbeResult.Pass), "usdg");
        _launchWithQuote(address(0), 0, 0); // default base (strategy) is probed and passes
    }

    function test_probe_rejects_honeypot() public {
        HoneypotToken h = new HoneypotToken(address(manager), address(this));
        _std(address(h), 3000, 60, 1e23);
        (IQuoteProbe.ProbeResult res, string memory why) = quoteProbe.probe(address(h));
        assertEq(uint8(res), uint8(IQuoteProbe.ProbeResult.RejectHoneypot), why);
        vm.expectRevert(abi.encodeWithSelector(Launchpad.QuoteRejected.selector, "honeypot"));
        _launchBase(address(h));
    }

    function test_probe_rejects_fee_on_transfer() public {
        FeeOnTransferToken f = new FeeOnTransferToken(address(this));
        _std(address(f), 3000, 60, 1e23);
        (IQuoteProbe.ProbeResult res,) = quoteProbe.probe(address(f));
        assertEq(uint8(res), uint8(IQuoteProbe.ProbeResult.RejectFeeOnTransfer));
        vm.expectRevert(abi.encodeWithSelector(Launchpad.QuoteRejected.selector, "fee on transfer"));
        _launchBase(address(f));
    }

    function test_probe_applies_to_default_base() public {
        HoneypotToken h = new HoneypotToken(address(manager), address(this));
        _std(address(h), 3000, 60, 1e23);
        vm.prank(owner);
        launchpad.setDefaultQuote(address(h));
        vm.expectRevert(abi.encodeWithSelector(Launchpad.QuoteRejected.selector, "honeypot"));
        _launchBase(address(0));
    }

    function test_probe_changes_no_state() public {
        PoolKey memory k = strategyUsdgKey;
        (uint160 sp0,,,) = StateLibrary.getSlot0(manager, PoolIdLibrary.toId(k));
        uint256 pmBal = strategy.balanceOf(address(manager));
        quoteProbe.probe(address(strategy));
        (uint160 sp1,,,) = StateLibrary.getSlot0(manager, PoolIdLibrary.toId(k));
        assertEq(sp1, sp0);
        assertEq(strategy.balanceOf(address(manager)), pmBal);
        assertEq(strategy.balanceOf(address(quoteProbe)), 0);
    }

    function test_probe_gas() public {
        uint256 g = gasleft();
        quoteProbe.probe(address(strategy));
        emit log_named_uint("probe gas (honest base)", g - gasleft());
    }

    function test_launch_gas_with_and_without_probe() public {
        uint256 snap = vm.snapshotState();
        uint256 g = gasleft();
        _launchWithQuote(address(0), 0, 0);
        uint256 withProbe = g - gasleft();
        vm.revertToState(snap);
        vm.prank(owner);
        launchpad.setQuoteProbe(address(0));
        g = gasleft();
        _launchWithQuote(address(0), 0, 0);
        uint256 noProbe = g - gasleft();
        emit log_named_uint("launch gas (default base, probe)", withProbe);
        emit log_named_uint("launch gas (default base, no probe)", noProbe);
        g = gasleft();
        _launchWithQuote(address(quote), 0, 0);
        emit log_named_uint("launch gas (USDG base, no probe)", g - gasleft());
    }
}

/// @notice 6-decimal USDG run of BaseProbeTest (mainnet USDG / next testnet mock); same tests, `U` = 1e6.
contract BaseProbe6DecTest is BaseProbeTest {
    function _usdgDecimals() internal pure override returns (uint8) {
        return 6;
    }
}
