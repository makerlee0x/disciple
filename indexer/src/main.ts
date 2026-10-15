import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { makeClient, syncAll } from "./sync.js";
import { Api } from "./api.js";

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const client = makeClient(cfg);
const once = process.argv.includes("--once");

await syncAll(db, client, cfg);
if (once) {
  console.log(JSON.stringify(new Api(db, client, cfg).status(), (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  process.exit(0);
}
const api = new Api(db, client, cfg);
api.server().listen(cfg.port, () => console.log(`DISCIPLE indexer API on :${cfg.port}`));
let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try { await syncAll(db, client, cfg, () => {}); } catch (e: any) { console.error("sync error", e.message); } finally { busy = false; }
}, cfg.pollMs);
