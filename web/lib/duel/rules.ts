/**
 * Trading Duel rules (shared by the server, the live match screen and the practice bot). Pure, no I/O.
 *
 * A duel: two pilots, same tier fuel, same live BTC price, 1 minute. Each pilot BOOSTs (long) or DUMPs (short)
 * at 50× (Lighter's BTC max), as often as they like, and can add to an open position (the entry averages). No flips (maker 2026-11-17, Nova
 * fills are slow): to go the other way, cash out first. Most profit at the buzzer wins.
 * If it's within OT_GAP of a tie at the buzzer, the duel gets one 30 s overtime.
 *
 * Amounts are dollars, prices $ per coin, times ms. FEE and FILL_MS mimic Lighter Plus for a feel test; Nova numbers replace them later.
 */

/** Lighter's BTC max (50×) for the Lighter Plus feel test; was 500× for Nova. */
export const LEV = 50;
/** 0.55 bp a side on notional = 1.1 bp round trip: Lighter Plus (1 bp) + 0.1 bp Disciple partner fee. Locked by maker 2026-11-17 (1.2 "felt too heavy"). */
export const FEE = 0.000055;
/** Every duel fill waits this long after the tap, like a Lighter Standard/Plus taker order (300 ms speed bump). */
export const FILL_MS = 300;
/** NUKE when the open position has lost 80% of the fuel in it. */
export const LIQ = 0.8;
export const OT_MS = 30_000;
export const COUNTDOWN_MS = 3_500;

export type TierId = "rookie" | "pro" | "shark";
export interface Tier { id: TierId; label: string; fuel: number; sizes: number[] }
/** sizes: trade size buttons; 0 = ALL (everything left). maker, 2026-11-14: rookie $20, pro $50, shark $150.
 *  Shown as NORMIE / DEGEN / WHALE (maker 2026-11-18); the ids stay so queues and saved settings keep working. */
export const TIERS: Record<TierId, Tier> = {
  rookie: { id: "rookie", label: "NORMIE", fuel: 20, sizes: [1, 2, 5, 10, 0] },
  pro: { id: "pro", label: "DEGEN", fuel: 50, sizes: [2, 5, 10, 25, 0] },
  shark: { id: "shark", label: "WHALE", fuel: 150, sizes: [5, 10, 25, 50, 0] },
};
/** One length: 1 minute (maker, 2026-11-16: "3 minutes is way too long"). The old 3-minute option is gone. */
export const DUEL_LEN_MS = 60_000;
export const LENGTHS = [DUEL_LEN_MS] as const;
export type LengthMs = (typeof LENGTHS)[number];
export const isTier = (t: unknown): t is TierId => t === "rookie" || t === "pro" || t === "shark";
export const isLength = (l: unknown): l is LengthMs => l === DUEL_LEN_MS;
/** a request length: an old client may still send 180000 (3 min); it plays 1 minute like everyone else, in the same queue */
export const toLength = (l: unknown): LengthMs | null => (l === DUEL_LEN_MS || l === 180_000 ? DUEL_LEN_MS : null);

/* ---- custom budgets (maker, 2026-11-15: "challenge someone to a $100 budget, or a $1k, or whatever") ----
 * Friend duels can set their own fuel, whole dollars from $5 to $10,000 (maker: "as low as $5"). Ranked keeps the three tiers, so matchmaking
 * pools stay fixed. It's each pilot's own budget, never a pot: nobody pays the winner. Trade sizes scale with it: the
 * biggest button is half the budget rounded down to a 1-2-5 step, then the three steps below it, plus ALL
 * ($20 → 1/2/5/10, $100 → 5/10/20/50, $1,000 → 50/100/200/500). */
export const CUSTOM_FUEL_MIN = 5, CUSTOM_FUEL_MAX = 10_000;
export const isCustomFuel = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= CUSTOM_FUEL_MIN && n <= CUSTOM_FUEL_MAX;
const nice = (v: number) => { if (v < 1) return 1; const k = 10 ** Math.floor(Math.log10(v)), m = v / k; return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * k; };
const stepDown = (v: number) => { const k = 10 ** Math.floor(Math.log10(v)), m = Math.round(v / k); return m === 5 ? 2 * k : m === 2 ? k : 5 * (k / 10); };
export function sizesFor(fuel: number): number[] {
  // under $20 the 1-2-5 ladder would dip below the $1 minimum trade, so small budgets get whole dollars: $5 → $1/$2/$3/$4
  if (fuel < 20) return [1, 2, 3, Math.max(4, Math.floor(fuel / 2)), 0];
  const out = [nice(fuel / 2)];
  while (out.length < 4) out.unshift(stepDown(out[0]));
  return [...out, 0];
}
/** a room's starting fuel and trade sizes: its custom budget, else its tier's */
export const fuelOf = (r: { tier: TierId; fuel?: number }) => (r.fuel && isCustomFuel(r.fuel) ? r.fuel : TIERS[r.tier].fuel);
export const sizesOf = (r: { tier: TierId; fuel?: number }) => (r.fuel && isCustomFuel(r.fuel) ? sizesFor(r.fuel) : TIERS[r.tier].sizes);
/**
 * Trade size buttons are a share of the fuel you have left (maker 2026-11-17, like Sell % in live flight): 10%, 25%, 50%,
 * ALL (0). The client turns the % into dollars at the tap, so the server takes any whole-cent amount from $1 (or 0 = ALL);
 * openStep still caps it at the fuel left.
 */
