/** Pure, injectable mainnet preflight helper used by web/scripts/test-mainnet-guards.mts only. Not imported by web/app or other runtime code. No mainnet addresses or RPC endpoints are supplied by this module. */
export const MAINNET_CHAIN_ID = 4663;
export const TESTNET_CHAIN_ID = 46630;
export const LOCAL_CHAIN_ID = 31337;
export const nonzeroAddress = (v?: string) => /^0x[0-9a-fA-F]{40}$/.test(v || "") && !/^0x0{40}$/i.test(v!);
export const httpUrl = (v?: string) => { try { return ["https:", "http:"].includes(new URL(v || "").protocol); } catch { return false; } };
export type PublicNetworkConfig = {
  network?: string; confirmedChainId?: string; rpcUrl?: string; entryPoint?: string; factory?: string;
  launchpad?: string; router?: string; pricer?: string; usdg?: string; defaultQuote?: string;
  usdgDecimals?: string; implementation?: string;
};
export function aaNetworkReady(chainId: number, c: PublicNetworkConfig = {}): boolean {
  if (chainId === TESTNET_CHAIN_ID || chainId === LOCAL_CHAIN_ID)
    return (!c.network || c.network === (chainId === TESTNET_CHAIN_ID ? "testnet" : "local")) && (!c.confirmedChainId || Number(c.confirmedChainId) === chainId);
  return chainId === MAINNET_CHAIN_ID && c.network === "mainnet" && c.confirmedChainId === String(chainId) && httpUrl(c.rpcUrl)
    && [c.entryPoint, c.factory, c.implementation, c.launchpad, c.router, c.pricer, c.usdg, c.defaultQuote].every(nonzeroAddress)
    && /^\d{1,2}$/.test(c.usdgDecimals || "") && Number(c.usdgDecimals) <= 36;
}
