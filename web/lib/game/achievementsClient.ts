/**
 * Client for real per-wallet achievements (GAME). SITE's cron evaluates the shared rules in lib/achievements.ts over the
 * KV indexer and serves:
 *   GET /api/achievements?wallet=0x…  → { wallet, items: [{ id, rarity, unlockedAt?, tx?, progress?, target }] }
 *   GET /api/achievements/feed?since= → recent unlocks (all wallets; we filter to ours) — drives unlock toasts.
 * There is no client POST: unlocks are earned on-chain only.
 *
 * Fallback: if the API is missing (404 before SITE ships), errors, or returns junk, the result is
 * { source: "unavailable", items: [] } and the UI shows every V1 achievement locked with a "syncing" note.
 * Never sample/persona data. Nothing here starts, derives or advances a season.
 */
import { withBase } from "@/lib/base-path";
import { V1_RULES, achievementById, v1RuleById, type AchievementDef, type AchievementView } from "@/lib/achievements";

export const ACHIEVEMENT_EVENT = "disciple:achievement";

export interface AchievementItem {
  id: string;
  rarity?: string;
  /** ms epoch (seconds are normalized to ms) */
  unlockedAt?: number;
  tx?: string;
  progress?: number;
  target?: number;
}

export interface AchievementsResult {
  wallet: string;
  items: AchievementItem[];
  /** api = scored; syncing = API up but this wallet not scored yet (evaluatedAt null); unavailable = API missing/erroring */
  source: "api" | "syncing" | "unavailable";
}

/** One unlock as broadcast on window (`disciple:achievement`) and drawn by the engine / HUD toast. */
export interface AchievementUnlock {
  wallet: string;
  id: string;
  name: string;
  rarity: string;
  description?: string;
  unlockedAt: number;
  tx?: string;
  icon?: string;
  color?: string;
}

const isAddr = (w: unknown): w is string => typeof w === "string" && /^0x[0-9a-fA-F]{40}$/.test(w);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(+v) ? +v : undefined);
/** Accept seconds or ms. */
const ms = (v: unknown): number | undefined => { const n = num(v); return n == null ? undefined : n < 1e12 ? n * 1000 : n; };

export function parseItem(raw: unknown): AchievementItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  return {
    id: r.id,
    rarity: typeof r.rarity === "string" ? r.rarity : undefined,
    unlockedAt: ms(r.unlockedAt),
    tx: typeof r.tx === "string" ? r.tx : undefined,
    progress: num(r.progress),
    target: num(r.target),
  };
}

/** Parse the /api/achievements body; null when the shape is wrong. */
export function parseAchievementsBody(body: unknown, wallet: string): AchievementsResult | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.items)) return null;
  const items = b.items.map(parseItem).filter((x): x is AchievementItem => !!x);
  const syncing = "evaluatedAt" in b && b.evaluatedAt == null;
  return { wallet: (isAddr(b.wallet) ? b.wallet : wallet).toLowerCase(), items, source: syncing ? "syncing" : "api" };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

export async function fetchAchievements(wallet: string, o: { signal?: AbortSignal; fetchImpl?: FetchLike } = {}): Promise<AchievementsResult> {
  const w = String(wallet || "").toLowerCase();
  const none: AchievementsResult = { wallet: w, items: [], source: "unavailable" };
  if (!isAddr(w)) return none;
  const f: FetchLike = o.fetchImpl ?? ((u, i) => fetch(u, i));
  try {
    const r = await f(withBase(`/api/achievements?wallet=${w}`), { cache: "no-store", signal: o.signal });
    if (!r.ok) return none;
    return parseAchievementsBody(await r.json(), w) ?? none;
  } catch {
    return none;
  }
}

/** Feed rows: { items|unlocks: [{ wallet, id, rarity, unlockedAt, tx }], now? }. Shape-tolerant until SITE's doc lands. */
export function parseFeedBody(body: unknown): { rows: (AchievementItem & { wallet: string })[]; now?: number } {
  if (!body || typeof body !== "object") return { rows: [] };
  const b = body as Record<string, unknown>;
  const arr = Array.isArray(b.items) ? b.items : Array.isArray(b.unlocks) ? b.unlocks : Array.isArray(body) ? (body as unknown[]) : [];
  const rows: (AchievementItem & { wallet: string })[] = [];
  for (const raw of arr) {
    const it = parseItem(raw); const w = (raw as Record<string, unknown>)?.wallet;
    if (it && isAddr(w)) rows.push({ ...it, wallet: w.toLowerCase() });
  }
  return { rows, now: ms(b.now) };
}

export function dispatchUnlock(u: AchievementUnlock) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ACHIEVEMENT_EVENT, { detail: u }));
}

/**
 * Poll the feed for `wallet`'s new unlocks and call onUnlock once per (id). Starts from "now" so old unlocks don't
 * re-toast on every page load; ids already seen this tab (sessionStorage) are skipped. Returns a stop function.
 * Missing feed (404/error) → stays quiet and keeps polling at the slow interval.
 */
