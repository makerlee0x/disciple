import "server-only";
/**
 * The coin's own image for the share card: on-chain Launchpad.metaOf(coin).imageURI → moderated-store allowlist
 * (same rule as the home list / coin header, lib/coinPageImage) → stored bytes. Not approved / no image / any
 * error ⇒ null, and the card draws exactly as before (no icon). No default art (lee, Oct 26 9:15 AM CT).
 */
import type { Address } from "viem";
import { deployment, isDeployed } from "@/lib/chains";
import { launchpadAbi } from "@/lib/abi";
import { serverPc } from "@/lib/server/chat/identity";
import { getImage, resolveKeys, uriKeyServer } from "@/lib/server/imageStore";

export async function coinIconBuffer(coin: string): Promise<Buffer | null> {
  if (!isDeployed() || !/^0x[0-9a-fA-F]{40}$/.test(coin)) return null;
  try {
    const m = await serverPc().readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "metaOf", args: [coin as Address] });
    const uri = String((m as readonly unknown[])[2] ?? "");
    if (!uri) return null;
    const key = uriKeyServer(uri), id = (await resolveKeys([key]))[key];
    return id ? await getImage(id) : null;
  } catch (e) {
    console.warn("[disciple] share card: coin icon unavailable", e);
    return null;
  }
}
