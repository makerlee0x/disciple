import { describe, it, expect } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { EVENTS } from "../src/abi";
import { openDb } from "../src/db";
import { applyLogs, type RawLog } from "../src/ingest";
import { Api } from "../src/api";
import { coreAddrs } from "../src/sync";
import { loadConfig, type Config, type Stack } from "../src/config";

// lp-accrue follow-ups (M1): CurveFeeVault.CurveFeeSettled + BondingCurve.LpFeeEscrowReleased, new SnipeEscrowToLP meaning.
const A = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Hex;
const VAULT = A(0xfee);
const stack: Stack = { id: "t", fromBlock: 1n, launchpad: A(1), feeRouter: A(2), hook: A(3), migration: A(4), anonLauncher: A(6), rewardsVault: A(7), referralRegistry: A(8), curveFeeVault: VAULT };
const cfg: Config = { chainId: 1, rpcUrl: "", stateView: A(9), stacks: [stack], dbPath: ":memory:", port: 0, chunk: 100n, pollMs: 0, confirmations: 0, reorgDepth: 64, rpcRps: 0, minChunk: 1n };
const TOKEN = A(0x100), CURVE = A(0x101), QUOTE = A(0x102), ALICE = A(0xa1), BOB = A(0xb0b), CAROL = A(0xca401);
const E18 = 10n ** 18n;
let li = 0;
function mk(name: string, args: Record<string, any>, address: Hex, block = 1n, tx?: Hex): RawLog {
  const ev: any = EVENTS.find((e: any) => e.name === name)!;
  const topics = encodeEventTopics({ abi: [ev], eventName: name, args } as any);
  const nonIdx = ev.inputs.filter((i: any) => !i.indexed);
  const data = encodeAbiParameters(nonIdx, nonIdx.map((i: any) => args[i.name]));
  return { address, topics: topics as any, data, blockNumber: block, transactionHash: tx ?? (`0x${(++li).toString(16).padStart(64, "0")}` as Hex), logIndex: ++li };
}
const ts = (b: bigint) => 1_000_000 + Number(b) * 60;
const settled = (trader: Hex, creatorShare: bigint, lp: bigint, src: Hex, block: bigint) =>
  mk("CurveFeeSettled", { token: TOKEN, quote: QUOTE, trader, creator: ALICE, creatorShare, creatorTaxAmount: 0n, lpShareKept: lp, treasuryShare: 2n * E18, referralPayee: trader === BOB ? CAROL : A(0), referralShare: trader === BOB ? E18 : 0n, kolPayee: A(0), kolShare: 0n }, src, block);

function seeded() {
  const db = openDb(":memory:");
  const stx = `0x${"5".repeat(64)}` as Hex;
  applyLogs(db, stack, [
    mk("Launched", { token: TOKEN, curve: CURVE, creator: ALICE, quote: QUOTE, name: "Coin", ticker: "C", creatorTaxBps: 0n }, stack.launchpad, 2n),
    mk("QuotePriced", { token: TOKEN, quote: QUOTE, quotePriceUsd: 2n * E18 }, stack.launchpad, 2n),
    settled(BOB, 4n * E18, 3n * E18, VAULT, 5n),         // referred trader: in-trade settle
    settled(A(0), 4n * E18, 3n * E18, VAULT, 6n),        // batch settle (trader 0)
    settled(BOB, 99n * E18, 99n * E18, A(0xbad), 6n),     // spoofed emitter → ignored
    mk("SnipeEscrowReleased", { token: TOKEN, vault: stack.rewardsVault!, amount: 10n * E18 }, CURVE, 7n),
    mk("LpFeeEscrowReleased", { token: TOKEN, vault: stack.rewardsVault!, amount: 6n * E18 }, CURVE, 7n),
    mk("LpFeeEscrowReleased", { token: TOKEN, vault: stack.rewardsVault!, amount: 50n * E18 }, A(0xbad), 7n), // not the curve
    settled(A(0), 4n * E18, 2n * E18, VAULT, 8n),        // after the release: LP share stays for the compound bucket (L2)
    mk("SnipeEscrowToLP", { token: TOKEN, amount: 7n * E18 }, CURVE, 9n), // 5 sniper tax + the 2 LP kept after the release
    mk("CreatorFeesClaimed", { token: TOKEN, creator: ALICE, amount: 12n * E18 }, VAULT, 10n),
    mk("ReferrerFeesClaimed", { quote: QUOTE, referrer: CAROL, amount: E18 }, VAULT, 10n),
    mk("CreatorFeesClaimed", { token: TOKEN, creator: stack.anonLauncher!, amount: E18 }, VAULT, 11n, stx),
    mk("StealthCreatorFeesClaimed", { token: TOKEN, stealthOwner: BOB, to: BOB, asset: QUOTE, amount: E18 }, VAULT, 11n, stx),
  ], ts);
  db.prepare("UPDATE coins SET quote_decimals=18").run();
  return db;
}
const get = async (api: Api, path: string) => (await api.route("GET", new URL("http://x" + path)))[1] as any;

