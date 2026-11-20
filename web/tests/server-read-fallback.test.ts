/** Server reads fail over to the chain's receipt node (maker 2026-11-20, blank $SPACE page with RH_RECEIPT_RPC_URL set). */
import { describe, expect, it } from "vitest";
import { serverReadUrls } from "@/lib/rpc/serverRead";

describe("serverReadUrls", () => {
  it("adds the mainnet receipt node after the public RPC", () => {
    expect(serverReadUrls("https://rpc.mainnet.chain.robinhood.com", { RH_RECEIPT_RPC_URL: "https://node.example/rh" }, 4663))
      .toEqual(["https://rpc.mainnet.chain.robinhood.com", "https://node.example/rh"]);
  });
  it("never takes the testnet one on mainnet, and skips a duplicate or a bad URL", () => {
    expect(serverReadUrls("https://a", { RHT_RECEIPT_RPC_URL: "https://t" }, 4663)).toEqual(["https://a"]);
    expect(serverReadUrls("https://a", { RH_RECEIPT_RPC_URL: "https://a" }, 4663)).toEqual(["https://a"]);
    expect(serverReadUrls("https://a", { RH_RECEIPT_RPC_URL: "not a url" }, 4663)).toEqual(["https://a"]);
  });
});
