/**
 * Read-only: the account's NON-TRADE token transfers in one coin, priced at the coin's price at each transfer's block, for
 * the PnL rebuild (components/PnlHud → lib/pnl positionFromFills). Lee, Oct 30: "coins someone sent you should count in pnl,
 * but at the market cap at the time of transfer."
 *   detect: ERC-20 Transfer logs of the coin with to = account and from = account (eth_getLogs, address + topic filtered,
 *           chunked like lib/server/holders), minus the rows in a tx that has one of the account's own fills (trade legs).
 *   price:  lib/mcap readCoinMcap pinned to the transfer's block (curve.marketCapQuote × launch quote price ÷ supply: the
 *           curve price before graduation, the pool price after); if that node can't serve the block, the nearest indexed
 *           trade price of the coin at or before it (then after it; then the curve start price) — lib/pnl transferPrice.
 * No writes, no signing: only eth_getLogs / eth_call / eth_blockNumber.
 */
import { createPublicClient, http, parseAbiItem, type Address, type PublicClient } from "viem";
import { ACTIVE_CHAIN, deployment } from "@/lib/chains";
import { CURVE } from "@/lib/config";
import { readCoinMcap } from "@/lib/mcap";
import { transferPrice, transfersFromLogs, type ChainTransfer, type PricePoint } from "@/lib/pnl";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const CHUNK0 = BigInt(2_000_000), CHUNK_MIN = BigInt(2_000);
const MAX_PINNED = 40;   // at most this many distinct-block pinned price reads per rebuild; the rest use the trade fallback

let pc: PublicClient | null = null;
const client = () => (pc ??= createPublicClient({ chain: ACTIVE_CHAIN, transport: http() }) as PublicClient);

type Row = { from: string; to: string; tokens: number; block: number; logIndex?: number; tx?: string };

async function logsFor(coin: Address, args: { from?: Address; to?: Address }, from: bigint, latest: bigint, deadline: number): Promise<Row[]> {
  const out: Row[] = [];
  let cur = from, chunk = CHUNK0;
  while (cur <= latest) {
    if (Date.now() > deadline) throw new Error("transfer scan timed out");
    const to = cur + chunk - BigInt(1) > latest ? latest : cur + chunk - BigInt(1);
    let logs;
    try { logs = await client().getLogs({ address: coin, event: TRANSFER, args, fromBlock: cur, toBlock: to }); }
    catch (e) { if (chunk > CHUNK_MIN) { chunk = chunk / BigInt(8); continue; } throw e; }
    for (const l of logs) out.push({ from: String(l.args.from), to: String(l.args.to), tokens: Number(l.args.value as bigint) / 1e18, block: Number(l.blockNumber), logIndex: Number(l.logIndex), tx: l.transactionHash ?? undefined });
    cur = to + BigInt(1);
  }
  return out;
}

/** Non-trade transfers of `account` in `coin`, each with priceUsd + priceSrc. Throws when the logs can't be read (the caller
 *  then keeps the trades-only rebuild and retries). `coinTrades` = indexed fills of the coin (any trader) for the fallback. */
export async function accountTransfers(coin: Address, account: Address, tradeTxs: Iterable<string>, coinTrades: () => Promise<PricePoint[]>, budgetMs = 12_000): Promise<ChainTransfer[]> {
  const deadline = Date.now() + budgetMs, latest = await client().getBlockNumber(), from = deployment().fromBlock;
  const [ins, outs] = await Promise.all([logsFor(coin, { to: account }, from, latest, deadline), logsFor(coin, { from: account }, from, latest, deadline)]);
  const xs = transfersFromLogs([...ins, ...outs], account, tradeTxs);
  const wantPrice = xs.filter((x) => x.dir === "in");
  if (!wantPrice.length) return xs;
  // price at each transfer block: pinned read (curve marketCapQuote at that block), else the nearest indexed trade
  const blocks = [...new Set(wantPrice.map((x) => x.block))];
  const pinned = new Map<number, number>();
  await Promise.all(blocks.slice(-MAX_PINNED).map((b) => readCoinMcap(client(), coin, undefined, BigInt(b)).then((m) => { if (m.priceUsd > 0) pinned.set(b, m.priceUsd); }, () => {})));
  let trades: PricePoint[] | null = null;
  if (blocks.some((b) => !pinned.has(b))) trades = await coinTrades().catch(() => []);
  const start = CURVE.startMcap / CURVE.totalSupply;
  for (const x of wantPrice) { const r = transferPrice(x.block, pinned.get(x.block), trades ?? [], start); x.priceUsd = r.priceUsd; x.priceSrc = r.src; }
  return xs;
}