export const PCTS = [10, 25, 50, 0] as const;
export const pctUsd = (pct: number, fuel: number) => (pct === 0 ? fuel : Math.floor(fuel * pct) / 100);
export const okStake = (usd: number) => usd === 0 || (Number.isFinite(usd) && usd >= 1 && usd <= CUSTOM_FUEL_MAX && Math.abs(usd * 100 - Math.round(usd * 100)) < 1e-6);

export type SideN = 1 | -1;
export interface DuelPos { side: SideN; size: number; coll: number; entry: number; t: number }
export interface Book { fuel: number; pos: DuelPos | null; fees: number; trades: number; green: number; best: number; bombs: number }
export type TradeAction = "boost" | "dump" | "close";

export const newBook = (fuel: number): Book => ({ fuel, pos: null, fees: 0, trades: 0, green: 0, best: 0, bombs: 0 });
export const pnlOf = (pos: DuelPos | null, p: number) => (pos ? (pos.size * (p - pos.entry) / pos.entry) * pos.side : 0);
export const valueOf = (b: Book, p: number) => (b.pos ? Math.max(0, b.pos.coll + pnlOf(b.pos, p)) : 0);
export const profitOf = (b: Book, p: number, fuel0: number) => b.fuel + valueOf(b, p) - fuel0;
export const isLiquidated = (b: Book, p: number) => !!b.pos && pnlOf(b.pos, p) <= -LIQ * b.pos.coll;
/** price at which the open position NUKEs */
export const liqPrice = (pos: DuelPos) => pos.entry * (1 - (pos.side * LIQ * pos.coll) / pos.size);

/** One step that happened to a book: what the screen shows (burst, banked pop, NUKE). */
export type BookStep =
  | { kind: "open"; side: SideN; usd: number; price: number }
  | { kind: "close"; side: SideN; net: number; price: number }
  | { kind: "bomb"; side: SideN; lost: number; price: number };

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const clone = (b: Book): Book => ({ ...b, pos: b.pos ? { ...b.pos } : null });

function openStep(b: Book, side: SideN, stake: number, price: number, t: number, steps: BookStep[]): boolean {
  stake = Math.min(stake, b.fuel / (1 + LEV * FEE));
  if (!(stake >= 1)) return false;
  const size = stake * LEV, fee = size * FEE;
  b.fuel = r6(b.fuel - stake - fee); b.fees = r6(b.fees + fee); b.trades++;
  if (b.pos && b.pos.side === side) {
    const s2 = b.pos.size + size;
    b.pos.entry = s2 / (b.pos.size / b.pos.entry + size / price); b.pos.size = s2; b.pos.coll = r6(b.pos.coll + stake);
  } else b.pos = { side, size, coll: r6(stake), entry: price, t };
  steps.push({ kind: "open", side, usd: r6(stake), price });
  return true;
}
function closeStep(b: Book, price: number, steps: BookStep[]): number {
  const pos = b.pos; if (!pos) return 0;
  const pnl = pnlOf(pos, price), fee = pos.size * FEE, back = Math.max(0, pos.coll + pnl - fee), net = r6(back - pos.coll);
  b.fuel = r6(b.fuel + back); b.fees = r6(b.fees + fee); b.trades++; b.pos = null;
  if (net > 0) b.green++;
  if (net > b.best) b.best = net;
  steps.push({ kind: "close", side: pos.side, net, price });
  return net;
}
/** NUKE check at a price: the fuel in the position is gone. Returns the new book and the step, or null. */
export function bombAt(b0: Book, price: number): { book: Book; step: BookStep } | null {
  if (!isLiquidated(b0, price)) return null;
  const b = clone(b0), pos = b.pos!;
  b.pos = null; b.trades++; b.bombs++;
  return { book: b, step: { kind: "bomb", side: pos.side, lost: pos.coll, price } };
}

/**
 * Apply a pilot's press at `price`:
 * - boost / dump with nothing open or the same side open: put `usd` in (0 = ALL fuel left; adds average the entry)
 * - boost / dump with the other side open: refused (null). No flips: cash out first.
 * - close: cash out
 * An NUKE at this price is applied first. Returns null when nothing could happen (no fuel, nothing to close).
 */
