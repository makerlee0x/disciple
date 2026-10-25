/**
 * Coin holders from REAL balances (replaces the engine's session "fuelers" list on live coins).
 *
 * Primary: SITE's `GET /api/holders?coin=<addr>&limit=50 → { holders: [{ address, balance (raw string), pct, usd,
 * label?: 'pool'|'curve'|'locker'|null }], asOfBlock }`. Until that ships (404) or when it errors: balanceOf of the
 * KNOWN traders (indexed fills from /api/trades + live-feed traders + the user's own account), ranked here.
 * Protocol addresses (bonding curve, v4 PoolManager, locked LP, hook, router, …) are LABELLED and never ranked.
 * `mine` marks the user's own row (the trading account = window.__flightWallet / the smart account).
 * Pure apart from the injected deps (fetch / balance reader) ⇒ unit-tested in scripts/test-live-fixes.mjs.
 */
import { kindOf, type HolderKind } from "../holders";
export type HolderLabel = "pool" | "curve" | "locker" | "burn" | null;
/** Post-grad fix 5: friendly names for tagged (non-ranked) rows. PLACEHOLDER copy — pending lee + BRAND. */
export const HOLDER_LABEL_TEXT: Record<Exclude<HolderLabel, null>, string> = { pool: "Pool (locked)", locker: "Locked LP", burn: "Burned", curve: "Bonding curve" };
export const holderLabelText = (l: HolderLabel | undefined): string => (l ? HOLDER_LABEL_TEXT[l] : "");

export interface HolderRow { address: string; balance: string; tokens: number; pct: number; usd: number; label: HolderLabel; mine: boolean }
export interface HoldersSnapshot { rows: HolderRow[]; asOfBlock: number | null; source: "api" | "balances"; at: number }
export interface ApiHolder { address: string; balance: string; pct?: number; usd?: number; label?: HolderLabel | string | null; /** SITE #158 tag: pool | locker | burn | holder (holder = a player wallet: never labelled) */ kind?: HolderKind | string | null }

const lc = (a: string) => String(a || "").toLowerCase();
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const toBig = (v: unknown) => { try { return typeof v === "bigint" ? v : BigInt(String(v ?? "0")); } catch { return BigInt(0); } };
const tok = (raw: bigint, decimals = 18) => { const d = BigInt(10) ** BigInt(decimals); return Number(raw / d) + Number(raw % d) / Number(d); };
const normLabel = (l: unknown): HolderLabel => (l === "pool" || l === "curve" || l === "locker" || l === "burn" ? l : null);

export interface BuildOpts {
  me?: string | null;
  /** protocol address → label (lowercase keys) */
  labels?: Record<string, HolderLabel>;
  /** total supply, raw (pct denominator) */
  totalSupplyRaw: bigint;
  /** $ per whole token (usd = tokens × price) */
  priceUsd: number;
  limit?: number;
  decimals?: number;
}
/** Rank raw balances: non-zero only, labelled protocol rows after the ranked holders, `mine` on the user's row. */
export function buildHolders(bal: { address: string; balance: bigint | string }[], o: BuildOpts): HolderRow[] {
  const me = o.me ? lc(o.me) : "", labels = o.labels || {}, seen = new Set<string>(), out: HolderRow[] = [];
  const sup = o.totalSupplyRaw > BigInt(0) ? o.totalSupplyRaw : BigInt(1);
  for (const b of bal) {
    const a = lc(b.address); if (!isAddr(a) || seen.has(a)) continue; seen.add(a);
    const raw = toBig(b.balance); if (raw <= BigInt(0)) continue;
    const tokens = tok(raw, o.decimals ?? 18);
    out.push({ address: a, balance: raw.toString(), tokens, pct: Number((raw * BigInt(1_000_000)) / sup) / 10_000,
      usd: tokens * (o.priceUsd > 0 ? o.priceUsd : 0), label: labels[a] ?? (kindOf(a) === "burn" ? "burn" : null), mine: !!me && a === me });
  }
  out.sort((x, y) => (x.label ? 1 : 0) - (y.label ? 1 : 0) || (BigInt(y.balance) > BigInt(x.balance) ? 1 : BigInt(y.balance) < BigInt(x.balance) ? -1 : 0));
  const ranked = out.filter((r) => !r.label).slice(0, o.limit ?? 50);
  return [...ranked, ...out.filter((r) => r.label)];
}

