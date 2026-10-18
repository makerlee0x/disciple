import { decodeEventLog, type Log, getAddress } from "viem";
import { EVENTS } from "./abi.js";
import { bumpDataVersion, type DB } from "./db.js";
import { tradeUsd } from "./usd.js";
import type { Stack } from "./config.js";

export type RawLog = Pick<Log, "address" | "data" | "topics" | "blockNumber" | "transactionHash" | "logIndex">;
const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (a: string) => a.toLowerCase();
const s = (x: unknown) => (typeof x === "bigint" ? x.toString() : String(x));

/** Apply decoded logs (already ordered by block/logIndex) to the db. Pure w.r.t. RPC → unit-testable. */
export function applyLogs(db: DB, stack: Stack, logs: RawLog[], tsOf: (b: bigint) => number) {
  const coinBy = db.prepare("SELECT * FROM coins WHERE token = ?");
  // per-coin aggregates read by listCoins; "last" moves forward only (logs arrive in (block, logIndex) order; a tie on
  // (ts, block) is a later log in the same block, as rowid DESC in rebuildCoinStats)
  const bumpCoinStats = db.prepare(`INSERT INTO coin_stats (token, volume_usd, trades, last_mcap, last_price_usd, last_ts, last_block)
    VALUES (@token, @vol, 1, @mcap, @price, @ts, @block)
    ON CONFLICT(token) DO UPDATE SET volume_usd = volume_usd + excluded.volume_usd, trades = trades + 1,
      last_mcap = CASE WHEN excluded.last_ts > last_ts OR (excluded.last_ts = last_ts AND excluded.last_block >= last_block) THEN excluded.last_mcap ELSE last_mcap END,
      last_price_usd = CASE WHEN excluded.last_ts > last_ts OR (excluded.last_ts = last_ts AND excluded.last_block >= last_block) THEN excluded.last_price_usd ELSE last_price_usd END,
      last_block = CASE WHEN excluded.last_ts > last_ts OR (excluded.last_ts = last_ts AND excluded.last_block >= last_block) THEN excluded.last_block ELSE last_block END,
      last_ts = MAX(last_ts, excluded.last_ts)`);
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
          // all USD math in one swappable function (src/usd.ts; #75 replaces mcapAfterUsd with sqrtPriceAfter)
          const usd = tradeUsd({ quotePriceUsdWad: coin.quote_price_usd, quoteAmt: a.quoteAmt, priceAfterX18: a.priceAfterX18, mcapAfterUsd: a.mcapAfterUsd });
          const ins = db.prepare(
            `INSERT OR IGNORE INTO trades VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(id, lc(a.token), stack.id, fromCurve ? "curve" : "hook", lc(a.trader), a.isBuy ? 1 : 0, s(a.quoteAmt), s(a.tokenAmt), s(a.fee),
            s(a.snipeFee), s(a.priceBeforeX18), s(a.priceAfterX18), Number(a.impactBps), usd.mcapUsdWad, usd.priceUsd, usd.volumeUsd, block, ts, l.transactionHash);
          // aggregates only for newly inserted trades (re-sync of an applied range is a no-op)
          if (ins.changes === 1) bumpCoinStats.run({ token: lc(a.token), vol: usd.volumeUsd, mcap: Number(BigInt(usd.mcapUsdWad)) / 1e18, price: usd.priceUsd, ts, block });
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
            `INSERT OR IGNORE INTO orders (stack,id,kind,owner,token,tick_lower,tick_upper,liquidity,amount_in,amount_in_usd,placed_tx,placed_at,placed_block)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(stack.id, Number(a.id), ev.eventName === "TrampPlaced" ? "tramp" : "wall", lc(a.owner), lc(a.token), a.tickLower, a.tickUpper,
            s(a.liquidity), s(ev.eventName === "TrampPlaced" ? a.quoteAmt : a.tokenAmt), usd, l.transactionHash, ts, block);
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
        case "LaunchTierContext":
          if (isCore(stack.launchpad))
            db.prepare("UPDATE coins SET start_mcap_usd=?, graduation_mcap_usd=?, total_supply=?, decimals=? WHERE token=?").run(
              s(a.startMcapUsd), s(a.graduationMcapUsd), s(a.totalSupply), Number(a.decimals_), lc(a.token));
          break;
        case "AltitudeUpdate":
        case "TierBreak": {
          const coin: any = coinBy.get(lc(a.token));
          if (!coin) break;
          const fromCurve = src === coin.curve;
          if (!fromCurve && !isCore(stack.hook)) break;
          if (ev.eventName === "AltitudeUpdate")
            db.prepare("UPDATE coins SET tier=?, altitude_mcap_usd=?, altitude_block=? WHERE token=?").run(Number(a.tier), s(a.mcapUsd), block, coin.token);
          else
            db.prepare("INSERT OR IGNORE INTO tier_breaks VALUES (?,?,?,?,?,?,?,?,?,?)").run(
              id, stack.id, coin.token, fromCurve ? "curve" : "hook", Number(a.fromTier), Number(a.toTier), s(a.mcapUsd), block, ts, l.transactionHash);
          break;
        }
        case "KeeperTipPaid": {
          if (!isCore(stack.trampWallManager)) break;
          db.prepare("INSERT OR IGNORE INTO keeper_tips VALUES (?,?,?,?,?,?,?,?,?)").run(
            id, stack.id, Number(a.id), lc(a.keeper), s(a.quoteTip), s(a.tokenTip), block, ts, l.transactionHash);
          db.prepare("UPDATE orders SET keeper_quote_tip=?, keeper_token_tip=?, keeper=COALESCE(keeper, ?) WHERE stack=? AND id=?").run(
            s(a.quoteTip), s(a.tokenTip), lc(a.keeper), stack.id, Number(a.id));
          break;
        }
        case "ReferrerAttributed":
        case "ReferrerPending":
          if (!isCore(stack.referralRegistry)) break;
          // Attributed is final; Pending never downgrades an Attributed row.
          db.prepare(
            `INSERT INTO referrals VALUES (?,?,?,?,?,?,?) ON CONFLICT(stack, wallet) DO UPDATE SET referrer=excluded.referrer, status=excluded.status,
             block=excluded.block, ts=excluded.ts, tx=excluded.tx WHERE referrals.status != 'attributed' OR excluded.status = 'attributed'`,
          ).run(stack.id, lc(a.wallet), lc(a.referrer), ev.eventName === "ReferrerAttributed" ? "attributed" : "pending", block, ts, l.transactionHash);
          break;
        case "LaunchFeePaid":
          if (isCore(stack.anonLauncher)) db.prepare("UPDATE coins SET launch_fee=? WHERE token=?").run(s(a.amount), lc(a.token));
          break;
        case "LaunchMode":
          if (isCore(stack.launchpad)) db.prepare("UPDATE coins SET mode=? WHERE token=?").run(Number(a.mode), lc(a.token));
          break;
        case "TradeFeeRouted": {
          if (!isCore(stack.feeRouter)) break;
          // Normalized columns for BOTH signatures: account=trader, quote=fee asset, a=creatorShare, b=lpShare,
          // c=treasuryShare, d=referralShare, e=creatorTaxAmount. Redeploy fees charged in the launch token
          // (feeIsQuote=false, post-grad) are kept apart as kind TradeFeeRoutedToken so quote and token units never mix.
          const next = "feeIsQuote" in a;
          const kind = next && !a.feeIsQuote ? "TradeFeeRoutedToken" : "TradeFeeRouted";
          db.prepare("INSERT OR IGNORE INTO fee_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
            id, stack.id, kind, lc(a.token), lc(a.trader), lc(next ? a.feeToken : a.quote),
            s(a.creatorShare), s(a.lpShare), s(a.treasuryShare), s(a.referralShare), s(a.creatorTaxAmount), block, ts, l.transactionHash);
          break;
        }
        case "ProfitTaxCharged":
        case "HolderRewardsClaimed": {
          // PVE crew pool (redeploy): emitted by the coin's own curve only
          const coin: any = coinBy.get(lc(a.token));
          if (!coin || src !== coin.curve) break;
          const who = ev.eventName === "ProfitTaxCharged" ? a.seller : a.holder;
          const v = ev.eventName === "ProfitTaxCharged" ? [a.tax, a.grossQuote, a.costBasis] : [a.amount];
          db.prepare("INSERT OR IGNORE INTO fee_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
            id, stack.id, ev.eventName, lc(a.token), lc(who), coin.quote, s(v[0]), v[1] != null ? s(v[1]) : null, v[2] != null ? s(v[2]) : null, null, null, block, ts, l.transactionHash);
          break;
        }
        case "Deposited":
        case "Escrowed":
        case "Withdrawn": {
          // UsdgDepositNotifier (redeploy): kinds prefixed so they never collide with other contracts' events
          if (!isCore(stack.depositNotifier)) break;
          const kind = `Escrow${ev.eventName}`;
          const [x, y, z] = ev.eventName === "Escrowed" ? [a.id, a.amount, a.unlockAt] : [a.amount, null, null];
          db.prepare("INSERT OR IGNORE INTO fee_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
            id, stack.id, kind, null, lc(a.wallet), null, s(x), y != null ? s(y) : null, z != null ? s(z) : null, null,
            ev.eventName === "Deposited" ? lc(a.payer) : null, block, ts, l.transactionHash);
          break;
        }
        case "CreatorTokenFeesClaimed":
        case "ReferrerFeesClaimed":
        case "UsdgDepositRecorded":
        case "CreatorFeesClaimed":
        case "SnipeFeeRoutedToLP":
        case "SnipeFeeRouted":
        case "Claimed":
        case "RewardAccrued":
        case "Distributed": {
          const ok = { UsdgDepositRecorded: stack.referralRegistry, Claimed: stack.anonLauncher, RewardAccrued: stack.rewardsVault, Distributed: stack.rewardsVault }[ev.eventName as string] ?? stack.feeRouter;
          if (!isCore(ok)) break;
          const vals = Object.values(a).filter((v) => typeof v === "bigint").map(s); // numeric args only, in ABI order
          db.prepare("INSERT OR IGNORE INTO fee_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
            id, stack.id, ev.eventName, a.token ? lc(a.token) : null,
            lc(a.creator ?? a.trader ?? a.referrer ?? a.wallet ?? a.stealthOwner ?? a.to ?? ZERO),
            a.quote ? lc(a.quote) : a.asset ? lc(a.asset) : ev.eventName === "CreatorTokenFeesClaimed" ? lc(a.token) : null,
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
  bumpDataVersion(db);
}

export const checksum = (a: string) => getAddress(a);
