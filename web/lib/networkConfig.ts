/** Pure, injectable mainnet preflight. No mainnet addresses or RPC endpoints are supplied by this module. */
export const MAINNET_CHAIN_ID = 4663;
export const TESTNET_CHAIN_ID = 46630;
export const LOCAL_CHAIN_ID = 31337;
export const nonzeroAddress = (v?: string) => /^0x[0-9a-fA-F]{40}$/.test(v || "") && !/^0x0{40}$/i.test(v!);
export const httpUrl = (v?: string) => { try { return ["https:", "http:"].includes(new URL(v || "").protocol); } catch { return false; } };
export type PublicNetworkConfig = {
  network?: string; confirmedChainId?: string; rpcUrl?: string; entryPoint?: string; factory?: string;
  launchpad?: string; router?: string; pricer?: string; usdg?: string; defaultQuote?: string;
  usdgDecimals?: string; sessionPolicy?: string; sessionPolicyVersion?: string; implementation?: string; singleSigner?: string; timeRange?: string;
};
// Literal NEXT_PUBLIC references are necessary for Next's browser build substitution.
export const PUBLIC_NETWORK: PublicNetworkConfig = {
  network: process.env.NEXT_PUBLIC_DISCIPLE_NETWORK, confirmedChainId: process.env.NEXT_PUBLIC_DISCIPLE_CHAIN_ID,
  rpcUrl: process.env.NEXT_PUBLIC_RH_RPC_URL, entryPoint: process.env.NEXT_PUBLIC_RH_ENTRYPOINT_V07,
  factory: process.env.NEXT_PUBLIC_RH_MAV2_FACTORY, implementation: process.env.NEXT_PUBLIC_RH_MAV2_IMPLEMENTATION,
  singleSigner: process.env.NEXT_PUBLIC_RH_SINGLE_SIGNER_MODULE, timeRange: process.env.NEXT_PUBLIC_RH_TIME_RANGE_MODULE,
  launchpad: process.env.NEXT_PUBLIC_RH_LAUNCHPAD, router: process.env.NEXT_PUBLIC_RH_ROUTER,
  pricer: process.env.NEXT_PUBLIC_RH_QUOTE_PRICER, usdg: process.env.NEXT_PUBLIC_RH_USDG,
  defaultQuote: process.env.NEXT_PUBLIC_RH_DEFAULT_QUOTE, usdgDecimals: process.env.NEXT_PUBLIC_RH_USDG_DECIMALS,
  sessionPolicy: process.env.NEXT_PUBLIC_SESSION_POLICY, sessionPolicyVersion: process.env.NEXT_PUBLIC_SESSION_POLICY_VERSION,
};
export function aaNetworkReady(chainId: number, c: PublicNetworkConfig = PUBLIC_NETWORK): boolean {
  if (chainId === TESTNET_CHAIN_ID || chainId === LOCAL_CHAIN_ID)
    return (!c.network || c.network === (chainId === TESTNET_CHAIN_ID ? "testnet" : "local")) && (!c.confirmedChainId || Number(c.confirmedChainId) === chainId);
  return chainId === MAINNET_CHAIN_ID && c.network === "mainnet" && c.confirmedChainId === String(chainId) && httpUrl(c.rpcUrl)
    && [c.entryPoint, c.factory, c.implementation, c.launchpad, c.router, c.pricer, c.usdg, c.defaultQuote].every(nonzeroAddress)
    && /^\d{1,2}$/.test(c.usdgDecimals || "") && Number(c.usdgDecimals) <= 36;
}
export function oneTapNetworkReady(chainId: number, c: PublicNetworkConfig = PUBLIC_NETWORK): boolean {
  return aaNetworkReady(chainId, c) && (chainId !== MAINNET_CHAIN_ID || ([c.sessionPolicy, c.singleSigner, c.timeRange].every(nonzeroAddress) && /^\d+\.\d+\.\d+$/.test(c.sessionPolicyVersion || "")));
}
export function serverNetworkReady(chainId: number, env: Record<string, string | undefined>, c = PUBLIC_NETWORK): boolean {
  return aaNetworkReady(chainId, c) && (chainId !== MAINNET_CHAIN_ID || (env.DISCIPLE_NETWORK === "mainnet" && env.DISCIPLE_CHAIN_ID === String(chainId)));
}
/** Mainnet uses an owner-configured external bundler, NEVER our removed fast relay/paymaster. */
export function bundlerProxyUrl(chainId: number, env: Record<string, string | undefined>, key?: string, c = PUBLIC_NETWORK): string | undefined {
  if (!serverNetworkReady(chainId, env, c)) throw new Error("network_not_configured");
  if (chainId === MAINNET_CHAIN_ID) {
    if (!httpUrl(env.AA_BUNDLER_RPC_URL)) throw new Error("mainnet_bundler_not_configured");
    return env.AA_BUNDLER_RPC_URL;
  }
  return key ? `https://robinhood-testnet.g.alchemy.com/v2/${key}` : undefined;
}
export async function verifyBundlerChain(url: string, expected: number, request: typeof fetch = fetch): Promise<void> {
  const r = await request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(5000) });
  const j = await r.json() as { result?: string };
  if (!r.ok || !j.result || Number(j.result) !== expected) throw new Error("bundler_chain_mismatch");
}
