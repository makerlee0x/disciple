import { decodeEventLog, type Log, getAddress } from "viem";
import { EVENTS } from "./abi.js";
import type { DB } from "./db.js";
import type { Stack } from "./config.js";

export type RawLog = Pick<Log, "address" | "data" | "topics" | "blockNumber" | "transactionHash" | "logIndex">;
const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (a: string) => a.toLowerCase();
const s = (x: unknown) => (typeof x === "bigint" ? x.toString() : String(x));

/** Apply decoded logs (already ordered by block/logIndex) to the db. Pure w.r.t. RPC → unit-testable. */
export function applyLogs(db: DB, stack: Stack, logs: RawLog[], tsOf: (b: bigint) => number) {
  const coinBy = db.prepare("SELECT * FROM coins WHERE token = ?");
  const tx = db.transaction(() => {
    for (const l of logs) {
      let ev: { eventName: string; args: any };
      try {
        ev = decodeEventLog({ abi: EVENTS, data: l.data, topics: l.topics as any, strict: true }) as any;
      } catch {
        continue;
      }
      const a = ev.args;
      const src = lc(l.address);
      const block = Number(l.blockNumber);
      const ts = tsOf(l.blockNumber!);
      const id = `${l.transactionHash}:${l.logIndex}`;
      const isCore = (x?: string) => !!x && lc(x) === src;
      switch (ev.eventName) {
        case "Launched":
          if (!isCore(stack.launchpad)) break;
          db.prepare(
            `INSERT OR IGNORE INTO coins (token, stack, curve, creator, quote, name, ticker, creator_tax_bps, launched_block, launched_at, launch_tx)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(lc(a.token), stack.id, lc(a.curve), lc(a.creator), lc(a.quote), a.name, a.ticker, Number(a.creatorTaxBps), block, ts, l.transactionHash);
          break;
        case "QuotePriced":
          if (isCore(stack.launchpad)) db.prepare("UPDATE coins SET quote_price_usd = ? WHERE token = ?").run(s(a.quotePriceUsd), lc(a.token));
          break;
        case "MetadataUpdated":
          if (isCore(stack.launchpad))
            db.prepare("UPDATE coins SET image_uri=?, description=?, socials_uri=? WHERE token=?").run(a.imageURI, a.description, a.socialsURI, lc(a.token));
          break;
        case "CreatorTransferred":
          if (isCore(stack.launchpad)) db.prepare("UPDATE coins SET creator=? WHERE token=?").run(lc(a.newCreator), lc(a.token));
          break;
        case "AnonLaunched":
          if (isCore(stack.anonLauncher)) db.prepare("UPDATE coins SET anon=1, stealth_owner=? WHERE token=?").run(lc(a.stealthOwner), lc(a.token));
          break;
        case "StealthOwnerTransferred":
          if (isCore(stack.anonLauncher)) db.prepare("UPDATE coins SET stealth_owner=? WHERE token=?").run(lc(a.to), lc(a.token));
          break;
        case "Trade": {
          const coin: any = coinBy.get(lc(a.token));
          if (!coin) break;
          const fromCurve = src === coin.curve;
          if (!fromCurve && !isCore(stack.hook)) break;
          const qUsd = Number(BigInt(coin.quote_price_usd ?? "0")) / 1e18;
          const priceUsd = (Number(a.priceAfterX18) / 1e18) * qUsd;
          const volUsd = (Number(a.quoteAmt) / 1e18) * qUsd;
          db.prepare(
            `INSERT OR IGNORE INTO trades VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(id, lc(a.token), stack.id, fromCurve ? "curve" : "hook", lc(a.trader), a.isBuy ? 1 : 0, s(a.quoteAmt), s(a.tokenAmt), s(a.fee),
            s(a.snipeFee), s(a.priceBeforeX18), s(a.priceAfterX18), Number(a.impactBps), s(a.mcapAfterUsd), priceUsd, volUsd, block, ts, l.transactionHash);
          break;
        }
        case "GraduatedToV4": {
          const coin: any = coinBy.get(lc(a.token));
          if (coin && coin.curve === src) db.prepare("UPDATE coins SET graduated=1, graduated_at=?, pool_id=? WHERE token=?").run(ts, a.poolId, lc(a.token));
          break;
        }
        case "Migrated":
          if (isCore(stack.migration)) db.prepare("UPDATE coins SET graduated=1, pool_id=COALESCE(pool_id, ?), graduated_at=COALESCE(graduated_at, ?) WHERE token=?").run(a.poolId, ts, lc(a.token));
          break;
        case "TrampPlaced":
        case "WallPlaced": {
          if (!isCore(stack.trampWallManager)) break;
          const coin: any = coinBy.get(lc(a.token));
          const qUsd = coin ? Number(BigInt(coin.quote_price_usd ?? "0")) / 1e18 : 0;
          let usd = 0;
          if (ev.eventName === "TrampPlaced") usd = (Number(a.quoteAmt) / 1e18) * qUsd;
          else {
            const last: any = db.prepare("SELECT price_usd FROM trades WHERE token=? ORDER BY ts DESC, id DESC LIMIT 1").get(lc(a.token));
            usd = (Number(a.tokenAmt) / 1e18) * (last?.price_usd ?? 0);
          }
          db.prepare(
            `INSERT OR IGNORE INTO orders (stack,id,kind,owner,token,tick_lower,tick_upper,liquidity,amount_in,amount_in_usd,placed_tx,placed_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(stack.id, Number(a.id), ev.eventName === "TrampPlaced" ? "tramp" : "wall", lc(a.owner), lc(a.token), a.tickLower, a.tickUpper,
            s(a.liquidity), s(ev.eventName === "TrampPlaced" ? a.quoteAmt : a.tokenAmt), usd, l.transactionHash, ts);
          break;
        }
        case "Filled":
        case "Cancelled":
          if (!isCore(stack.trampWallManager)) break;
          db.prepare("UPDATE orders SET status=?, quote_out=?, token_out=?, keeper=?, closed_tx=?, closed_at=? WHERE stack=? AND id=?").run(
            ev.eventName === "Filled" ? "filled" : "cancelled", s(a.quoteOut), s(a.tokenOut), a.keeper ? lc(a.keeper) : null, l.transactionHash, ts, stack.id, Number(a.id));
          break;
        case "FeesClaimed":
          if (!isCore(stack.trampWallManager)) break;
          {
            const o: any = db.prepare("SELECT fees_quote, fees_token FROM orders WHERE stack=? AND id=?").get(stack.id, Number(a.id));
            if (o)
              db.prepare("UPDATE orders SET fees_quote=?, fees_token=? WHERE stack=? AND id=?").run(
                (BigInt(o.fees_quote) + a.quoteFees).toString(), (BigInt(o.fees_token) + a.tokenFees).toString(), stack.id, Number(a.id));
          }
          break;
        case "LPDonation":
        case "TradeFeeRouted":
        case "CreatorFeesClaimed":
        case "SnipeFeeRoutedToLP":
        case "SnipeFeeRouted":
        case "Claimed":
        case "RewardAccrued":
        case "Distributed": {
          const ok = { LPDonation: stack.hook, Claimed: stack.anonLauncher, RewardAccrued: stack.rewardsVault, Distributed: stack.rewardsVault }[ev.eventName as string] ?? stack.feeRouter;
          if (!isCore(ok)) break;
          const vals = Object.values(a).map(s);
          db.prepare("INSERT OR IGNORE INTO fee_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
            id, stack.id, ev.eventName, a.token ? lc(a.token) : null,
            lc(a.creator ?? a.trader ?? a.stealthOwner ?? a.to ?? ZERO), a.quote ? lc(a.quote) : a.asset ? lc(a.asset) : a.currency ? lc(a.currency) : null,
            vals[0] ?? null, vals[1] ?? null, vals[2] ?? null, vals[3] ?? null, vals.slice(4).join(",") || null, block, ts, l.transactionHash);
          break;
        }
        case "Transfer": {
          const coin: any = coinBy.get(src);
          if (!coin) break;
          const v = BigInt(a.value);
          const get = db.prepare("SELECT bal FROM balances WHERE token=? AND holder=?");
          const set = db.prepare("INSERT INTO balances (token, holder, bal) VALUES (?,?,?) ON CONFLICT(token, holder) DO UPDATE SET bal = excluded.bal");
          for (const [who, sign] of [[lc(a.from), -1n], [lc(a.to), 1n]] as const) {
            if (who === ZERO) continue;
            const cur = BigInt((get.get(src, who) as any)?.bal ?? "0");
            set.run(src, who, (cur + sign * v).toString());
          }
          break;
        }
      }
    }
  });
  tx();
}

export const checksum = (a: string) => getAddress(a);
