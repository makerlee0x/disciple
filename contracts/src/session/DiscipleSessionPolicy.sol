// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IModule, IValidationHookModule, IExecutionHookModule, PackedUserOperation} from "./IERC6900.sol";

interface ICurveOf {
    function curveOf(address token) external view returns (address);
}

interface IQuoteSources {
    // DiscipleRouter: simulate-and-revert quote (non-view, safe: no state change survives)
    function quoteExactIn(address token, bool isBuy, uint256 amountIn)
        external
        returns (uint256 amountOut, uint256 impactBps, uint256 mcapAfterUsd);
}

interface ITokenOf {
    function token() external view returns (address);
}

/// @title DiscipleSessionPolicy
/// @notice ERC-6900 hook module for Alchemy Modular Account v2 that locks a session key down to DISCIPLE trading.
///         Installed next to Alchemy's SingleSignerValidation (non-global, only `execute`/`executeBatch`) as
///           1. a VALIDATION hook (entity `E`): ERC-7562-safe static checks: session active, not expired
///              (validUntil returned in validationData), target is a DISCIPLE contract (or a candidate bonding
///              curve), selector permitted, no ETH value;
///           2. an EXECUTION hook (entity `E | 2^31`): full checks: bonding curve registered on the Launchpad,
///              argument pinning (recipient == account, approve spender == DISCIPLE contract) and the per-session
///              quote spend cap.
///         Revocation: owner `uninstallValidation` (clears storage via onUninstall) or account-called `revoke`.
/// @dev Storage is keyed `[entityId][account]` (account innermost) so validation-phase reads are account-associated.
contract DiscipleSessionPolicy is IValidationHookModule, IExecutionHookModule {
    // ───────────────────────── permissions (bitmask) ─────────────────────────
    uint256 public constant P_ROUTER_BUY = 1 << 0; // DiscipleRouter.buyExactIn
    uint256 public constant P_ROUTER_SELL = 1 << 1; // DiscipleRouter.sellExactIn
    uint256 public constant P_CURVE_BUY = 1 << 2; // BondingCurve.buy (3- and 4-arg)
    uint256 public constant P_CURVE_SELL = 1 << 3; // BondingCurve.sell (3- and 4-arg)
    uint256 public constant P_TRAMP = 1 << 4; // TrampWallManager.placeTramp
    uint256 public constant P_WALL = 1 << 5; // TrampWallManager.placeWall
    uint256 public constant P_CANCEL = 1 << 6; // TrampWallManager.cancel
    uint256 public constant P_LAUNCH = 1 << 7; // Launchpad.launch / launchCoin
    uint256 public constant P_ANON_LAUNCH = 1 << 8; // AnonLauncher.launchAnon
    uint256 public constant P_APPROVE = 1 << 9; // ERC20.approve(spender ∈ DISCIPLE contracts | registered curve)

    uint32 public constant EXEC_HOOK_FLAG = 1 << 31;
    uint16 public constant DEFAULT_MAX_SLIPPAGE_BPS = 500; // 5%
    uint16 public constant MAX_SLIPPAGE_BPS_LIMIT = 5000; // 50%
    uint256 internal constant BPS = 10_000;

    // selectors
    bytes4 internal constant EXECUTE = bytes4(keccak256("execute(address,uint256,bytes)"));
    bytes4 internal constant EXECUTE_BATCH = bytes4(keccak256("executeBatch((address,uint256,bytes)[])"));
    bytes4 internal constant EXECUTE_USER_OP = 0x8dd7712f; // IAccountExecute.executeUserOp
    bytes4 internal constant ROUTER_BUY = bytes4(keccak256("buyExactIn(address,uint256,uint256,address,uint256)"));
    bytes4 internal constant ROUTER_SELL = bytes4(keccak256("sellExactIn(address,uint256,uint256,address,uint256)"));
    bytes4 internal constant CURVE_BUY3 = bytes4(keccak256("buy(uint256,uint256,uint256)"));
    bytes4 internal constant CURVE_BUY4 = bytes4(keccak256("buy(uint256,uint256,uint256,address)"));
    bytes4 internal constant CURVE_SELL3 = bytes4(keccak256("sell(uint256,uint256,uint256)"));
    bytes4 internal constant CURVE_SELL4 = bytes4(keccak256("sell(uint256,uint256,uint256,address)"));
    bytes4 internal constant TRAMP = bytes4(keccak256("placeTramp(address,int24,int24,uint256,uint128,uint256)"));
    bytes4 internal constant WALL = bytes4(keccak256("placeWall(address,int24,int24,uint256,uint128,uint256)"));
    bytes4 internal constant CANCEL = bytes4(keccak256("cancel(uint256)"));
    bytes4 internal constant LAUNCH =
        bytes4(keccak256("launch((string,string,string,string,string,address,uint256,uint256,uint256,uint256))"));
    bytes4 internal constant LAUNCH_COIN =
        bytes4(keccak256("launchCoin((string,string,string,string,string,address,uint256,uint256,uint256,uint256))"));
    bytes4 internal constant ANON_LAUNCH = bytes4(
        keccak256(
            "launchAnon((string,string,string,string,string,address,uint256,uint256,uint256,uint256),address,address,bytes,bytes1)"
        )
    );
    bytes4 internal constant APPROVE = bytes4(keccak256("approve(address,uint256)"));

    /// @notice Install-time session configuration (abi-encoded after the uint32 entityId in onInstall data).
    struct SessionConfig {
        uint48 validUntil; // unix seconds; 0 is rejected
        uint48 validAfter; // unix seconds; 0 = immediately
        uint256 permissions; // P_* bitmask
        address router;
        address launchpad; // also the bonding-curve registry (curveOf)
        address anonLauncher;
        address trampWallManager;
        address quote0; // capped quote assets (e.g. USDG, STRATEGY); address(0) = unused
        address quote1;
        uint128 cap0; // max total approve() of quote0 during the session (raw units)
        uint128 cap1;
        uint16 maxSlippageBps; // buys/sells: minOut >= onchainQuote * (1 - bps); 0 = DEFAULT_MAX_SLIPPAGE_BPS
    }

    struct Session {
        SessionConfig cfg;
        uint128 spent0;
        uint128 spent1;
        bool active;
    }

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// @dev entityId (validation entity, high bit cleared) => account => session
    mapping(uint32 => mapping(address => Session)) internal _sessions;

    event SessionInstalled(address indexed account, uint32 indexed entityId, SessionConfig cfg);
    event SessionRevoked(address indexed account, uint32 indexed entityId);
    event SessionSpend(address indexed account, uint32 indexed entityId, address quote, uint256 amount, uint256 spent);

    error InvalidConfig();
    error SessionInactive();
    error SessionExpired();
    error NotAllowed(address target, bytes4 selector);
    error EthValueNotAllowed();
    error RecipientNotAccount();
    error SpenderNotAllowed(address spender);
    error SpendCapExceeded(address quote, uint256 spent, uint256 cap);
    error NotCurve(address target);
    error OnlyExecuteCalls();
    error SignatureValidationNotAllowed();
    error ZeroMinOut();
    error MinOutTooLow(uint256 minOut, uint256 required);
    error QuoteFailed(address target);

    // ───────────────────────── install / uninstall / revoke ─────────────────────────

    /// @param data abi.encode(uint32 entityId, SessionConfig cfg). For the execution-hook install
    ///        (entityId has EXEC_HOOK_FLAG) `data` may be just abi.encode(uint32 entityId): config is shared.
    function onInstall(bytes calldata data) external override {
        uint32 entityId = abi.decode(data[:32], (uint32));
        if (entityId & EXEC_HOOK_FLAG != 0) return; // execution-hook half shares the validation-hook config
        (, SessionConfig memory cfg) = abi.decode(data, (uint32, SessionConfig));
        if (cfg.validUntil == 0 || cfg.validUntil <= cfg.validAfter || cfg.validUntil <= block.timestamp) {
            revert InvalidConfig();
        }
        if (cfg.permissions == 0 || cfg.maxSlippageBps > MAX_SLIPPAGE_BPS_LIMIT) revert InvalidConfig();
        if (cfg.maxSlippageBps == 0) cfg.maxSlippageBps = DEFAULT_MAX_SLIPPAGE_BPS;
        Session storage s = _sessions[entityId][msg.sender];
        s.cfg = cfg;
        s.spent0 = 0;
        s.spent1 = 0;
        s.active = true;
        emit SessionInstalled(msg.sender, entityId, cfg);
    }

    /// @param data abi.encode(uint32 entityId)
    function onUninstall(bytes calldata data) external override {
        uint32 entityId = abi.decode(data[:32], (uint32)) & ~EXEC_HOOK_FLAG;
        if (_sessions[entityId][msg.sender].active) emit SessionRevoked(msg.sender, entityId);
        delete _sessions[entityId][msg.sender];
    }

    /// @notice Kill switch callable by the account itself (i.e. via an owner-validated `execute`). The session key
    ///         cannot reach this: the module is never an allowed target.
    function revoke(uint32 entityId) external {
        entityId &= ~EXEC_HOOK_FLAG;
        _sessions[entityId][msg.sender].active = false;
        emit SessionRevoked(msg.sender, entityId);
    }

    function sessionOf(address account, uint32 entityId) external view returns (Session memory) {
        return _sessions[entityId & ~EXEC_HOOK_FLAG][account];
    }

    function moduleId() external pure override returns (string memory) {
        return "disciple.session-policy.1.0.0";
    }

    function supportsInterface(bytes4 id) external pure override returns (bool) {
        return id == type(IModule).interfaceId || id == type(IValidationHookModule).interfaceId
            || id == type(IExecutionHookModule).interfaceId || id == 0x01ffc9a7;
    }

    // ───────────────────────── validation hooks (ERC-7562-safe) ─────────────────────────

    function preUserOpValidationHook(uint32 entityId, PackedUserOperation calldata userOp, bytes32)
        external
        view
        override
        returns (uint256)
    {
        bytes calldata cd = userOp.callData;
        if (cd.length >= 4 && bytes4(cd[:4]) == EXECUTE_USER_OP) cd = cd[4:];
        Session storage s = _active(entityId, msg.sender);
        _staticCheck(s.cfg, msg.sender, cd);
        // ERC-4337 validationData: aggregator(0) | validUntil << 160 | validAfter << 208. EntryPoint enforces time.
        return (uint256(s.cfg.validUntil) << 160) | (uint256(s.cfg.validAfter) << 208);
    }

    function preRuntimeValidationHook(uint32 entityId, address, uint256 value, bytes calldata data, bytes calldata)
        external
        view
        override
    {
        if (value != 0) revert EthValueNotAllowed();
        Session storage s = _active(entityId, msg.sender);
        _checkTime(s.cfg);
        _staticCheck(s.cfg, msg.sender, data);
    }

    function preSignatureValidationHook(uint32, address, bytes32, bytes calldata) external pure override {
        revert SignatureValidationNotAllowed(); // session keys never sign ERC-1271 messages (no permits)
    }

    // ───────────────────────── execution hook (full checks + spend cap) ─────────────────────────

    function preExecutionHook(uint32 entityId, address, uint256 value, bytes calldata data)
        external
        override
        returns (bytes memory)
    {
        if (value != 0) revert EthValueNotAllowed();
        Session storage s = _active(entityId & ~EXEC_HOOK_FLAG, msg.sender);
        _checkTime(s.cfg); // runtime path / defense in depth (userOp path is enforced by EntryPoint)
        Call[] memory calls = _decode(data);
        uint256 add0;
        uint256 add1;
        for (uint256 i; i < calls.length; ++i) {
            (uint256 a0, uint256 a1) = _fullCheck(s.cfg, msg.sender, calls[i]);
            add0 += a0;
            add1 += a1;
        }
        if (add0 != 0) {
            uint256 n = s.spent0 + add0;
            if (n > s.cfg.cap0) revert SpendCapExceeded(s.cfg.quote0, n, s.cfg.cap0);
            s.spent0 = uint128(n);
            emit SessionSpend(msg.sender, entityId & ~EXEC_HOOK_FLAG, s.cfg.quote0, add0, n);
        }
        if (add1 != 0) {
            uint256 n = s.spent1 + add1;
            if (n > s.cfg.cap1) revert SpendCapExceeded(s.cfg.quote1, n, s.cfg.cap1);
            s.spent1 = uint128(n);
            emit SessionSpend(msg.sender, entityId & ~EXEC_HOOK_FLAG, s.cfg.quote1, add1, n);
        }
        return "";
    }

    function postExecutionHook(uint32, bytes calldata) external pure override {}

    // ───────────────────────── internals ─────────────────────────

    function _active(uint32 entityId, address account) internal view returns (Session storage s) {
        s = _sessions[entityId][account];
        if (!s.active) revert SessionInactive();
    }

    function _checkTime(SessionConfig storage c) internal view {
        if (block.timestamp > c.validUntil || block.timestamp < c.validAfter) revert SessionExpired();
    }

    /// @dev Decodes `execute` / `executeBatch` account calldata. Anything else is rejected.
    function _decode(bytes calldata data) internal pure returns (Call[] memory calls) {
        if (data.length < 4) revert OnlyExecuteCalls();
        bytes4 sel = bytes4(data[:4]);
        if (sel == EXECUTE) {
            (address t, uint256 v, bytes memory d) = abi.decode(data[4:], (address, uint256, bytes));
            calls = new Call[](1);
            calls[0] = Call(t, v, d);
        } else if (sel == EXECUTE_BATCH) {
            calls = abi.decode(data[4:], (Call[]));
        } else {
            revert OnlyExecuteCalls();
        }
    }

    function _staticCheck(SessionConfig storage c, address account, bytes calldata data) internal view {
        Call[] memory calls = _decode(data);
        for (uint256 i; i < calls.length; ++i) {
            Call memory k = calls[i];
            if (k.value != 0) revert EthValueNotAllowed();
            bytes4 sel = _sel(k.data);
            if (k.target == account || k.target == address(this)) revert NotAllowed(k.target, sel);
            uint256 p = _permissionFor(c, k.target, sel);
            if (p == 0 || c.permissions & p == 0) revert NotAllowed(k.target, sel);
        }
    }

    /// @return add0 / add1 quote spend to count against cap0 / cap1.
    function _fullCheck(SessionConfig storage c, address account, Call memory k)
        internal
        returns (uint256 add0, uint256 add1)
    {
        if (k.value != 0) revert EthValueNotAllowed();
        bytes4 sel = _sel(k.data);
        if (k.target == account || k.target == address(this)) revert NotAllowed(k.target, sel);
        uint256 p = _permissionFor(c, k.target, sel);
        if (p == 0 || c.permissions & p == 0) revert NotAllowed(k.target, sel);
        bytes memory args = _args(k.data);

        if (p == P_ROUTER_BUY || p == P_ROUTER_SELL) {
            (address token, uint256 amountIn, uint256 minOut, address recipient,) =
                abi.decode(args, (address, uint256, uint256, address, uint256));
            if (recipient != account) revert RecipientNotAccount();
            _checkMinOut(c, minOut, _routerQuote(k.target, token, p == P_ROUTER_BUY, amountIn), k.target);
        } else if (p == P_CURVE_BUY || p == P_CURVE_SELL) {
            if (!_isCurve(c, k.target)) revert NotCurve(k.target);
            if (sel == CURVE_BUY4 || sel == CURVE_SELL4) {
                (,,, address recipient) = abi.decode(args, (uint256, uint256, uint256, address));
                if (recipient != account) revert RecipientNotAccount();
            }
            (uint256 amountIn, uint256 minOut) = abi.decode(args, (uint256, uint256));
            _checkMinOut(c, minOut, _curveQuote(k.target, p == P_CURVE_BUY, amountIn), k.target);
        } else if (p == P_ANON_LAUNCH) {
            // launchAnon(LaunchParams, stealthOwner, buyRecipient, ephemeralPubKey, viewTag): head word 2 = buyRecipient
            address buyRecipient = _word(args, 2);
            if (buyRecipient != account) revert RecipientNotAccount();
        } else if (p == P_APPROVE) {
            (address spender, uint256 amount) = abi.decode(args, (address, uint256));
            if (!_isFixedTarget(c, spender) && !_isCurve(c, spender)) revert SpenderNotAllowed(spender);
            if (k.target == c.quote0 && c.quote0 != address(0)) add0 = amount;
            else if (k.target == c.quote1 && c.quote1 != address(0)) add1 = amount;
            // non-quote tokens (rocket tokens for sells / walls): uncapped, spender-pinned, proceeds pinned to account
        }
        // P_TRAMP / P_WALL / P_CANCEL / P_LAUNCH: positions & launches are owned by msg.sender (= account)
    }

    /// @dev Quotes are read at execution-hook time, i.e. against the state the trade will execute on (same tx).
    ///      This blocks zero / absurd minOut from the session key; it does NOT defend against a price already
    ///      moved by an earlier tx (a sandwich front-run) — the router's maxImpactBps bounds that leg.
    function _checkMinOut(SessionConfig storage c, uint256 minOut, uint256 quoted, address target) internal view {
        if (minOut == 0) revert ZeroMinOut();
        if (quoted == 0) revert QuoteFailed(target);
        uint256 req = quoted * (BPS - c.maxSlippageBps) / BPS;
        if (minOut < req) revert MinOutTooLow(minOut, req);
    }

    function _routerQuote(address router, address token, bool isBuy, uint256 amountIn) internal returns (uint256 out) {
        try IQuoteSources(router).quoteExactIn(token, isBuy, amountIn) returns (uint256 o, uint256, uint256) {
            out = o;
        } catch {
            revert QuoteFailed(router);
        }
    }

    /// @dev BondingCurve.quoteBuy / quoteSell return all-static structs whose first word is the net output.
    function _curveQuote(address curve, bool isBuy, uint256 amountIn) internal view returns (uint256) {
        (bool ok, bytes memory r) = curve.staticcall(
            abi.encodeWithSignature(isBuy ? "quoteBuy(uint256)" : "quoteSell(uint256)", amountIn)
        );
        if (!ok || r.length < 32) revert QuoteFailed(curve);
        return abi.decode(r, (uint256));
    }

    function _permissionFor(SessionConfig storage c, address target, bytes4 sel) internal view returns (uint256) {
        if (sel == APPROVE) return P_APPROVE; // spender & token pinned in the execution hook
        if (target == c.router && target != address(0)) {
            if (sel == ROUTER_BUY) return P_ROUTER_BUY;
            if (sel == ROUTER_SELL) return P_ROUTER_SELL;
            return 0;
        }
        if (target == c.trampWallManager && target != address(0)) {
            if (sel == TRAMP) return P_TRAMP;
            if (sel == WALL) return P_WALL;
            if (sel == CANCEL) return P_CANCEL;
            return 0;
        }
        if (target == c.launchpad && target != address(0)) {
            if (sel == LAUNCH || sel == LAUNCH_COIN) return P_LAUNCH;
            return 0;
        }
        if (target == c.anonLauncher && target != address(0)) {
            if (sel == ANON_LAUNCH) return P_ANON_LAUNCH;
            return 0;
        }
        // any other target: only bonding-curve trades (registry-verified in the execution hook)
        if (sel == CURVE_BUY3 || sel == CURVE_BUY4) return P_CURVE_BUY;
        if (sel == CURVE_SELL3 || sel == CURVE_SELL4) return P_CURVE_SELL;
        return 0;
    }

    function _isFixedTarget(SessionConfig storage c, address a) internal view returns (bool) {
        return a != address(0)
            && (a == c.router || a == c.launchpad || a == c.anonLauncher || a == c.trampWallManager);
    }

    function _isCurve(SessionConfig storage c, address a) internal view returns (bool) {
        if (a.code.length == 0 || c.launchpad == address(0)) return false;
        try ITokenOf(a).token() returns (address t) {
            try ICurveOf(c.launchpad).curveOf(t) returns (address cv) {
                return cv == a;
            } catch {
                return false;
            }
        } catch {
            return false;
        }
    }

    function _sel(bytes memory d) internal pure returns (bytes4 s) {
        if (d.length < 4) return 0;
        assembly {
            s := mload(add(d, 32))
        }
    }

    function _args(bytes memory d) internal pure returns (bytes memory a) {
        a = new bytes(d.length - 4);
        for (uint256 i; i < a.length; ++i) {
            a[i] = d[i + 4];
        }
    }

    function _word(bytes memory a, uint256 i) internal pure returns (address r) {
        if (a.length < (i + 1) * 32) revert RecipientNotAccount();
        uint256 w;
        assembly {
            w := mload(add(add(a, 32), mul(i, 32)))
        }
        if (w >> 160 != 0) revert RecipientNotAccount();
        r = address(uint160(w));
    }
}
