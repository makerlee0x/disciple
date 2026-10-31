// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {ILayerZeroEndpointV2, ILayerZeroReceiver} from "../../src/bridge/interfaces/ILayerZeroEndpointV2.sol";
import {ILzRead} from "../../src/bridge/interfaces/ILzRead.sol";
import {DiscipleLzRead} from "../../src/bridge/DiscipleLzRead.sol";
import {AnchorLens} from "../../src/bridge/AnchorLens.sol";
import {LzReadCmd} from "../../src/bridge/libraries/LzReadCmd.sol";
import {DiscipleEngine} from "../../src/bridge/DiscipleEngine.sol";
import {DiscipleAdminFacet} from "../../src/bridge/DiscipleAdminFacet.sol";
import {DiscipleLpFacet} from "../../src/bridge/DiscipleLpFacet.sol";
import {DiscipleCreateFacet} from "../../src/bridge/DiscipleCreateFacet.sol";
import {DiscipleSwapFacet} from "../../src/bridge/DiscipleSwapFacet.sol";
import {DiscipleHook} from "../../src/bridge/DiscipleHook.sol";
import {BridgeStorage} from "../../src/bridge/BridgeStorage.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";
import {BridgeFixture} from "./BridgeFixture.sol";
import {MockERC20, MockV3Factory, MockV3Pool, MockV4Oracle} from "./mocks/BridgeMocks.sol";

/// @notice Endpoint stand-in. It records the send and delivers only when the test asks it to.
contract MockEndpoint is ILayerZeroEndpointV2 {
    uint256 public fee = 0.001 ether;
    uint256 public n;
    address public delegate;
    uint32 public lastDst;
    bytes32 public lastReceiver;
    bytes public lastMessage;
    bytes public lastOptions;
    address public lastRefund;
    bytes32 public lastGuid;

    function setDelegate(address delegate_) external {
        delegate = delegate_;
    }

    function quote(MessagingParams calldata, address) external view returns (MessagingFee memory) {
        return MessagingFee({nativeFee: fee, lzTokenFee: 0});
    }

    function send(MessagingParams calldata params, address refundAddress)
        external
        payable
        returns (MessagingReceipt memory)
    {
        require(msg.value >= fee, "fee");
        n += 1;
        lastDst = params.dstEid;
        lastReceiver = params.receiver;
        lastMessage = params.message;
        lastOptions = params.options;
        lastRefund = refundAddress;
        lastGuid = bytes32(n);
        return MessagingReceipt({guid: lastGuid, nonce: uint64(n), fee: MessagingFee({nativeFee: fee, lzTokenFee: 0})});
    }

    /// @dev Deliver as the endpoint, from the adapter's own peer, on the adapter's read channel.
    function deliver(address adapter, bytes32 guid, bytes calldata message) external {
        uint32 channel = DiscipleLzRead(adapter).readChannel();
        ILayerZeroReceiver(adapter)
            .lzReceive(
                Origin({srcEid: channel, sender: bytes32(uint256(uint160(adapter))), nonce: 1}),
                guid,
                message,
                address(this),
                ""
            );
    }

    receive() external payable {}
}

