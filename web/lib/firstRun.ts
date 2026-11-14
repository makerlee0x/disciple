/**
 * First run on phones (maker, 2026-11-14): the steps a brand-new player walks, kept in one small record in localStorage.
 *   1. pick a rocket (lobby coach line until the first flight opens)
 *   2. add cash (signed in with $0: the Cash popup's card checkout, or Free play while it lands)
 *   3. the throttle intro on the first flight (BOOST = BUY, DUMP = SELL, STEER)
 *   4. the first boost moment
 *   then, after a good first flight, the Add to Home Screen prompt (iPhones only send push alerts to a home-screen app).
 * Pure helpers here are tested (scripts/test-first-run.mts); components/mobile/* read and write through load/save.
 */
export type FirstRun = {
  /** a flight screen has opened at least once */
  flown: boolean;
  /** the throttle intro was closed */
  intro: boolean;
  /** live boosts that filled */
  boosts: number;
  /** when the Add to Home Screen prompt was last shown or dismissed (ms), 0 = never */
  installAt: number;
  /** times the install prompt was dismissed */
  installNo: number;
};
export const FIRST_RUN_KEY = "disciple.firstrun.v1";
export const EMPTY_RUN: FirstRun = { flown: false, intro: false, boosts: 0, installAt: 0, installNo: 0 };
/** CustomEvent<FirstRun>: the record changed (same tab). */
export const FIRST_RUN_EVENT = "disciple:firstrun";

export function sanitizeRun(x: unknown): FirstRun {
  const o = (x && typeof x === "object" ? x : {}) as Partial<FirstRun>;
  const n = (v: unknown) => (Number.isFinite(+(v as number)) && +(v as number) > 0 ? Math.floor(+(v as number)) : 0);
  return { flown: o.flown === true, intro: o.intro === true, boosts: n(o.boosts), installAt: n(o.installAt), installNo: n(o.installNo) };
}
export function loadRun(): FirstRun {
  try { return sanitizeRun(JSON.parse(localStorage.getItem(FIRST_RUN_KEY) || "null")); } catch { return EMPTY_RUN; }
}
export function saveRun(patch: Partial<FirstRun>): FirstRun {
  const next = sanitizeRun({ ...loadRun(), ...patch });
  try { localStorage.setItem(FIRST_RUN_KEY, JSON.stringify(next)); } catch { /* private mode: the steps just show again */ }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<FirstRun>(FIRST_RUN_EVENT, { detail: next }));
  return next;
}

const DAY = 86_400_000;
/** After a "Not now": ask again in 3 days, then in 14, and after the third "Not now" never again. */
export const INSTALL_BACKOFF_MS = [3 * DAY, 14 * DAY] as const;

/**
 * Show the Add to Home Screen prompt? Only on a phone browser that isn't already a home-screen app or an app's own
 * browser, after the first real boost, and not again too soon after a "Not now".
 */
export function shouldOfferInstall(r: FirstRun, env: { phone: boolean; standalone: boolean; inApp: boolean; now: number }): boolean {
  if (!env.phone || env.standalone || env.inApp) return false;
  if (r.boosts < 1) return false;
  if (r.installNo >= INSTALL_BACKOFF_MS.length + 1) return false;
  if (!r.installAt) return true;
  // shown but never answered counts like one "Not now"
  const wait = INSTALL_BACKOFF_MS[Math.min(Math.max(r.installNo, 1), INSTALL_BACKOFF_MS.length) - 1];
  return env.now - r.installAt >= wait;
}

/** The lobby's "pick a rocket" line shows until the first flight opens. */
export const showPickCoach = (r: FirstRun, phone: boolean) => phone && !r.flown;
/** The throttle intro shows on the first flight (and again only if it was never closed). */
export const showFlightIntro = (r: FirstRun) => !r.intro;
