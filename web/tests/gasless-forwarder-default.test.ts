/** With no NEXT_PUBLIC_RHT_PERMIT_FORWARDER override, testnet uses the deployed DisciplePermitForwarder (contracts/deployments/rh-testnet-46630.json). */
import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => { delete process.env.NEXT_PUBLIC_RHT_PERMIT_FORWARDER; delete process.env.NEXT_PUBLIC_RH_PERMIT_FORWARDER; });
import { readFileSync } from "node:fs";
import { forwarderFor, relaySpender } from "../lib/trade/permitForwarder";

describe("deployed testnet forwarder is the default", () => {
  it("matches the deployments record and is what the relays use", () => {
    const dep = JSON.parse(readFileSync(new URL("../../contracts/deployments/rh-testnet-46630.json", import.meta.url), "utf8"));
    const addr = String(dep.extraContracts.DisciplePermitForwarder.address).toLowerCase();
    expect(addr).toBe("0x18c2375c08b992b704124c2d37151a27d81e7c55");
    expect(forwarderFor(46630)?.toLowerCase()).toBe(addr);
    expect(relaySpender(46630)).toEqual({ kind: "forwarder", address: forwarderFor(46630) });
    expect(relaySpender(46630, { legacy: false }).kind).toBe("forwarder");
  });
  it("mainnet still has none, so its relays still refuse", () => {
    expect(forwarderFor(4663)).toBeNull();
    expect(() => relaySpender(4663)).toThrow();
  });
});
