/** With no NEXT_PUBLIC_RHT/RH_PERMIT_FORWARDER override, testnet and mainnet use their deployed forwarders; testnet uses the deployed DisciplePermitForwarder (contracts/deployments/rh-testnet-46630.json). */
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
  it("mainnet uses its deployed forwarder (Team deploy 2026-11-20, lib/chains)", () => {
    expect(forwarderFor(4663)?.toLowerCase()).toBe("0x346e7ff1c9d088113a659b5b0ac2c2f4efd52b4b");
    expect(relaySpender(4663)).toEqual({ kind: "forwarder", address: forwarderFor(4663) });
    expect(relaySpender(4663, { legacy: false }).kind).toBe("forwarder");
  });
});
