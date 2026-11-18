/**
 * Turbo cash (maker 2026-11-18): the player's trading balance on Turbo's venue, kept apart from Cash (USDG) in the Cash
 * popup and the Hangar stats, and added into the one combined top-bar cash pill.
 *  - Lighter: the collateral on the player's own Lighter account (GET /api/lighter). Read only where Lighter trading runs
 *    (lighterWanted: the `?lighter=1` switch, never the iPhone app), so other browsers never call Lighter.
 *  - Nova: the real fuel Turbo published (lib/turbo/cashFuel). Practice fuel never counts.
 * One shared read for every subscriber (top bar, Cash, Hangar), refreshed every 60 s while anything listens and on
 * refreshTurboCash() (after a move into Turbo).
 */
import { lighterFetcher, lighterWanted } from "@/lib/lighter/duel";
import { onCashFuel, type CashFuel } from "./cashFuel";

export type TurboCash = {
  /** Lighter + Nova, in dollars */
  usd: number;
  /** this browser can move cash into Turbo (Lighter is on here and on the server) */
  canAdd: boolean;
  /** Turbo cash can go back to Cash (a venue whose withdrawals pay USDG on our chain, set-up finished) */
  canWithdraw: boolean;
  /** Lighter set-up step, once read ("deposit" = no Lighter account yet) */
  lighterStep: string | null;
  /** Nova fuel and its move-back, when Turbo published one */
  fuel: CashFuel;
};

const subs = new Set<(t: TurboCash) => void>();
let wallet: string | null = null;
type L = { usd: number; step: string | null; on: boolean; out?: boolean };
let lighter: L = { usd: 0, step: null, on: false };
let fuel: CashFuel = null;
let timer: ReturnType<typeof setInterval> | null = null;
let offFuel: (() => void) | null = null;
let serverOff = false;
let dev = false;

function snap(): TurboCash {
  return { usd: lighter.usd + (fuel?.usd ?? 0), canAdd: lighter.on, canWithdraw: !!lighter.out && lighter.step === "ready", lighterStep: lighter.step, fuel };
}
const emit = () => { const s = snap(); subs.forEach((cb) => cb(s)); };

/** Re-reads the Lighter balance now (no-op where Lighter doesn't run). */
export async function refreshTurboCash(): Promise<void> {
  const w = wallet;
  if (dev) return;
  if (!w || serverOff || !lighterWanted()) { if (lighter.on || lighter.usd) { lighter = { usd: 0, step: null, on: false }; emit(); } return; }
  try {
    const r = await lighterFetcher(w)("/api/lighter");
    if (r.status === 404) { serverOff = true; lighter = { usd: 0, step: null, on: false }; emit(); return; }
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; step?: string; collateral?: string; withdraw?: boolean };
    if (w !== wallet || !r.ok || !j.ok) return;
    const usd = Number(j.collateral ?? 0);
    lighter = { usd: Number.isFinite(usd) && usd > 0 ? usd : 0, step: j.step ?? null, on: true, out: !!j.withdraw };
    emit();
  } catch { /* keep the last read */ }
}

/** Points the shared read at this wallet (null = signed out). */
export function setTurboWallet(w: string | null): void {
  const next = w?.toLowerCase() ?? null;
  if (next === wallet) return;
  wallet = next;
  if (dev) return;
  lighter = { usd: 0, step: null, on: false };
  emit();
  void refreshTurboCash();
}

export function onTurboCash(cb: (t: TurboCash) => void): () => void {
  subs.add(cb);
  if (!offFuel) offFuel = onCashFuel((f) => { fuel = f; emit(); });
  if (!timer && typeof window !== "undefined") timer = setInterval(() => { void refreshTurboCash(); }, 60_000);
  cb(snap());
  return () => {
    subs.delete(cb);
    if (!subs.size) { if (timer) clearInterval(timer); timer = null; offFuel?.(); offFuel = null; }
  };
}

export function turboCash(): TurboCash { return snap(); }
/** dev screenshots only (window.__turboCashDev): Cash shows sample To Cash numbers instead of calling Lighter */
export const turboCashDev = () => dev;

// dev only (screenshots): window.__turboCashDev(250) shows a Turbo cash balance and the To Turbo tab
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as unknown as { __turboCashDev?: (usd: number) => void }).__turboCashDev = (usd) => { dev = true; lighter = { usd, step: "ready", on: true, out: true }; emit(); };
}