/// @notice Hook-level safety: stale swaps, ordering, the move bound, and one tip per refresh.
contract DiscipleReadSafetyTest is BridgeFixture {
    function setUp() public {
        _deployStack(18);
        coin = _newCoin("JESUS", 18);
        (key, id) = _create(coin, 77e18, 5e18, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
        _price(id, 1e18, 725_000e18);
    }

    function test_staleSwapRevertsAndQuoteStillWorks() public {
        vm.warp(block.timestamp + 31 minutes);
        assertTrue(hook.bridgeQuote(id).stale);
        (, uint256 fee,,) = hook.quoteExactIn(key, _buyZfo(), 1e18);
        assertGt(fee, 0, "a quote still returns while the swap is closed");

        usdg.mint(address(this), 1e18);
        usdg.approve(address(swapper), type(uint256).max);
        bool zfo = _buyZfo();
        bytes memory data = abi.encodeCall(
            PoolSwapTest.swap,
            (
                key,
                IPoolManager.SwapParams({
                    zeroForOne: zfo,
                    amountSpecified: -int256(1e18),
                    sqrtPriceLimitX96: zfo ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                bytes("")
            )
        );
        (bool ok, bytes memory err) = address(swapper).call(data);
        assertFalse(ok);
        assertTrue(_contains(err, BridgeStorage.Stale.selector), "swap revert is Stale");

        _price(id, hook.curve(id).anchor, hook.referenceTvl(id));
        assertFalse(hook.bridgeQuote(id).stale);
        _buy(key, address(coin), 1e18);
        assertGt(hook.spotPrice(id), 0.67e18);
    }

    function test_outOfOrderResultDoesNotOverwrite() public {
        vm.warp(block.timestamp + 31 minutes);
        address a = address(0xA11);
        address b = address(0xB22);
        vm.deal(a, 1 ether);
        vm.deal(b, 1 ether);
        uint256 fee = lz.fee();
        vm.prank(a);
        hook.updatePrice{value: fee}(id);
        bytes32 older = lz.lastGuid();
        vm.prank(b);
        hook.updatePrice{value: fee}(id);
        bytes32 newer = lz.lastGuid();

        uint256 bb = usdg.balanceOf(b);
        lz.deliver(newer, abi.encode(uint256(1.05e18), uint256(725_000e18)));
        assertEq(hook.curve(id).anchor, 1.05e18);
        assertEq(usdg.balanceOf(b), bb + 1e18, "the first accepted refresh pays the tip");

        vm.expectRevert(BridgeStorage.OutOfOrder.selector);
        lz.deliver(older, abi.encode(uint256(1.01e18), uint256(725_000e18)));
        assertEq(hook.curve(id).anchor, 1.05e18, "an older nonce leaves the newer price");
        assertEq(usdg.balanceOf(a), 0);
    }

    function test_oversizedJumpRevertsAndExactBoundApplies() public {
        vm.warp(block.timestamp + 31 minutes);
        vm.deal(address(this), 1 ether);
        uint256 fee = lz.fee();
        hook.updatePrice{value: fee}(id);
        bytes32 guid = lz.lastGuid();

        vm.expectRevert(BridgeStorage.BadPrice.selector);
        lz.deliver(guid, abi.encode(uint256(0), uint256(725_000e18)));
        assertEq(hook.curve(id).anchor, 1e18);

        vm.expectRevert(BridgeStorage.AnchorMove.selector);
        lz.deliver(guid, abi.encode(uint256(1.3e18), uint256(725_000e18)));
        assertEq(hook.curve(id).anchor, 1e18, "a rejected jump rolls the anchor back");

        // 20% of 1e18 is the largest move the bound allows. One wei past it reverts above.
        lz.deliver(guid, abi.encode(uint256(1.2e18), uint256(725_000e18)));
        assertEq(hook.curve(id).anchor, 1.2e18);

        vm.warp(block.timestamp + 31 minutes);
        hook.updatePrice{value: fee}(id);
        bytes32 later = lz.lastGuid();
        uint256 tooFar = 1.2e18 + ((1.2e18 * C.ANCHOR_MOVE_BPS) / C.BPS) + 1;
        vm.expectRevert(BridgeStorage.AnchorMove.selector);
        lz.deliver(later, abi.encode(tooFar, uint256(725_000e18)));
        assertEq(hook.curve(id).anchor, 1.2e18);
    }

    function test_oneTipForTwoInFlightReads() public {
        vm.warp(block.timestamp + 31 minutes);
        address a = address(0xA11);
        address b = address(0xB22);
        vm.deal(a, 1 ether);
        vm.deal(b, 1 ether);
        uint256 fee = lz.fee();
        vm.prank(a);
        hook.updatePrice{value: fee}(id);
        bytes32 ga = lz.lastGuid();
        vm.prank(b);
        hook.updatePrice{value: fee}(id);
        bytes32 gb = lz.lastGuid();

        uint256 ba = usdg.balanceOf(a);
        uint256 bb = usdg.balanceOf(b);
        lz.deliver(ga, abi.encode(uint256(1e18), uint256(725_000e18)));
        lz.deliver(gb, abi.encode(uint256(1.01e18), uint256(725_000e18)));
        assertEq(usdg.balanceOf(a), ba + 1e18);
        assertEq(usdg.balanceOf(b), bb, "the second result lands after the quote is fresh");
        assertEq(hook.curve(id).anchor, 1.01e18);

        vm.expectRevert(BridgeStorage.Fresh.selector);
        hook.updatePrice{value: fee}(id);
    }

    function test_coldSlotSamplePaysNoTip() public {
        MockERC20 s = _newCoin("SLOT", 18);
        s.mint(address(this), 10e18);
        s.approve(address(hook), type(uint256).max);
        usdg.mint(address(this), 2e18);
        usdg.approve(address(hook), type(uint256).max);
        bytes32 refId = bytes32(uint256(9));
        hook.setLensAllowed(address(0x51), true);
        hook.setOracleAllowed(address(0x51), true);
        (, PoolId slotId) = hook.createPool(
            BridgeStorage.CreateParams({
                coin: address(s),
                creator: address(this),
                floorBps: C.FLOOR_BPS,
                discountBps: C.DISCOUNT_BPS,
                outflowCapBps: 0,
                outflowWindow: 0,
                remoteEid: 30101,
                remoteOracle: address(0x51),
                anchorKind: C.ANCHOR_LZ_V4_SLOT,
                v3Pool: address(0),
                coinSeed: 10e18,
                tipSeed: 2e18,
                dutchDrift: 0,
                refPoolId: refId,
                refHook: address(0x51),
                refCoinIs0: address(s) < address(usdg),
                tickSpacing: 0,
                v3Fee: 0,
                refFee: 0,
                refTickSpacing: 0,
                refHooks: address(0)
            })
        );
        uint256 before = usdg.balanceOf(address(this));
        vm.deal(address(this), 1 ether);
        hook.updatePrice{value: lz.fee()}(slotId);
        lz.fulfillBytes(lz.lastGuid(), abi.encode(TickMath.getSqrtPriceAtTick(0), int24(0), uint128(1e18)));
        assertEq(hook.curve(slotId).anchor, 0);
        assertEq(usdg.balanceOf(address(this)), before, "a sample that is not yet a price pays nothing");
    }

    function _buyZfo() internal view returns (bool) {
        return Currency.unwrap(key.currency0) != address(coin);
    }

    function _contains(bytes memory hay, bytes4 needle) internal pure returns (bool) {
        if (hay.length < 4) return false;
        for (uint256 i; i + 3 < hay.length; ++i) {
            if (hay[i] == needle[0] && hay[i + 1] == needle[1] && hay[i + 2] == needle[2] && hay[i + 3] == needle[3]) {
                return true;
            }
        }
        return false;
    }
}

/// @notice The adapter accepts a result only from the endpoint, on the configured read channel.
contract DiscipleLzAdapterTest is BridgeFixture {
    MockEndpoint internal endpoint;
    DiscipleLzRead internal adapter;

    function setUp() public {
        endpoint = new MockEndpoint();
        adapter = new DiscipleLzRead(address(endpoint), type(uint32).max, 15, address(this));
        usdg = new MockERC20("USDG", "USDG", 18);
        manager = IPoolManager(address(new PoolManager(address(this))));
        engine = new DiscipleEngine();
        v3Factory = new MockV3Factory();
        adminFacet = new DiscipleAdminFacet(manager, address(usdg), address(adapter), 18, engine, address(v3Factory));
        lpFacet = new DiscipleLpFacet(manager, address(usdg), address(adapter), 18, engine, address(v3Factory));
        createFacet = new DiscipleCreateFacet(manager, address(usdg), address(adapter), 18, engine, address(v3Factory));
        swapFacet = new DiscipleSwapFacet(manager, address(usdg), address(adapter), 18, engine, address(v3Factory));
        bytes memory args = abi.encode(
            manager,
            address(usdg),
            address(adapter),
            uint8(18),
            address(engine),
            address(swapFacet),
            address(lpFacet),
            address(createFacet),
            address(adminFacet),
            address(this),
            address(v3Factory)
        );
        (address predicted, bytes32 salt) = _mineHook(args);
        hook = new DiscipleHook{salt: salt}(
            manager,
            address(usdg),
            address(adapter),
            18,
            engine,
            address(swapFacet),
            address(lpFacet),
            address(createFacet),
            address(adminFacet),
            address(this),
            address(v3Factory)
        );
        hook.setLensAllowed(address(0xE7E7), true);
        hook.setLensAllowed(address(0x51), true);
        hook.setOracleAllowed(address(0x51), true);
        require(address(hook) == predicted, "hook addr");
        adapter.setHook(address(hook));
        swapper = new PoolSwapTest(manager);
        coin = _newCoin("JESUS", 18);
        (key, id) = _create(coin, 77e18, 1e18, C.FLOOR_BPS, C.DISCOUNT_BPS, 0, 0);
    }

    function test_endpointDeliverySetsTheAnchor() public {
        vm.deal(address(this), 1 ether);
        uint256 before = usdg.balanceOf(address(this));
        hook.updatePrice{value: endpoint.fee()}(id);

        assertEq(endpoint.lastDst(), type(uint32).max, "the message destination is the read channel");
        assertEq(endpoint.lastReceiver(), bytes32(uint256(uint160(address(adapter)))));
        assertEq(endpoint.lastRefund(), address(this));
        assertEq(endpoint.delegate(), address(this));
        assertEq(adapter.quoteRead(_sampleRead(1)), endpoint.fee());

        bytes memory callData = abi.encodeWithSelector(
            AnchorLens.readV3.selector, address(0xB333), address(coin), address(usdg), uint8(18), uint8(18)
        );
        bytes memory expect = abi.encodePacked(
            uint16(1),
            uint16(1),
            uint16(1),
            uint8(1),
            uint16(1),
            uint16(1),
            uint16(callData.length + 35),
            uint32(30101),
            uint8(0),
            uint64(block.timestamp),
            uint16(15),
            address(0xE7E7),
            callData
        );
        assertEq(endpoint.lastMessage(), expect);
        assertEq(LzReadCmd.encode(30101, address(0xE7E7), callData, 15, uint64(block.timestamp)), expect);
        assertEq(
            endpoint.lastOptions(),
            abi.encodePacked(uint16(3), uint8(1), uint16(21), uint8(5), uint128(800_000), uint32(256))
        );
        assertEq(endpoint.lastOptions(), LzReadCmd.lzReadOptions(800_000, 256));

        endpoint.deliver(address(adapter), endpoint.lastGuid(), abi.encode(uint256(1e18), uint256(725_000e18)));
        assertEq(hook.spotPrice(id), 0.67e18);
        assertEq(usdg.balanceOf(address(this)), before + 1e18);
        assertFalse(hook.bridgeQuote(id).stale);
    }

    function test_onlyTheEndpointOnTheReadChannelCanDeliver() public {
        ILayerZeroEndpointV2.Origin memory origin = ILayerZeroEndpointV2.Origin({
            srcEid: type(uint32).max, sender: bytes32(uint256(uint160(address(adapter)))), nonce: 1
        });
        vm.expectRevert(DiscipleLzRead.OnlyEndpoint.selector);
        vm.prank(address(0xB0B));
        adapter.lzReceive(origin, bytes32(uint256(1)), "", address(0), "");

        origin.srcEid = 1;
        vm.expectRevert(DiscipleLzRead.BadChannel.selector);
        vm.prank(address(endpoint));
        adapter.lzReceive(origin, bytes32(uint256(1)), "", address(0), "");

        origin.srcEid = type(uint32).max;
        origin.sender = bytes32(uint256(1));
        vm.expectRevert(DiscipleLzRead.BadPeer.selector);
        vm.prank(address(endpoint));
        adapter.lzReceive(origin, bytes32(uint256(1)), "", address(0), "");

        vm.expectRevert(BridgeStorage.OnlyLz.selector);
        vm.prank(address(endpoint));
        hook.onLzRead(bytes32(uint256(1)), abi.encode(uint256(1e18), uint256(1)));

        uint256 nativeFee = endpoint.fee();
        vm.expectRevert(DiscipleLzRead.OnlyHook.selector);
        adapter.sendRead{value: nativeFee}(_sampleRead(1), address(this));

        vm.expectRevert(DiscipleLzRead.BadConfig.selector);
        adapter.setHook(address(0x1234));
        vm.expectRevert(DiscipleLzRead.OnlyOwner.selector);
        vm.prank(address(0xB0B));
        adapter.setHook(address(0x1234));

        assertTrue(
            adapter.allowInitializePath(
                ILayerZeroEndpointV2.Origin({
                    srcEid: type(uint32).max, sender: bytes32(uint256(uint160(address(adapter)))), nonce: 0
                })
            )
        );
        assertFalse(
            adapter.allowInitializePath(
                ILayerZeroEndpointV2.Origin({srcEid: 1, sender: bytes32(uint256(uint160(address(adapter)))), nonce: 0})
            )
        );
        assertEq(adapter.nextNonce(type(uint32).max, bytes32(0)), 0);
    }

    function test_requestCanRaiseTheConfirmationFloor() public {
        vm.deal(address(this), 1 ether);
        vm.deal(address(hook), 1 ether);
        uint256 nativeFee = endpoint.fee();
        ILzRead.EvmRead memory floorRead = _sampleRead(1);
        ILzRead.EvmRead memory raised = _sampleRead(20);
        ILzRead.EvmRead memory truncated = _sampleRead(uint64(type(uint16).max) + 1);
        vm.prank(address(hook));
        adapter.sendRead{value: nativeFee}(floorRead, address(this));
        assertEq(_confirmations(endpoint.lastMessage()), 15);

        vm.prank(address(hook));
        adapter.sendRead{value: nativeFee}(raised, address(this));
        assertEq(_confirmations(endpoint.lastMessage()), 20);

        vm.prank(address(hook));
        adapter.sendRead{value: nativeFee}(truncated, address(this));
        assertEq(_confirmations(endpoint.lastMessage()), 15);
    }

    function _sampleRead(uint64 conf) internal pure returns (ILzRead.EvmRead memory) {
        return ILzRead.EvmRead({
            targetEid: 30101,
            target: address(0xE7E7),
            callData: abi.encodeWithSelector(
                AnchorLens.readV3.selector, address(1), address(2), address(3), uint8(18), uint8(18)
            ),
            minConfirmations: conf
        });
    }

    function _confirmations(bytes memory cmd) internal pure returns (uint16) {
        // Header through the size field is 13 bytes, then eid (4), flag (1), timestamp (8), confirmations (2).
        return uint16(uint8(cmd[26])) << 8 | uint16(uint8(cmd[27]));
    }
}

/// @notice The lens is the view the read command staticcalls. It does not store a price.
contract AnchorLensTest is Test {
    function test_readV3OracleAndSlot() public {
        AnchorLens lens = new AnchorLens();
        MockERC20 coin = new MockERC20("COIN", "COIN", 18);
        MockERC20 quote = new MockERC20("USDG", "USDG", 18);
        address t0 = address(coin) < address(quote) ? address(coin) : address(quote);
        address t1 = address(coin) < address(quote) ? address(quote) : address(coin);

        MockV3Pool young = new MockV3Pool(t0, t1, 0);
        vm.expectRevert();
        lens.readV3(address(young), address(coin), address(quote), 18, 18);

        coin.mint(address(young), 10e18);
        quote.mint(address(young), 10e18);
        skip(30 minutes);
        (uint256 price, uint256 tvl) = lens.readV3(address(young), address(coin), address(quote), 18, 18);
        assertEq(price, 1e18);
        assertEq(tvl, 20e18);

        MockV4Oracle oracle = new MockV4Oracle();
        (uint256 op, uint256 ot) = lens.readV4Oracle(address(oracle), bytes32(uint256(1)));
        assertEq(op, 1e18);
        assertEq(ot, 1_000_000e18);

        IPoolManager pm = IPoolManager(address(new PoolManager(address(this))));
        (uint160 sqrtP, int24 tick, uint128 liq) = lens.readV4Slot(address(pm), bytes32(uint256(1)));
        assertEq(sqrtP, 0);
        assertEq(tick, 0);
        assertEq(liq, 0);
    }
}
