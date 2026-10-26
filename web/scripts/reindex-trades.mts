// One-off (after merge, with lee's OK): re-value stored /api/trades fills (SITE job 7) through the deployment's own
// /api/cron/reindex-trades (its Upstash + RPC). Loops until the server reports done. Idempotent: safe to re-run.
//   BASE=https://<deployment> CRON_SECRET=… tsx scripts/reindex-trades.mts --coin 0x…   (one coin)
//   BASE=https://<deployment> CRON_SECRET=… tsx scripts/reindex-trades.mts --all        (every launched coin)
//   add --dry to see what would change without writing.
const BASE = process.env.BASE, SECRET = process.env.CRON_SECRET;
const args = process.argv.slice(2), dry = args.includes("--dry");
const coin = args.includes("--all") ? "all" : args[args.indexOf("--coin") + 1];
if (!BASE || !SECRET || !coin || (coin !== "all" && !/^0x[0-9a-fA-F]{40}$/.test(coin))) {
  console.error("usage: BASE=https://<deployment> CRON_SECRET=… tsx scripts/reindex-trades.mts (--coin 0x… | --all) [--dry]");
  process.exit(1);
}
for (let i = 1; i <= 20; i++) {
  const r = await fetch(`${BASE}/api/cron/reindex-trades?coin=${coin}${dry ? "&dry=1" : ""}`, { headers: { authorization: `Bearer ${SECRET}` } });
  const j = (await r.json().catch(() => ({}))) as { done?: boolean; error?: string; [k: string]: unknown };
  console.log(`pass ${i}: HTTP ${r.status}`, JSON.stringify(j));
  if (!r.ok || j.done !== false || dry) break;
}
