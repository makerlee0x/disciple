// FORK ONLY: plays the DVNs. On an anvil fork of the destination, impersonates each required DVN of the receiver's
// config and calls ReceiveUln302.verify for every packet in the keeper's state file, so the keeper can then commit
// and execute as it would on mainnet.
//   node test/fork/fake-dvns.ts <state.json> <dest anvil rpc> <receiveLib> <dvn1,dvn2,...> <confirmations> [route]
import { createTestClient, createWalletClient, http, publicActions, type Hex } from "viem";
import { ulnAbi } from "../../src/abi.ts";
import { payloadHash } from "../../src/packet.ts";
import { loadState } from "../../src/state.ts";

const [statePath, rpc, lib, dvnList, conf = "5", route] = process.argv.slice(2);
const st = loadState(statePath);
const test = createTestClient({ mode: "anvil", transport: http(rpc) });
const wal = createWalletClient({ transport: http(rpc) }).extend(publicActions);
for (const p of st.packets.filter((x) => !route || x.route === route)) {
  for (const dvn of dvnList.split(",") as Hex[]) {
    await test.impersonateAccount({ address: dvn });
    await test.setBalance({ address: dvn, value: 10n ** 18n });
    const hash = await wal.writeContract({
      chain: null,
      account: dvn,
      address: lib as Hex,
      abi: ulnAbi,
      functionName: "verify",
      args: [p.header, payloadHash(p.guid, p.message), BigInt(conf)],
    });
    await wal.waitForTransactionReceipt({ hash });
    await test.stopImpersonatingAccount({ address: dvn });
  }
  console.log(`verified nonce ${p.nonce} as ${dvnList}`);
}
