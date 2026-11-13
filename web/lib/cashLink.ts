/**
 * Cash links (round 2 "Cash" board, maker 2026-11-13): Cash is a popup (components/cash/CashHost), opened from the
 * top-bar cash chip, Add cash in the Hangar, and any other cash link. /wallet still works for old links and shows the
 * same body on its own page. Old "/profile#cash" links land there too (ProfileDashboard sends #cash to /wallet).
 */
export const DEPOSIT_HREF = "/wallet";
/** CustomEvent<{ tab?: CashTab } | null>: open the Cash popup (or switch tab in place on /wallet). */
export const OPEN_CASH_EVENT = "disciple:opencash";
export type CashTab = "add" | "out";
/** Hash that opens Settings on the private profile. */
export const SETTINGS_HASHES = ["#settings"] as const;
/** Legacy hash (old Deposit links): /profile#cash forwards to DEPOSIT_HREF. */
export const LEGACY_CASH_HASH = "#cash";

/** Open the Cash popup on a tab (no navigation). */
export function openCash(tab: CashTab = "add") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_CASH_EVENT, { detail: { tab } }));
}

/** onClick for any cash link: opens the Cash popup in place (modifier clicks still open /wallet in a new tab). */
export function onDepositClick(e: { preventDefault(): void; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; button?: number }) {
  if (typeof window === "undefined" || e.metaKey || e.ctrlKey || e.shiftKey || (e.button ?? 0) !== 0) return;
  e.preventDefault();
  openCash("add");
}

/** The account menu's "Settings" link (SITE, Oct 30): opens the Settings popup; on /profile, in place (no reload). */
export const SETTINGS_HREF = "/profile#settings";
export const OPEN_SETTINGS_EVENT = "disciple:opensettings";
export function onSettingsClick(e: { preventDefault(): void }) {
  if (typeof window === "undefined" || window.location.pathname !== "/profile") return;
  e.preventDefault();
  if (window.location.hash !== "#settings") window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#settings`);
  window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT));
}