/** SITE /api/holders JSON → rows (labels from the API, plus our protocol labels for anything it left unlabelled). */
export function normalizeApiHolders(j: unknown, o: BuildOpts): { rows: HolderRow[]; asOfBlock: number | null } | null {
  const h = (j as { holders?: unknown })?.holders;
  if (!Array.isArray(h)) return null;
  const labels = { ...(o.labels || {}) };
  const bal: { address: string; balance: string }[] = [];
  for (const x of h as ApiHolder[]) { if (!x || !isAddr(x.address)) continue; const a = lc(x.address);
    // SITE kind is the truth when present: "holder" ⇒ ranked, unlabelled; pool / locker / burn ⇒ tagged (a client "curve" stays "curve")
    if (x.kind === "holder") { delete labels[a]; bal.push({ address: x.address, balance: String(x.balance ?? "0") }); continue; }
    const k = x.kind === "pool" || x.kind === "locker" || x.kind === "burn" ? (x.kind === "pool" && labels[a] === "curve" ? "curve" : x.kind) : null;
    const l = k ?? normLabel(x.label); if (l) labels[lc(x.address)] = l; bal.push({ address: x.address, balance: String(x.balance ?? "0") }); }
  const rows = buildHolders(bal, { ...o, labels });
  // prefer the API's $ / pct when given (it may price at a fresher block), keep ours otherwise
  const byA = new Map((h as ApiHolder[]).filter((x) => x && isAddr(x.address)).map((x) => [lc(x.address), x]));
  for (const r of rows) { const a = byA.get(r.address); if (a && Number.isFinite(a.usd) && (a.usd as number) >= 0) r.usd = a.usd as number; if (a && Number.isFinite(a.pct)) r.pct = a.pct as number; }
  const ab = (j as { asOfBlock?: unknown }).asOfBlock;
  return { rows, asOfBlock: ab != null && Number.isFinite(Number(ab)) ? Number(ab) : null };
}

export interface HoldersDeps {
  fetchJson: (url: string) => Promise<{ status: number; json: unknown }>;
  /** balanceOf for each address (raw); failures may return 0 */
  balancesOf: (addrs: string[]) => Promise<bigint[]>;
  /** extra known holders (live-feed traders, the user) */
  extra?: () => string[];
}
/** Adapter: /api/holders when it exists, else balanceOf of known traders. Never throws (null = nothing known yet). */
export async function fetchHolders(coin: string, o: BuildOpts, d: HoldersDeps, maxAddrs = 80): Promise<HoldersSnapshot | null> {
  const at = Date.now();
  try {
    const r = await d.fetchJson(`/api/holders?coin=${coin}&limit=${o.limit ?? 50}`);
    if (r.status === 200) { const n = normalizeApiHolders(r.json, o); if (n) return { ...n, source: "api", at }; }
  } catch { /* fall back */ }
  const known = new Set<string>();
  try {
    const r = await d.fetchJson(`/api/trades?coin=${coin}&limit=5000&order=desc`);
    const fills = (r.json as { fills?: { trader?: string }[] })?.fills;
    if (r.status === 200 && Array.isArray(fills)) for (const f of fills) if (isAddr(f?.trader)) known.add(lc(f.trader));
  } catch { /* known stays partial */ }
  for (const a of d.extra?.() || []) if (isAddr(a)) known.add(lc(a));
  if (o.me && isAddr(o.me)) known.add(lc(o.me));
  for (const a of Object.keys(o.labels || {})) known.add(a);   // so the curve / pool / locker show as labelled rows
  const addrs = [...known].slice(0, maxAddrs);
  if (!addrs.length) return { rows: [], asOfBlock: null, source: "balances", at };
  let bals: bigint[] = [];
  try { bals = await d.balancesOf(addrs); } catch { return null; }
  return { rows: buildHolders(addrs.map((a, i) => ({ address: a, balance: bals[i] ?? BigInt(0) })), o), asOfBlock: null, source: "balances", at };
}

/** The user's own row from the receipt-derived own-balance ledger (lib/flight/ownLedger), over any snapshot (api or balances).
 *  A lagging node / indexer can't show the pre-trade (e.g. 0) holdings after our own fill. Re-ranked; row labels kept. */
export function overlayOwn(snap: HoldersSnapshot, o: BuildOpts, ownRaw: bigint | undefined): HoldersSnapshot {
  const me = o.me ? lc(o.me) : "";
  if (!me || ownRaw === undefined) return snap;
  const labels: Record<string, HolderLabel> = { ...(o.labels || {}) };
  for (const r of snap.rows) if (r.label && !labels[lc(r.address)]) labels[lc(r.address)] = r.label;
  const bal: { address: string; balance: bigint | string }[] = snap.rows.filter((r) => lc(r.address) !== me).map((r) => ({ address: r.address, balance: r.balance }));
  bal.push({ address: me, balance: ownRaw });
  return { ...snap, rows: buildHolders(bal, { ...o, labels }) };
}
