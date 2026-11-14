import "server-only";
/** "Fly with me" links: disciple.vip/fly/<username>/<ticker> (main mode hook loop, maker 2026-11-13). */
import { USERNAME_STORED_RE } from "@/lib/profile";
import { crewAboardNow, type FlyView } from "@/lib/crew";
import { zoneName } from "@/lib/logbook";
import { coinMetas, crewOf, toLog } from "./logbook";
import { tradesOf } from "./trades";
import { usernameOf, walletOf } from "./usernames";


const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/** inviter (username or wallet) + rocket (ticker, case-insensitive, or address) → wallet and the landing view */
export async function resolveFly(userIn: string, coinIn: string): Promise<{ wallet: string; username: string | null; view: FlyView } | null> {
  const u = safeDecode(userIn).trim().toLowerCase().replace(/^@/, ""), c = safeDecode(coinIn).trim().toLowerCase().replace(/^\$/, "");
  let wallet: string | null = null, username: string | null = null;
  if (/^0x[0-9a-f]{40}$/.test(u)) { wallet = u; username = await usernameOf(u).catch(() => null); }
  else if (USERNAME_STORED_RE.test(u)) { wallet = await walletOf(u).catch(() => null); if (wallet) username = u; }
  if (!wallet) return null;
  const metas = await coinMetas();
  // a ticker can repeat: the home list is newest first, so the first match is the newest rocket with it
  const meta = /^0x[0-9a-f]{40}$/.test(c) ? metas.get(c) : [...metas.values()].find((m) => m.ticker.toLowerCase() === c);
  if (!meta) return null;
  const { guild, members } = await crewOf(wallet);
  const crew = new Set([...members, wallet.toLowerCase()]);
  const aboard = guild ? crewAboardNow((await tradesOf(meta.token, null, 2000, "desc").catch(() => [])).map(toLog), crew, Date.now()).length : 0;
  return {
    wallet, username,
    view: {
      inviter: username ?? `${wallet.slice(0, 6)}…`, coin: meta.token.toLowerCase(), ticker: meta.ticker, name: meta.name,
      zone: meta.graduated ? "In orbit" : zoneName(meta.mcapUsd ?? 0), mode: meta.mode, graduated: meta.graduated,
      crew: guild ? { tag: guild.tag, aboard } : null,
    },
  };
}

