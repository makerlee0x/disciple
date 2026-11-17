import "server-only";
/**
 * The live catalogue (lib/collection Catalog): one JSON record in KV, merged over the code lists on every server and sent
 * to the Hangar, so drops and new items go out with no deploy. Saved from /admin/catalog (ADMIN_EMAILS). A save is
 * refused if it would change or pull back anything that already has copies (name, rarity, art), see frozenProblems.
 */
import { ACTIVE_CHAIN } from "@/lib/chains";
import {
  DROPS, ITEMS, PAINTS, SERIES, applyCatalog, catalogShapeProblems, catalogVersion, currentCatalog, isBaseItem, itemById, itemsUnder, trailId, type Catalog,
} from "@/lib/collection";
import { kv, type Kv } from "./kv";

const ns = () => `col:${ACTIVE_CHAIN.id}`;
export const CATK = { catalog: () => `${ns()}:catalog`, log: () => `${ns()}:catalog:log`, supply: (item: string) => `${ns()}:supply:${item}` };
const TTL_MS = 30_000;
const BASE_PAINT = new Set(Object.keys(PAINTS));   // read before any catalogue is applied on this server
let loadedAt = 0;

/** Make sure this server runs the latest catalogue (re-read at most every 30 s). Call at the top of anything that uses the lists. */
export async function ensureCatalog(s: Kv = kv(), force = false): Promise<Catalog | null> {
  if (!force && Date.now() - loadedAt < TTL_MS) return currentCatalog();
  loadedAt = Date.now();
  let c: Catalog | null = null;
  try { c = JSON.parse((await s.get(CATK.catalog())) || "null") as Catalog | null; } catch { c = null; }
  if ((c?.v ?? 0) !== catalogVersion()) applyCatalog(c);
  return currentCatalog();
}
/** for tests */
export const resetCatalogCache = () => { loadedAt = 0; };

/** Copies made so far of each item (0 when none). */
export async function supplyOf(ids: string[], s: Kv): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200), raw = await s.mget(part.map(CATK.supply));
    part.forEach((id, k) => { out[id] = Number(raw[k] ?? 0) || 0; });
  }
  return out;
}

/** Why a catalogue can't replace the current one: frozen items changed or pulled, art missing, numbering wrong. */
export function frozenProblems(prev: Catalog | null, next: Catalog, supply: Record<string, number>, now: number): string[] {
  const bad = catalogShapeProblems(next);
  if (bad.length) return bad;
  const before = itemsUnder(prev, now), after = new Map(itemsUnder(next, now).map((r) => [r.item.id, r]));
  for (const b of before) {
    if (!(supply[b.item.id] > 0)) continue;
    const a = after.get(b.item.id);
    if (!a) { bad.push(`${b.item.id} has copies, so it can't be removed.`); continue; }
    for (const k of ["name", "rar", "kind", "art"] as const) if (a.item[k] !== b.item[k]) bad.push(`${b.item.id} has copies, so its ${k === "rar" ? "rarity" : k} can't change.`);
    if (b.out && !a.out) bad.push(`${b.item.id} has copies, so it can't be pulled back (check its series and drop dates).`);
  }
  // what the catalogue asked for has to have landed (series numbering, drops on real series) and new items need art
  const keep = currentCatalog();
  applyCatalog(next);
  try {
    for (const s of next.series ?? []) if (!SERIES.some((x) => x.n === s.n)) bad.push(`Series ${s.n} has to come right after Series ${SERIES.length} and needs its hulls.`);
    for (const d of next.drops ?? []) if (!DROPS.some((x) => x.id === d.id)) bad.push(`Drop "${d.id}" is on Series ${d.series}, which doesn't exist.`);
    for (const t of next.trails ?? []) if (isBaseItem(trailId(t.id))) bad.push(`Trail "${t.id}" is in code; code trails can't change here.`);
    for (const k of Object.keys(next.paints ?? {})) if (BASE_PAINT.has(k)) bad.push(`Paint "${k}" is in code; code paints can't change here.`);
    for (const f of next.flourishes ?? []) if (isBaseItem(f.id)) bad.push(`${f.id} is in code; code flourishes can't change here.`);
    for (const cs of next.series ?? []) for (const h of cs.hulls ?? SERIES.find((x) => x.n === cs.n)?.hulls ?? []) for (const pt of cs.paints ?? []) {
      const i = itemById(`${h}--${pt}`);
      if (i && i.series !== cs.n) bad.push(`${h}--${pt} is already in Series ${i.series}; a skin lives in one series.`);
    }
    const art = next.art ?? {};
    for (const i of ITEMS) {
      if (isBaseItem(i.id)) continue;
      if (i.kind === "skin" && !art[i.id]) bad.push(`${i.id} needs its art.`);
      if (i.kind === "trail" && (!art[i.id] || !art[`${i.id}:bits`])) bad.push(`${i.id} needs its plume and particle art.`);
    }
  } finally { applyCatalog(keep); }
  return [...new Set(bad)];
}

export type SaveCatalog = { ok: true; catalog: Catalog } | { ok: false; status: number; reason: string; problems?: string[] };
/** Replace the catalogue. base = the version the admin edited (a newer save in between is refused, not overwritten). */
export async function saveCatalog(raw: unknown, base: number, by: string, s: Kv = kv(), now = Date.now()): Promise<SaveCatalog> {
  const prev = await ensureCatalog(s, true);
  if ((prev?.v ?? 0) !== base) return { ok: false, status: 409, reason: "Someone saved the catalogue since you opened it. Reload and try again." };
  const next = { ...(raw as Catalog), v: (prev?.v ?? 0) + 1, at: now, by };
  const ids = [...new Set([...itemsUnder(prev, now).map((r) => r.item.id), ...ITEMS.map((i) => i.id)])];
  const problems = frozenProblems(prev, next, await supplyOf(ids, s), now);
  if (problems.length) return { ok: false, status: 400, reason: problems[0], problems };
  await s.set(CATK.catalog(), JSON.stringify(next));
  await s.zadd(CATK.log(), [{ score: now, member: JSON.stringify({ v: next.v, at: now, by }) }]);
  applyCatalog(next); loadedAt = Date.now();
  return { ok: true, catalog: next };
}