export function watchUnlocks(
  wallet: string,
  onUnlock: (row: AchievementItem & { wallet: string }) => void,
  o: { intervalMs?: number; fetchImpl?: FetchLike; now?: () => number; storage?: Pick<Storage, "getItem" | "setItem"> | null } = {},
): () => void {
  const w = String(wallet || "").toLowerCase();
  if (!isAddr(w)) return () => {};
  const f: FetchLike = o.fetchImpl ?? ((u, i) => fetch(u, i));
  const now = o.now ?? Date.now;
  const store = o.storage === undefined ? (typeof sessionStorage !== "undefined" ? sessionStorage : null) : o.storage;
  const key = `disciple.ach.seen.${w}`;
  const seen = new Set<string>();
  try { for (const id of JSON.parse(store?.getItem(key) || "[]") as string[]) seen.add(id); } catch { /* fresh */ }
  let since = now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await f(withBase(`/api/achievements/feed?since=${since}&wallet=${w}`), { cache: "no-store" });
      if (r.ok) {
        const { rows, now: srvNow } = parseFeedBody(await r.json());
        for (const row of rows) {
          if (row.wallet !== w || seen.has(row.id)) continue;
          seen.add(row.id); onUnlock(row);
          if (row.unlockedAt && row.unlockedAt > since) since = row.unlockedAt;
        }
        if (srvNow && srvNow > since) since = srvNow;
        try { store?.setItem(key, JSON.stringify([...seen])); } catch { /* private mode */ }
      }
    } catch { /* offline: try again next tick */ }
    if (!stopped) timer = setTimeout(tick, o.intervalMs ?? 15_000);
  };
  timer = setTimeout(tick, 0);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

/* ---------------------------------------------------------------------------------------------------------------
 * View merge: API items → AchievementView (so AchievementCard / AchievementsTab / badges keep working unchanged).
 * ------------------------------------------------------------------------------------------------------------- */

/** V1 real-data set = the shared rules (lib/achievements V1_RULES: 10 picks + atom_bomber), in rule order. The rest of the
 *  catalog is hidden on real data until it has a real rule. */
export const V1_ACHIEVEMENT_IDS: readonly string[] = V1_RULES.map((r) => r.id);

const titleCase = (id: string) => id.replace(/_ach$/, "").split("_").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");

/** Catalog def, or a minimal stand-in for an id the API knows but this build doesn't (never crash on a new rule). */
export function defFor(id: string, item?: AchievementItem): AchievementDef {
  const d = achievementById(id), r = v1RuleById(id);
  // The V1 rule's name / rarity win over the legacy catalog (single source with SITE's API).
  if (d) return r ? { ...d, name: r.name, rarity: r.rarity } : d;
  return {
    id, name: r?.name ?? titleCase(id), description: "", category: "flight",
    rarity: (item?.rarity as AchievementDef["rarity"]) ?? r?.rarity ?? "COMMON", target: item?.target ?? 1, reward: {}, progress: () => 0,
  };
}

export function realAchievementViews(res: Pick<AchievementsResult, "items">, ids: readonly string[] = V1_ACHIEVEMENT_IDS): AchievementView[] {
  const byId = new Map(res.items.map((i) => [i.id, i]));
  return ids.map((id) => {
    const it = byId.get(id);
    const def = defFor(id, it);
    const target = Math.max(1, it?.target ?? def.target);
    const unlocked = it?.unlockedAt != null || (it?.progress != null && it.progress >= target);
    const current = unlocked ? target : Math.max(0, Math.min(target, it?.progress ?? 0));
    const pct = Math.min(100, (current / target) * 100);
    const { points: _noPoints, ...reward } = def.reward;   // V1 has no points: never show "+N pts" on real data
    void _noPoints;
    return {
      ...def, target, reward,
      // API rarity wins once SITE ships (single source of truth); catalog rarity until then.
      rarity: (it?.rarity as AchievementDef["rarity"]) ?? def.rarity,
      state: unlocked ? "unlocked" : current > 0 ? "in_progress" : "locked",
      current, pct, unlockedAt: it?.unlockedAt, tx: it?.tx,
    } as AchievementView & { unlockedAt?: number; tx?: string };
  });
}

/** Feed row → toast payload (name / glyph from the catalog). */
export function unlockFromRow(row: AchievementItem & { wallet: string }, display?: (id: string) => { icon: string; color: string }): AchievementUnlock {
  const d = defFor(row.id, row); const g = display?.(row.id);
  return { wallet: row.wallet, id: row.id, name: d.name, rarity: row.rarity ?? d.rarity, description: d.description, unlockedAt: row.unlockedAt ?? Date.now(), tx: row.tx, icon: g?.icon, color: g?.color };
}
