import { test } from "node:test";
import assert from "node:assert/strict";
import { aaNetworkReady, type PublicNetworkConfig } from "../lib/networkConfig";
const DUMMY = "0x1111111111111111111111111111111111111111";
const cfg: PublicNetworkConfig = { network: "mainnet", confirmedChainId: "4663", rpcUrl: "https://dummy.invalid", entryPoint: DUMMY, factory: DUMMY, implementation: DUMMY,
  launchpad: DUMMY, router: DUMMY, pricer: DUMMY, usdg: DUMMY, defaultQuote: DUMMY, usdgDecimals: "6" };
test("testnet and local retain AA without mainnet configuration", () => { assert.ok(aaNetworkReady(46630, {})); assert.ok(aaNetworkReady(31337, {})); });
test("mainnet requires an explicit matching confirmation and ALL required config", () => {
  assert.equal(aaNetworkReady(4663, {}), false);
  for (const k of ["network", "confirmedChainId", "rpcUrl", "entryPoint", "factory", "implementation", "launchpad", "router", "pricer", "usdg", "defaultQuote", "usdgDecimals"] as const)
    assert.equal(aaNetworkReady(4663, { ...cfg, [k]: undefined }), false, k);
  assert.equal(aaNetworkReady(4663, { ...cfg, router: "0x0000000000000000000000000000000000000000" }), false);
  assert.equal(aaNetworkReady(4663, { ...cfg, confirmedChainId: "46630" }), false);
  assert.equal(aaNetworkReady(1, cfg), false);
});
test("dummy mainnet config passes guard", () => { assert.ok(aaNetworkReady(4663, cfg)); });
