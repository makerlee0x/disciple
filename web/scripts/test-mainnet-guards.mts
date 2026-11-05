import { test } from "node:test";
import assert from "node:assert/strict";
import { aaNetworkReady, oneTapNetworkReady, serverNetworkReady, bundlerProxyUrl, verifyBundlerChain, type PublicNetworkConfig } from "../lib/networkConfig";
import { chainNonceKey, sendWithChainNonce } from "../lib/server/chainNonce";
const DUMMY = "0x1111111111111111111111111111111111111111";
const cfg: PublicNetworkConfig = { network: "mainnet", confirmedChainId: "4663", rpcUrl: "https://dummy.invalid", entryPoint: DUMMY, factory: DUMMY, implementation: DUMMY,
  launchpad: DUMMY, router: DUMMY, pricer: DUMMY, usdg: DUMMY, defaultQuote: DUMMY, usdgDecimals: "6", sessionPolicy: DUMMY,
  singleSigner: DUMMY, timeRange: DUMMY, sessionPolicyVersion: "1.4.1" };
test("testnet and local retain AA without mainnet configuration", () => { assert.ok(aaNetworkReady(46630, {})); assert.ok(aaNetworkReady(31337, {})); });
test("mainnet requires an explicit matching confirmation and ALL required config", () => {
  assert.equal(aaNetworkReady(4663, {}), false);
  for (const k of ["network", "confirmedChainId", "rpcUrl", "entryPoint", "factory", "implementation", "launchpad", "router", "pricer", "usdg", "defaultQuote", "usdgDecimals"] as const)
    assert.equal(aaNetworkReady(4663, { ...cfg, [k]: undefined }), false, k);
  assert.equal(aaNetworkReady(4663, { ...cfg, router: "0x0000000000000000000000000000000000000000" }), false);
  assert.equal(aaNetworkReady(4663, { ...cfg, confirmedChainId: "46630" }), false);
  assert.equal(aaNetworkReady(1, cfg), false);
});
test("dummy mainnet config passes guard; one-tap additionally requires explicit modules/version", () => {
  assert.ok(aaNetworkReady(4663, cfg)); assert.ok(oneTapNetworkReady(4663, cfg));
  assert.equal(oneTapNetworkReady(4663, { ...cfg, sessionPolicyVersion: undefined }), false);
  assert.equal(oneTapNetworkReady(4663, { ...cfg, singleSigner: undefined }), false);
});
test("mainnet server requires its own confirmation and external bundler; no testnet Alchemy fallback", () => {
  assert.equal(serverNetworkReady(4663, {}, cfg), false);
  const env = { DISCIPLE_NETWORK: "mainnet", DISCIPLE_CHAIN_ID: "4663", AA_BUNDLER_RPC_URL: "https://dummy-bundler.invalid" };
  assert.equal(bundlerProxyUrl(4663, env, "testnet-key", cfg), env.AA_BUNDLER_RPC_URL);
  assert.throws(() => bundlerProxyUrl(4663, { ...env, AA_BUNDLER_RPC_URL: undefined }, "testnet-key", cfg));
  assert.equal(bundlerProxyUrl(46630, {}, "dummy", {}), "https://robinhood-testnet.g.alchemy.com/v2/dummy");
});
test("external bundler must actually report the configured chain", async () => {
  const response = (id: number) => (async () => Response.json({ result: `0x${id.toString(16)}` })) as typeof fetch;
  await verifyBundlerChain("https://dummy.invalid", 4663, response(4663));
  await assert.rejects(verifyBundlerChain("https://dummy.invalid", 4663, response(46630)), /bundler_chain_mismatch/);
});
test("keeper nonces are chain-separated and a wrong RPC is rejected before allocation/send", async () => {
  assert.notEqual(chainNonceKey(4663, DUMMY), chainNonceKey(46630, DUMMY));
  let sent = false;
  await assert.rejects(sendWithChainNonce({ chain: { id: 4663 }, getChainId: async () => 46630 } as never, DUMMY, async () => { sent = true; }), /keeper_rpc_chain_mismatch/);
  assert.equal(sent, false);
});