describe("lp-accrue follow-ups: CurveFeeVault + LP escrow events", () => {
  it("stack vault is a core address; config takes CURVE_FEE_VAULT for the newest stack", () => {
    expect(coreAddrs(stack)).toContain(VAULT);
    const c = loadConfig({ CURVE_FEE_VAULT: VAULT } as any);
    expect(c.stacks[c.stacks.length - 1].curveFeeVault).toBe(VAULT);
    const bad = loadConfig({ CURVE_FEE_VAULT: "nope" } as any);
    expect(bad.stacks[bad.stacks.length - 1].curveFeeVault).toBeUndefined();
  });
  it("fee-routing sums CurveFeeSettled (vault only), LP released, and splits SnipeEscrowToLP", async () => {
    const api = new Api(seeded(), null, cfg);
    const f = await get(api, `/coins/${TOKEN}/fee-routing`);
    expect(f.trades).toBe(3);
    expect(f.creator).toBe((12n * E18).toString());
    expect(f.lp).toBe((8n * E18).toString());
    expect(f.referral).toBe(E18.toString()); // only the referred in-trade settle
    expect(f.lpFeeEscrowReleased).toBe((6n * E18).toString());
    expect(f.snipeEscrowReleased).toBe((10n * E18).toString());
    expect(f.snipeEscrowToLP).toBe((7n * E18).toString());
    expect(f.snipeEscrowToLPLpFee).toBe((2n * E18).toString());     // 8 kept − 6 released
    expect(f.snipeEscrowToLPSniperTax).toBe((5n * E18).toString());
    expect(f.creatorClaimed).toBe((13n * E18).toString());          // 12 wallet + 1 private (counted once)
  });
  it("rewards keeps SnipeEscrowToLP and adds the split + LpFeeEscrowReleased", async () => {
    const api = new Api(seeded(), null, cfg);
    const r = api.rewards() as any[];
    const k = (kind: string) => r.find((x) => x.kind === kind);
    expect(k("SnipeEscrowToLP").sum_a).toBe(7);
    expect(k("SnipeEscrowToLP.lpFee").sum_a).toBe(2);
    expect(k("SnipeEscrowToLP.sniperTax").sum_a).toBe(5);
    expect(k("LpFeeEscrowReleased").sum_a).toBe(6);
  });
  it("payee credits and claim rows come from the vault", () => {
    const db = seeded();
    const cr = db.prepare("SELECT role, payee, amount FROM fee_credits WHERE token=? ORDER BY role, amount").all(TOKEN.toLowerCase()) as any[];
    expect(cr.filter((x) => x.role === "referral")).toHaveLength(1);
    expect(cr.filter((x) => x.role === "creator")).toHaveLength(3);
    const n = (kind: string) => (db.prepare("SELECT COUNT(*) n FROM fee_events WHERE kind=?").get(kind) as any).n;
    expect(n("CurveFeeSettled")).toBe(3);
    expect(n("ReferrerFeesClaimed")).toBe(1);
    expect(n("StealthCreatorFeesClaimed")).toBe(1);
  });
});