export function applyTrade(b0: Book, action: TradeAction, usd: number, price: number, t: number): { book: Book; steps: BookStep[] } | null {
  if (!(price > 0)) return null;
  const steps: BookStep[] = [];
  let b = clone(b0);
  const bomb = bombAt(b, price); if (bomb) { b = bomb.book; steps.push(bomb.step); }
  if (action === "close") { if (!b.pos) return steps.length ? { book: b, steps } : null; closeStep(b, price, steps); return { book: b, steps }; }
  const side: SideN = action === "boost" ? 1 : -1;
  if (b.pos && b.pos.side !== side) return steps.length ? { book: b, steps } : null;
  if (!openStep(b, side, usd === 0 ? b.fuel : usd, price, t, steps)) return steps.length ? { book: b, steps } : null;
  return { book: b, steps };
}
/** Close whatever is open at the buzzer (bomb first if it's already gone). */
export function settleBook(b0: Book, price: number): Book {
  const bomb = bombAt(b0, price); const b = bomb ? bomb.book : clone(b0);
  if (b.pos) closeStep(b, price, []);
  return b;
}

/** Overtime when the gap at the buzzer is within 25¢ per $20 of tier fuel (prototype rule). */
export const overtimeGap = (fuel0: number) => 0.25 * (fuel0 / 20);
export const needsOvertime = (diff: number, fuel0: number, alreadyOt: boolean) => !alreadyOt && Math.abs(diff) < overtimeGap(fuel0);

/* ---------- rating (Elo, hidden number; tiers are the visible part) ---------- */
/** s: the season (lib/duel/season n) this rating was last carried into; older ratings get the soft reset on read. */
export interface Rating { r: number; w: number; l: number; games: number; streak: number; peak: number; s?: number }
export const newRating = (): Rating => ({ r: 1200, w: 0, l: 0, games: 0, streak: 0, peak: 1200 });
/** Season soft reset (maker 2026-11-18, the LoL / Clash Royale way): each new season pulls the hidden rating halfway back to
 *  1,200 (1,800 → 1,500, 900 → 1,050), so good pilots keep fair matches and climb fast. Record, streak and peak stay. */
export const RESET_PULL = 0.5;
export function carryRating(x: Rating, season: number): Rating {
  if (x.s == null) return { ...x, s: season };
  if (x.s >= season) return x;
  const keep = Math.pow(1 - RESET_PULL, season - x.s);
  return { ...x, r: Math.round(1200 + (x.r - 1200) * keep), s: season };
}
/** K is bigger for the first 10 games (placement), so new pilots find their level fast. */
export const kOf = (games: number) => (games < 10 ? 48 : 24);
/** score: 1 win, 0 loss, 0.5 draw. Returns the new ratings and the deltas. */
export function rate(a: Rating, b: Rating, scoreA: 0 | 0.5 | 1): { a: Rating; b: Rating; da: number; db: number } {
  const ea = 1 / (1 + Math.pow(10, (b.r - a.r) / 400));
  const da = Math.round(kOf(a.games) * (scoreA - ea)), db = Math.round(kOf(b.games) * ((1 - scoreA) - (1 - ea)));
  const up = (x: Rating, d: number, s: number): Rating => {
    const r = Math.max(100, x.r + d);
    return { r, games: x.games + 1, w: x.w + (s === 1 ? 1 : 0), l: x.l + (s === 0 ? 1 : 0), streak: s === 1 ? x.streak + 1 : s === 0 ? 0 : x.streak, peak: Math.max(x.peak, r) };
  };
  return { a: up(a, da, scoreA), b: up(b, db, 1 - scoreA), da, db };
}
/** How far apart two ratings may be to pair, given how long each has waited (widens 15 per second, caps at 400). */
export const matchWindow = (waitedMs: number) => Math.min(400, 50 + Math.floor(waitedMs / 1000) * 15);
/** After this long in the queue the lobby offers a practice bot (always labelled as a bot). */
export const BOT_OFFER_MS = 20_000;

/* ---------- invite codes ---------- */
const CODE_ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function makeCode(rand: () => number = Math.random): string { let c = ""; for (let i = 0; i < 4; i++) c += CODE_ABC[Math.floor(rand() * CODE_ABC.length)]; return c; }
/** Accepts "7K2Q", "duel-7k2q", or a pasted link ending in the code. */
export function parseCode(raw: unknown): string | null {
  const m = String(raw ?? "").trim().toUpperCase().match(/(?:DUEL-|\/)?([A-Z0-9]{4})\/?$/);
  if (!m) return null; const c = m[1];
  return [...c].every((ch) => CODE_ABC.includes(ch)) ? c : null;
}
