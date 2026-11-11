/**
 * Daily referral-payout CSVs for lee to send by hand (flow/referral-ledger). Not an automatic payout.
 * America/Chicago day boundaries. Two files: the per-referrer summary, and the per-referrer-and-friend detail.
 *
 * Local (reads the same Upstash / KV_LOCAL_FILE store as the trade indexer):
 *   tsx --conditions=react-server scripts/referral-payout-csv.mts [--date YYYY-MM-DD] [--out DIR]
 *
 * Or pull from a deployment (read-only, Bearer CRON_SECRET — same auth as /api/cron/reindex-trades):
 *   BASE=https://<deployment> CRON_SECRET=… tsx --conditions=react-server scripts/referral-payout-csv.mts [--date YYYY-MM-DD] [--out DIR]
 *
 * Default date is the previous complete America/Chicago day. Default --out is the current directory.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { payoutCsvForDate, previousChicagoDate, processReferralDirty } from "../lib/server/referralLedger";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const outDir = resolve(opt("--out") || ".");
const dateArg = opt("--date");
if (dateArg && !DATE_RE.test(dateArg)) {
  console.error("usage: tsx --conditions=react-server scripts/referral-payout-csv.mts [--date YYYY-MM-DD] [--out DIR]");
  process.exit(1);
}

const date = dateArg || previousChicagoDate();
const BASE = (process.env.BASE || "").replace(/\/$/, "");
const SECRET = process.env.CRON_SECRET;

async function viaHttp(): Promise<{ summary: string; detail: string }> {
  if (!SECRET) throw new Error("CRON_SECRET required when BASE is set");
  const pull = async (kind: "summary" | "detail") => {
    const r = await fetch(`${BASE}/api/cron/referral-payout?date=${date}&kind=${kind}`, { headers: { authorization: `Bearer ${SECRET}` } });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${kind}: ${text}`);
    return text;
  };
  return { summary: await pull("summary"), detail: await pull("detail") };
}

async function viaLocal() {
  const drained = await processReferralDirty();
  const csv = await payoutCsvForDate(date);
  return { summary: csv.summary, detail: csv.detail, drained, referrers: csv.referrers, rows: csv.rows };
}

const pulled = BASE ? { ...(await viaHttp()), drained: undefined, referrers: undefined, rows: undefined } : await viaLocal();
await mkdir(outDir, { recursive: true });
const summaryPath = resolve(outDir, `referral-payout-${date}.csv`);
const detailPath = resolve(outDir, `referral-payout-${date}-detail.csv`);
await writeFile(summaryPath, pulled.summary);
await writeFile(detailPath, pulled.detail);
console.log(JSON.stringify({ date, summary: summaryPath, detail: detailPath, referrers: pulled.referrers, rows: pulled.rows, drained: pulled.drained }, null, 2));
