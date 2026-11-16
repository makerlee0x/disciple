// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

/// @notice Robinhood mainnet (4663) launch-pair routes, USDG-first. Same rows as routes.json; the fork test
///         checks every key hashes to the poolId there and is initialized on the PoolManager.
/// @dev `listed` = the owner also calls pricer.setAllowedQuote(quote, true). Optional pairs (ETH as WETH) get their
///      router and price routes so they are ready, but stay unlisted (off) until the owner lists them and the web
///      switch (NEXT_PUBLIC_PAIR_ETH) is on. USDG needs no route: it is the launchpad's $1 reference and both
///      setUsdgRoute and setAllowedQuote reject it; its web switch is NEXT_PUBLIC_PAIR_USDG.
library WhitelistRoutes {
    uint256 internal constant CHAIN_ID = 4663;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant ETH = address(0);
    uint24 internal constant DYN = 0x800000;

    address internal constant LONG_HOOK = 0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544;
    address internal constant GLD_USDG_HOOK = 0xB608a78761f179f7C56f15E7D13921B92F00a080;
    address internal constant PONS_USDG_HOOK = 0x08E52564Bad99E05a694b4809F397edcA417A080;
    address internal constant PRIORS_USDG_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    address internal constant STRATEGY = 0x168661C52E5922288dFb2b3f323b6Cf90eb21e18;
    address internal constant AI = 0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18;
    address internal constant SCHIFFY = 0x42aFA2124ca5a2B83898E46B2dA9a190995b1E18;
    address internal constant BONER = 0x98096d17e191B3dA1d5f99a6D7b3584351b11E18;
    address internal constant MEME = 0x385F4f8ae47651ce5F58F5265395a669f8281e18;
    address internal constant PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571;
    address internal constant ORBIO = 0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3;
    address internal constant HOOKR = 0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c;
    address internal constant CASHCAT = 0x020bfC650A365f8BB26819deAAbF3E21291018b4;
    address internal constant PRIORS = 0xeDBf91223639800BCd5756815CAf908Df3b890bE;
    address internal constant PENGU = 0x74BE72AFFAFbC8de30F0C11247814036314D625f;
    address internal constant HMM = 0x7FE995a80075dF3Dc8Ae11A9b82c7FE4202CD87f;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    address internal constant MSTR = 0xec262a75e413fAfD0dF80480274532C79D42da09;
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant GLD = 0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e;
    address internal constant HIMS = 0xCceE82fE024c36fA15E1005edE3E9e4787e23D09;
    address internal constant AMC = 0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B;

    struct Route {
        string symbol;
        address quote;
        bool listed;
        PoolKey[] keys;
        bytes32[] poolIds;
    }

    function _pk(address c0, address c1, uint24 fee, int24 ts, address hooks) private pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, ts, IHooks(hooks));
    }

    /// @dev Deepest unhooked v4 USDG / native ETH pool (0.05%), leg 1 of every ETH route.
    function usdgEth() internal pure returns (PoolKey memory) {
        return _pk(ETH, USDG, 500, 10, address(0));
    }

    function _r1(string memory s, address q, bool listed, PoolKey memory a, bytes32 ia)
        private
        pure
        returns (Route memory r)
    {
        r.symbol = s;
        r.quote = q;
        r.listed = listed;
        r.keys = new PoolKey[](1);
        r.keys[0] = a;
        r.poolIds = new bytes32[](1);
        r.poolIds[0] = ia;
    }

    function _r2(string memory s, address q, bool listed, PoolKey memory a, bytes32 ia, PoolKey memory b, bytes32 ib)
        private
        pure
        returns (Route memory r)
    {
        r.symbol = s;
        r.quote = q;
        r.listed = listed;
        r.keys = new PoolKey[](2);
        r.keys[0] = a;
        r.keys[1] = b;
        r.poolIds = new bytes32[](2);
        r.poolIds[0] = ia;
        r.poolIds[1] = ib;
    }

    /// @notice The 12 launch pairs (all listed) followed by the optional ETH (WETH) pair (not listed).
    function all() internal pure returns (Route[] memory r) {
        r = new Route[](13);
        bytes32 usdgEthId = 0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982;
        r[0] = _r2(
            "STRATEGY", STRATEGY, true,
            _pk(USDG, MSTR, 2500, 25, address(0)), 0x319bac87e616a89e241c10aeb8afd4892a852cdd8b373cd9765ecddc40b87cfe,
            _pk(STRATEGY, MSTR, DYN, 8, LONG_HOOK), 0xa6975f4720a95aa9cdfa9b010a065b0e941534c93f9fa708104c08f0ac029ca0
        );
        r[1] = _r2(
            "AI", AI, true,
            _pk(USDG, NVDA, 3000, 60, address(0)), 0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1,
            _pk(AI, NVDA, DYN, 8, LONG_HOOK), 0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27
        );
        r[2] = _r2(
            "SCHIFFY", SCHIFFY, true,
            _pk(USDG, GLD, DYN, 10, GLD_USDG_HOOK), 0xfe281bbfa9aa658c1aa9c2ad1b0c62c4286f96c7cb1074296b54e869935a7a3a,
            _pk(SCHIFFY, GLD, DYN, 8, LONG_HOOK), 0xc749412e31087a6e6f9210af575bc9100159fbc9f45da3ca8b26b31f3bf5777e
        );
        r[3] = _r2(
            "BONER", BONER, true,
            _pk(USDG, HIMS, 9000, 90, address(0)), 0x68d4f28f1432e0ad714658853edb2e6b0b1ac4060355ff3d169fea656b1d1c52,
            _pk(BONER, HIMS, DYN, 8, LONG_HOOK), 0x9c89b04303dfa76f3f6fb02c2b77be0e8a00ab8fa00d507119acd54ab3e8640d
        );
        r[4] = _r2(
            "MEME", MEME, true,
            _pk(AMC, USDG, 1000, 10, address(0)), 0x7499938c352d5b5b8f0c648722aca5ee964ef9b85c3a3041f1ec379726291d9d,
            _pk(AMC, MEME, DYN, 8, LONG_HOOK), 0x27ccf0a6d1ee74840220715bcca7d3b01e0d33aa30d0259b47ae1585b3f4c071
        );
        r[5] = _r1(
            "PONS", PONS, true,
            _pk(PONS, USDG, DYN, 60, PONS_USDG_HOOK), 0x486435a1f76cd58193f854c6e6213cd05fd58d637865d02065ff558b387fa6ea
        );
        r[6] = _r1(
            "ORBIO", ORBIO, true,
            _pk(USDG, ORBIO, 8000, 80, address(0)), 0xea9f200e13055b82f175f44f592c4c13dd8c9d9320a66487d3c5cd90d68550ef
        );
        // HOOKR moved off the single 1% USDG pool (0x0b362d89...) to its native-ETH pool (maker, Nov 16 2026).
        r[7] = _r2(
            "HOOKR", HOOKR, true,
            usdgEth(), usdgEthId,
            _pk(ETH, HOOKR, 2500, 25, address(0)), 0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf
        );
        r[8] = _r1(
            "CASHCAT", CASHCAT, true,
            _pk(CASHCAT, USDG, 2690, 54, address(0)), 0xa92a3df27a00a276183ff7265fd8affa11df1fe8bb23ddfaf13f6c879a3f818b
        );
        r[9] = _r1(
            "PRIORS", PRIORS, true,
            _pk(USDG, PRIORS, 0, 200, PRIORS_USDG_HOOK), 0xff7b3bd2db34d9ed8160e6dedf1d448777abaa1fa6fc8a31144930a1a656fd92
        );
        r[10] = _r2(
            "PENGU", PENGU, true,
            usdgEth(), usdgEthId,
            _pk(ETH, PENGU, 10_000, 100, address(0)), 0x38cbd4b134c801b6d534600ccf5c59ff06e5e5058f108ddef85aa66c15ffb086
        );
        // HMM's linked pool is Uniswap v3 HMM/WETH; the router is v4 only, so HMM uses the v4 HMM/USDG pool (3.4267%).
        r[11] = _r1(
            "HMM", HMM, true,
            _pk(USDG, HMM, 34_267, 666, address(0)), 0xbe59bf5d48335718349b76aaba718fd677ce10a7c2ecec2f2b96bc8b6ed81e53
        );
        // Optional pair, OFF at launch: routes only, not listed. ETH is quoted as WETH (an ERC-20).
        r[12] = _r2(
            "ETH", WETH, false,
            usdgEth(), usdgEthId,
            _pk(ETH, WETH, 500, 1, address(0)), 0x207783b44fcb4359b281e8040bf476b69cfebf1c93021a11923277ced238d1bc
        );
    }
}
