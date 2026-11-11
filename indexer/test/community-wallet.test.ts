// Community rewards wallet (FeeRouter.rewardsVault / referralSink → an EOA after the post-deploy owner wiring): the indexer
// credits it from FeeRouter TradeFeeRouted referral rows, ReferrerFeesClaimed and the curve's SnipeEscrowReleased; the old
// RewardsVault contract's RewardAccrued stays on /rewards. Config: deployment json `community.wallet` or COMMUNITY_WALLET.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { EVENTS } from "../src/abi";
import { openDb } from "../src/db";
import { applyLogs, type RawLog } from "../src/ingest";
import { Api } from "../src/api";
import { loadConfig, type Config, type Stack } from "../src/config";

const A = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Hex;
const WALLET = A(0xc0);
const stack: Stack = { id: "t", fromBlock: 1n, launchpad: A(1), feeRouter: A(2), hook: A(3), migration: A(4), trampWallManager: A(5), anonLauncher: A(6), rewardsVault: A(7), referralRegistry: A(8), communityWallet: WALLET };
const cfg: Config = { chainId: 1, rpcUrl: "", stateView: A(9), stacks: [stack], dbPath: ":memory:", port: 0, chunk: 100n, pollMs: 0, confirmations: 0, reorgDepth: 64, rpcRps: 0, minChunk: 1n };
const TOKEN = A(0x100), CURVE = A(0x101), QUOTE = A(0x102), ALICE = A(0xa1), BOB = A(0xb0b), CAROL = A(0xca401);
const E18 = 10n ** 18n;
let li = 0;
function mk(name: string, args: Record<string, any>, address: Hex, block = 1n): RawLog {
  const ev: any = EVENTS.find((e: any) => e.name === name)!;
  const topics = encodeEventTopics({ abi: [ev], eventName: name, args } as any);
  const nonIdx = ev.inputs.filter((i: any) => !i.indexed);
  const data = encodeAbiParameters(nonIdx, nonIdx.map((i: any) => args[i.name]));
  return { address, topics: topics as any, data, blockNumber: block, transactionHash: `0x${(++li).toString(16).padStart(64, "0")}` as Hex, logIndex: li };
}
const ts = (b: bigint) => 1_000_000 + Number(b) * 60;
const fee = (payee: Hex, share: bigint, feeIsQuote: boolean, block: bigint) =>
  mk("TradeFeeRouted", { token: TOKEN, feeToken: feeIsQuote ? QUOTE : TOKEN, trader: BOB, feeIsQuote, creator: ALICE, creatorShare: 4n * E18, creatorTaxAmount: 0n, lpShare: 3n * E18, treasuryShare: 2n * E18, referralPayee: payee, referralShare: share, kolPayee: A(0), kolShare: 0n }, stack.feeRouter, block);

function seeded() {
  const db = openDb(":memory:");
  applyLogs(db, stack, [
    mk("Launched", { token: TOKEN, curve: CURVE, creator: ALICE, quote: QUOTE, name: "Coin", ticker: "C", creatorTaxBps: 0n }, stack.launchpad, 2n),
    mk("QuotePriced", { token: TOKEN, quote: QUOTE, quotePriceUsd: 2n * E18 }, stack.launchpad, 2n),
    fee(WALLET, 1n * E18, true, 3n),        // referral 1% → sink (community wallet), quote units
    fee(WALLET, 2n * E18, true, 4n),
    fee(WALLET, 10n * E18, false, 5n),      // post-grad, launch-token units: kept apart
    fee(CAROL, 5n * E18, true, 6n),         // a normal referrer: not the wallet's
    fee(WALLET, 7n * E18, true, 6n),        // spoofed FeeRouter → ignored
    mk("ReferrerFeesClaimed", { quote: QUOTE, referrer: WALLET, amount: 3n * E18 }, stack.feeRouter, 7n),
    mk("ReferrerFeesClaimed", { quote: QUOTE, referrer: WALLET, amount: 50n * E18 }, A(0xbad), 7n), // spoofed
    mk("SnipeEscrowReleased", { token: TOKEN, vault: WALLET, amount: 11n * E18 }, CURVE, 8n),
    mk("SnipeEscrowReleased", { token: TOKEN, vault: WALLET, amount: 99n * E18 }, A(0xbad), 8n), // not the coin's curve
    mk("RewardAccrued", { token: TOKEN, asset: QUOTE, amount: 7n * E18 }, stack.rewardsVault!, 5n), // old vault: still on /rewards
  ].map((l, i) => (i === 6 ? { ...l, address: A(0xbad) } : l)), ts);
  db.prepare("UPDATE coins SET quote_decimals=18").run();
  return db;
}
const get = async (api: Api, p: string) => (await api.route("GET", new URL("http://x" + p)))[1] as any;

describe("community rewards wallet", () => {
  it("/rewards/community sums referral credits (quote / token apart), referrer claims and escrow releases to the wallet", async () => {
    const api = new Api(seeded(), null, cfg);
    const [c] = await get(api, "/rewards/community");
    expect(c).toMatchObject({ stack: "t", wallet: WALLET.toLowerCase(), rewardsVaultContract: A(7).toLowerCase() });
    expect(c.referralCredits).toEqual({ n: 3, quote: 3, tokenUnits: 10 });
    expect(c.referrerClaims).toEqual({ n: 1, sum: 3 });
    expect(c.snipeEscrowReleased).toEqual({ n: 1, sum: 11 });
    // old RewardsVault path kept
    const rw = await get(api, "/rewards");
    expect(rw.find((r: any) => r.kind === "RewardAccrued")).toMatchObject({ n: 1, sum_a: 7 });
  });
  it("a stack without a community wallet is not listed", async () => {
    const api = new Api(seeded(), null, { ...cfg, stacks: [{ ...stack, communityWallet: undefined }] });
    expect(await get(api, "/rewards/community")).toEqual([]);
  });
  it("config: community.wallet from the deployment json; COMMUNITY_WALLET overrides the newest stack", () => {
    const real = loadConfig({});
    const cur = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../contracts/deployments/rh-testnet-46630.json"), "utf8"));
    expect(real.stacks.at(-1)!.communityWallet).toBe(cur.community.wallet);
    expect(real.stacks.slice(0, -1).every((s) => !s.communityWallet)).toBe(true);
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cw-")), "d.json");
    fs.writeFileSync(f, JSON.stringify({ chainId: 46630, contracts: { Launchpad: A(1), FeeRouter: A(2), DiscipleHook: A(3) } }));
    expect(loadConfig({ DEPLOYMENT_JSON: f }).stacks[0].communityWallet).toBeUndefined();
    expect(loadConfig({ DEPLOYMENT_JSON: f, COMMUNITY_WALLET: WALLET }).stacks[0].communityWallet).toBe(WALLET);
  });
});
