// One-off (Maker): put the images of coins launched BEFORE the moderated-store change (W-3e) through moderation, so
// they render again. Reads every Launched event + metaOf(imageURI) from the chain and POSTs each data: URI to
// <BASE>/api/moderate-image (field "uri"); allowed ones are stored + allowlisted, blocked/review ones keep the placeholder.
//   BASE=https://<deployment> tsx scripts/backfill-image-allowlist.mts [--dry]
// Uses the deployment's own moderation + Upstash; http(s) imageURIs are skipped (remote content can change after review).
import { createPublicClient, http, type Address } from "viem";
import { robinhoodTestnet } from "../lib/chains";
import { deployment } from "../lib/chains";
import { launchpadAbi } from "../lib/abi";

const BASE = process.env.BASE, dry = process.argv.includes("--dry");
if (!BASE && !dry) { console.error("set BASE=https://<deployment> (or --dry)"); process.exit(1); }
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const d = deployment();
const logs = await pc.getContractEvents({ address: d.launchpad, abi: launchpadAbi, eventName: "Launched", fromBlock: d.fromBlock, toBlock: "latest" });
let ok = 0, skip = 0, other = 0;
for (const l of logs) {
  const token = (l.args as { token: Address }).token;
  const meta = await pc.readContract({ address: d.launchpad, abi: launchpadAbi, functionName: "metaOf", args: [token] }).catch(() => null);
  const uri = meta ? String((meta as readonly unknown[])[2] ?? "") : "";
  if (!uri.startsWith("data:image/")) { skip++; console.log(token, "skip (not a data: URI)"); continue; }
  if (dry) { console.log(token, `would check ${uri.length} chars`); continue; }
  const fd = new FormData(); fd.append("uri", uri);
  const r = await fetch(`${BASE}/api/moderate-image`, { method: "POST", body: fd });
  const j = (await r.json().catch(() => ({}))) as { verdict?: string; error?: string };
  console.log(token, j.verdict ?? r.status, j.error ?? "");
  if (j.verdict === "allow") ok++; else other++;
  await new Promise((res) => setTimeout(res, 2500));   // stay under the 30/min per-IP moderation limit
}
console.log(`\nallowed ${ok}, skipped ${skip}, not allowed ${other} (of ${logs.length})`);
